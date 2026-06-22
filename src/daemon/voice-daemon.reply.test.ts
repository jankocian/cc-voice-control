// Integration test for the voice-reply seam that broke in the wild (transcript d6644242): a voice turn
// whose ANSWER TEXT flushes to the transcript seconds after the Stop hook fires (extended thinking writes
// the thinking block as its own end_turn record first), with interim STEPS already present. The bug spoke
// an interim step and consumed the turn, so the real answer was never spoken (no audio) and only reached
// the phone on refresh. This drives the daemon through its REAL HTTP hooks + a real ws bridge and asserts
// the FINAL answer is the thing synthesized — never a step — even when it lands mid-settle.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { synthesizeSpeech } from "./openai.js";
import { TAIL_BYTES } from "./transcript-reader.js";
import { VoiceDaemon } from "./voice-daemon.js";

// Stub OpenAI so no network/key is needed; record exactly which text gets synthesized.
vi.mock("./openai.js", () => ({
  synthesizeSpeech: vi.fn(async (_config: unknown, text: string) => ({
    audioBase64: "QUFB",
    mimeType: "audio/mpeg",
    text
  })),
  transcribeAudio: vi.fn(async () => "unused")
}));

// Stub cmux so injection "succeeds" (CMUX_BIN is read at module load, too late to set per-test) and the
// pane reads healthy — we're testing reply resolution, not the cmux send.
vi.mock("./cmux.js", () => ({
  cmuxSubmit: vi.fn(async () => true),
  cmuxInterrupt: vi.fn(async () => true),
  cmuxHealth: vi.fn(async () => ({ socketUp: true, surfaceAlive: true })),
  cmuxSurfaceTitle: vi.fn(async () => undefined), // labels.ts imports this from the same module
  spawnWorkspace: vi.fn(async () => "surface:1")
}));

const CANNED = "Give me a brief spoken status of what you're doing right now."; // status_request's injected prompt
const ANSWER = "## What's happening\n\nI traced it through the code.";
const STEP_1 = "I'll research this properly.";
const STEP_2 = "Let me read the actual recorder code.";

const rec = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const userRec = (uuid: string, ts: string, text: string) =>
  rec({ type: "user", uuid, timestamp: ts, promptSource: "typed", message: { role: "user", content: text } });
const stepRec = (uuid: string, ts: string, text: string) =>
  rec({
    type: "assistant",
    uuid,
    timestamp: ts,
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        { type: "text", text },
        { type: "tool_use", id: "t", name: "Read", input: {} }
      ]
    }
  });
const answerRec = (uuid: string, ts: string, text: string) =>
  rec({
    type: "assistant",
    uuid,
    timestamp: ts,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] }
  });
// A bulky tool result (not a conversational turn — dropped by the projection) used to overflow the tail.
const fillerRec = (uuid: string, bytes: number) =>
  rec({
    type: "user",
    uuid,
    timestamp: "2026-06-22T13:52:00.000Z",
    message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(bytes) }] }
  });

function post(port: number, route: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length }
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("voice reply is spoken when the answer flushes late (extended-thinking gap)", () => {
  let dataDir: string;
  let prevDataDir: string | undefined;
  let bridge: WebSocketServer;
  let bridgePort: number;
  let daemonOut: unknown[]; // envelopes the daemon SENDS to the bridge
  let sendToDaemon: ((event: unknown) => void) | undefined;

  beforeEach(async () => {
    prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
    dataDir = mkdtempSync(join(tmpdir(), "voice-reply-test-"));
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    vi.mocked(synthesizeSpeech).mockClear();

    daemonOut = [];
    sendToDaemon = undefined; // reset so each test waits for ITS daemon's socket, not the prior one's
    bridge = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => bridge.once("listening", r));
    bridgePort = (bridge.address() as { port: number }).port;
    bridge.on("connection", (sock) => {
      sendToDaemon = (event) => sock.send(JSON.stringify({ channel: "daemon", threadId: "SURF", event }));
      sock.on("message", (raw) => {
        try {
          daemonOut.push(JSON.parse(raw.toString()));
        } catch {
          /* ignore */
        }
      });
    });
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
    bridge.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Start a daemon wired to the fake bridge, drive a voice turn up to (but not including) its answer, and
  // return the bits a test needs to finish it. `transcriptAtClose` lets a test control exactly what the
  // transcript tail looks like when the Stop hook fires (e.g. with the prompt scrolled out).
  async function driveUpToClose(transcript: string): Promise<{ daemon: VoiceDaemon; port: number }> {
    const daemon = new VoiceDaemon({
      config: {
        openaiApiKey: "k",
        openaiVoice: "marin",
        ttsModel: "m",
        sttModel: "s",
        bridgeUrl: `http://127.0.0.1:${bridgePort}`
      },
      surface: "SURF",
      threadId: "SURF",
      secret: "sek",
      sessionId: "sid",
      browserUrl: "https://voice.example.com/s/sek"
    });
    await daemon.start();
    for (let i = 0; i < 50 && !sendToDaemon; i++) await sleep(20); // wait for the bridge socket
    expect(sendToDaemon).toBeDefined();
    const port = JSON.parse(readFileSync(join(dataDir, "runtime", "SURF.json"), "utf8")).port as number;

    // Phone asks for a status → the daemon enqueues + "injects" the canned prompt (a tracked voice turn).
    sendToDaemon?.({ type: "status_request" });
    await sleep(150);
    // The turn opens: the prompt is now a real user record → /turn-open records its read floor + binds it.
    writeFileSync(transcript, userRec("U", "2026-06-22T13:50:35.594Z", CANNED));
    await post(port, "/turn-open", { transcriptPath: transcript, prompt: CANNED, permissionMode: "default" });
    await sleep(80);
    // Two interim steps land as Claude works.
    appendFileSync(transcript, stepRec("S1", "2026-06-22T13:51:15.343Z", STEP_1));
    await post(port, "/turn-progress", { transcriptPath: transcript });
    appendFileSync(transcript, stepRec("S2", "2026-06-22T13:53:54.182Z", STEP_2));
    await post(port, "/turn-progress", { transcriptPath: transcript });
    await sleep(50);
    return { daemon, port };
  }

  async function waitForSpeak(): Promise<string[]> {
    for (let i = 0; i < 60 && vi.mocked(synthesizeSpeech).mock.calls.length === 0; i++) await sleep(100);
    return vi.mocked(synthesizeSpeech).mock.calls.map((c) => c[1]);
  }

  // Poll for the tts_audio envelope on the wire: speak() finishes synthesizing (recorded in mock.calls)
  // a tick before it actually sends the audio to the bridge, so a one-shot check can race it.
  async function waitForTtsRequestId(): Promise<string | undefined> {
    for (let i = 0; i < 40; i++) {
      const id = daemonOut
        .map((e) => e as { channel?: string; event?: { type?: string; requestId?: string } })
        .find((e) => e.channel === "browser" && e.event?.type === "tts_audio")?.event?.requestId;
      if (id) return id;
      await sleep(50);
    }
    return undefined;
  }

  it("waits for the FINAL answer (never speaks an interim step) when it flushes after the Stop hook", async () => {
    const transcript = join(dataDir, "transcript.jsonl");
    writeFileSync(transcript, "");
    const { daemon, port } = await driveUpToClose(transcript);

    // The Stop hook fires BEFORE the answer text has flushed (the thinking block went out first).
    await post(port, "/turn-close", { transcriptPath: transcript });
    await sleep(500);
    expect(vi.mocked(synthesizeSpeech)).not.toHaveBeenCalled(); // correctly waiting, not grabbing a step

    // The answer finally flushes — the file write wakes the watch and the answer is spoken.
    appendFileSync(transcript, answerRec("ANSWER", "2026-06-22T13:55:49.298Z", ANSWER));
    const spoken = await waitForSpeak();
    expect(spoken).toContain(ANSWER);
    expect(spoken).not.toContain(STEP_1);
    expect(spoken).not.toContain(STEP_2);
    expect(await waitForTtsRequestId()).toBe("ANSWER"); // keyed to the answer's native uuid → phone plays/caches it

    daemon.stop();
  }, 20000);

  it("resolves the answer when the prompt sits beyond the display tail (huge-turn case)", async () => {
    // A turn that writes more than the display tail between its prompt and its answer. The prompt stays in
    // the FILE, just beyond the tail; the daemon reads from the floor it captured at turn-open, so the
    // prompt is always present for the identity match. (Real shape: a giant thinking block / hour of tools.)
    const transcript = join(dataDir, "transcript.jsonl");
    const daemon = new VoiceDaemon({
      config: {
        openaiApiKey: "k",
        openaiVoice: "marin",
        ttsModel: "m",
        sttModel: "s",
        bridgeUrl: `http://127.0.0.1:${bridgePort}`
      },
      surface: "SURF",
      threadId: "SURF",
      secret: "sek",
      sessionId: "sid",
      browserUrl: "https://voice.example.com/s/sek"
    });
    await daemon.start();
    for (let i = 0; i < 50 && !sendToDaemon; i++) await sleep(20);
    const port = JSON.parse(readFileSync(join(dataDir, "runtime", "SURF.json"), "utf8")).port as number;

    sendToDaemon?.({ type: "status_request" });
    await sleep(150);

    // A prior turn already happened: the daemon has read the transcript once, so it knows where the file
    // ends → that becomes the read floor it captures when our prompt opens.
    writeFileSync(transcript, answerRec("PRIOR", "2026-06-22T13:49:00.000Z", "earlier reply"));
    await post(port, "/turn-progress", { transcriptPath: transcript }); // daemon reads → records lastEof

    // Now our voice prompt opens, then the turn writes more than a tail's worth before answering.
    appendFileSync(transcript, userRec("U", "2026-06-22T13:50:35.594Z", CANNED));
    await post(port, "/turn-open", { transcriptPath: transcript, prompt: CANNED, permissionMode: "default" });
    appendFileSync(transcript, fillerRec("FILL", TAIL_BYTES + 100_000)); // a tool_result bigger than the tail
    appendFileSync(transcript, answerRec("ANSWER", "2026-06-22T13:55:49.298Z", ANSWER));
    await post(port, "/turn-close", { transcriptPath: transcript });

    const spoken = await waitForSpeak();
    expect(spoken).toContain(ANSWER); // resolved via the floor — the tail alone couldn't see U
    expect(await waitForTtsRequestId()).toBe("ANSWER");

    daemon.stop();
  }, 20000);
});
