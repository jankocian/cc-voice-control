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
import { aad, deriveKey, type EncBlob, openJson, sealJson } from "../shared/e2e.js";
import { cmuxAnswerQuestion, cmuxSubmit } from "./cmux.js";
import { synthesizeSpeech, transcribeAudio } from "./openai.js";
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
  cmuxAnswerQuestion: vi.fn(async () => "sent"),
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
// A user tool_result that ANSWERS a question (its tool_use_id matches the AskUserQuestion tool_use id) — what
// flushes to the transcript when the user picks an option, flipping the projected question to `answered`.
const questionAnswerRec = (uuid: string, ts: string, toolUseId: string) =>
  rec({
    type: "user",
    uuid,
    timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] }
  });
// A bulky tool result (not a conversational turn — dropped by the projection) used to overflow the tail.
const fillerRec = (uuid: string, bytes: number) =>
  rec({
    type: "user",
    uuid,
    timestamp: "2026-06-22T13:52:00.000Z",
    message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(bytes) }] }
  });
// An interactive AskUserQuestion turn (assistant record whose content is the tool_use). `opts.multiSelect`
// makes it a question that can't be voice-answered (must be answered in the terminal).
const questionRec = (uuid: string, ts: string, opts: { multiSelect?: boolean } = {}) =>
  rec({
    type: "assistant",
    uuid,
    timestamp: ts,
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "q1",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Which?",
                header: "H",
                multiSelect: opts.multiSelect === true,
                options: [{ label: "A" }, { label: "B" }]
              }
            ]
          }
        }
      ]
    }
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
  let sendToDaemon: ((event: unknown) => Promise<void>) | undefined;
  // The E2E key both ends derive from the session secret ("sek"); the test seals commands to the daemon and
  // opens the daemon's sealed replies exactly as the phone would (the worker only ever sees opaque blobs).
  let key: CryptoKey;

  beforeEach(async () => {
    prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
    dataDir = mkdtempSync(join(tmpdir(), "voice-reply-test-"));
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    vi.mocked(synthesizeSpeech).mockClear();
    // Reset transcribeAudio to its default so a prior test's queued mockResolvedValueOnce (e.g. the glued-
    // prompt case) can't leak its transcript into the next test's submit_audio.
    vi.mocked(transcribeAudio).mockReset().mockResolvedValue("unused");
    key = await deriveKey("sek");

    daemonOut = [];
    sendToDaemon = undefined; // reset so each test waits for ITS daemon's socket, not the prior one's
    bridge = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => bridge.once("listening", r));
    bridgePort = (bridge.address() as { port: number }).port;
    bridge.on("connection", (sock) => {
      sendToDaemon = async (event) =>
        sock.send(
          JSON.stringify({
            channel: "daemon",
            threadId: "SURF",
            enc: await sealJson(key, event, aad("daemon", "SURF"))
          })
        );
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
  async function startDaemon(): Promise<{ daemon: VoiceDaemon; port: number }> {
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
      daemonKey: "dk",
      sessionId: "sid",
      browserUrl: "https://voice.example.com/s/sek"
    });
    await daemon.start();
    for (let i = 0; i < 50 && !sendToDaemon; i++) await sleep(20); // wait for the bridge socket
    expect(sendToDaemon).toBeDefined();
    const port = JSON.parse(readFileSync(join(dataDir, "runtime", "SURF.json"), "utf8")).port as number;
    return { daemon, port };
  }

  async function driveUpToClose(transcript: string): Promise<{ daemon: VoiceDaemon; port: number }> {
    const { daemon, port } = await startDaemon();

    // Phone asks for a status → the daemon enqueues + "injects" the canned prompt (a tracked voice turn).
    await sendToDaemon?.({ type: "status_request" });
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
      // The daemon→browser payload is sealed; open each browser-channel envelope to find the tts_audio.
      for (const env of daemonOut as { channel?: string; threadId?: string; enc?: EncBlob }[]) {
        if (env.channel !== "browser" || !env.enc) continue;
        const event = await openJson<{ type?: string; requestId?: string }>(
          key,
          env.enc,
          aad("browser", env.threadId ?? "SURF")
        );
        if (event.type === "tts_audio") return event.requestId;
      }
      await sleep(50);
    }
    return undefined;
  }

  // Poll for a prompt_status envelope (text + state) — used to assert the mic-spinner-clearing "accepted" an
  // answer sends, and the "queued" a fallen-through answer (picker gone) sends as a normal prompt.
  async function waitForPromptStatus(text: string, state: string): Promise<boolean> {
    for (let i = 0; i < 40; i++) {
      for (const env of daemonOut as { channel?: string; threadId?: string; enc?: EncBlob }[]) {
        if (env.channel !== "browser" || !env.enc) continue;
        const event = await openJson<{ type?: string; text?: string; state?: string }>(
          key,
          env.enc,
          aad("browser", env.threadId ?? "SURF")
        );
        if (event.type === "prompt_status" && event.text === text && event.state === state) return true;
      }
      await sleep(50);
    }
    return false;
  }

  // Poll for a `history` event that contains a question turn — to prove the question reaches the phone.
  async function waitForHistoryQuestion(): Promise<boolean> {
    for (let i = 0; i < 80; i++) {
      for (const env of daemonOut as { channel?: string; threadId?: string; enc?: EncBlob }[]) {
        if (env.channel !== "browser" || !env.enc) continue;
        const event = await openJson<{ type?: string; turns?: { question?: unknown }[] }>(
          key,
          env.enc,
          aad("browser", env.threadId ?? "SURF")
        );
        if (event.type === "history" && event.turns?.some((t) => t.question)) return true;
      }
      await sleep(50);
    }
    return false;
  }

  it("surfaces an interactive question LIVE via the live watch, with NO further hook (picker blocks the pane)", async () => {
    const transcript = join(dataDir, "transcript.jsonl");
    writeFileSync(transcript, "");
    const { daemon } = await driveUpToClose(transcript); // turn-open + steps → watch armed, isBusy true

    // The AskUserQuestion record lands. The picker now BLOCKS the pane, so no turn-progress/close hook fires
    // and no further bytes are written — only the live watch on this write can push it. It MUST.
    appendFileSync(transcript, questionRec("Q", "2026-06-22T13:54:00.000Z"));
    expect(await waitForHistoryQuestion()).toBe(true);

    daemon.stop();
  }, 20000);

  // Root cause of "the question never showed until I tapped Stop" #1: a fresh session/new instance. Hooks fire
  // BEFORE the first record flushes, so the transcript file does not exist yet at /turn-open → fs.watch throws
  // ENOENT. The watch must keep retrying and arm itself once the file appears, then deliver a later write with
  // no further hook. (Pre-fix this only worked because an always-on poll masked it.)
  it("arms the live tail when the transcript doesn't exist yet at turn-open, then delivers with NO further hook", async () => {
    const transcript = join(dataDir, "not-created-yet.jsonl"); // intentionally NOT created before turn-open
    const { daemon, port } = await startDaemon();
    await post(port, "/turn-open", { transcriptPath: transcript, prompt: CANNED, permissionMode: "default" });
    await sleep(120); // the watch arm threw ENOENT and is now retrying

    // Claude creates the transcript and the question lands — the picker blocks the pane, so NO further hook fires.
    writeFileSync(transcript, userRec("U", "2026-06-22T13:50:35.594Z", CANNED));
    appendFileSync(transcript, questionRec("Q", "2026-06-22T13:54:00.000Z"));
    expect(await waitForHistoryQuestion()).toBe(true);

    daemon.stop();
  }, 20000);

  // Root cause #2: /clear or /compact rewrites the transcript at the SAME path → the inode-bound watcher dies
  // and the old `path === watchedPath` guard never re-armed it. The watch must re-arm on the 'rename' and
  // deliver a write to the NEW inode with no further hook.
  it("re-arms the live tail when the transcript is replaced at the same path, delivering with NO further hook", async () => {
    const transcript = join(dataDir, "transcript.jsonl");
    writeFileSync(transcript, "");
    const { daemon } = await driveUpToClose(transcript); // watch armed on the original inode

    rmSync(transcript); // /clear|/compact: same path, new file → the original watcher is now dead
    writeFileSync(transcript, userRec("U2", "2026-06-22T14:00:00.000Z", CANNED));
    await sleep(120);
    appendFileSync(transcript, questionRec("Q2", "2026-06-22T14:00:05.000Z"));
    expect(await waitForHistoryQuestion()).toBe(true);

    daemon.stop();
  }, 20000);

  // The HEADLINE fix: Claude does NOT write the AskUserQuestion record to the transcript until it's answered
  // (verified live), so the projection alone can NEVER show a pending question — there's nothing to read. The
  // PreToolUse hook carries it, so the daemon surfaces it live from the hook payload, then yields to the
  // transcript (without double-showing or re-speaking) once the answer flushes it there.
  it("surfaces a PENDING AskUserQuestion LIVE from the PreToolUse hook (absent from the transcript), then yields on answer", async () => {
    const transcript = join(dataDir, "transcript.jsonl");
    writeFileSync(transcript, userRec("U", "2026-06-22T13:50:35.594Z", CANNED));
    const { daemon, port } = await startDaemon();
    await post(port, "/turn-open", { transcriptPath: transcript, prompt: CANNED, permissionMode: "default" });
    await sleep(80);

    // PreToolUse fires the instant the picker opens, with the question in its payload. The transcript does NOT
    // contain the question (Claude flushes it only on answer) — same content as questionRec ("Which?", A/B).
    const questions = [
      { question: "Which?", header: "H", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }
    ];
    await post(port, "/turn-progress", { transcriptPath: transcript, question: { toolUseId: "q1", questions } });

    // It MUST reach the phone live as a pending question, read aloud once — though it's nowhere in the file.
    expect(await waitForHistoryQuestion()).toBe(true);
    await sleep(60);
    const spokeQuestion = () => vi.mocked(synthesizeSpeech).mock.calls.filter((c) => c[1].includes("Which?")).length;
    expect(spokeQuestion()).toBe(1);

    // Claude answers → the record (same content) finally flushes to the transcript, now answered. The overlay
    // must yield (one card, not two) and the answered question must NOT be read aloud again.
    appendFileSync(transcript, questionRec("Q", "2026-06-22T13:54:00.000Z"));
    appendFileSync(transcript, questionAnswerRec("AR", "2026-06-22T13:54:05.000Z", "q1"));
    await post(port, "/turn-progress", { transcriptPath: transcript });
    await sleep(250);
    expect(spokeQuestion()).toBe(1); // still once — the answered flush is never re-spoken

    daemon.stop();
  }, 20000);

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
      daemonKey: "dk",
      sessionId: "sid",
      browserUrl: "https://voice.example.com/s/sek"
    });
    await daemon.start();
    for (let i = 0; i < 50 && !sendToDaemon; i++) await sleep(20);
    const port = JSON.parse(readFileSync(join(dataDir, "runtime", "SURF.json"), "utf8")).port as number;

    await sendToDaemon?.({ type: "status_request" });
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

  it("speaks the reply ONCE for a merged/glued prompt (the 18s-apart incident), projecting only the survivor", async () => {
    // Two utterances spoken in quick succession; Claude Code MERGES them: the transcript holds an orphan
    // "A" record and the consumed, glued "A.B" record (same parent), and Claude answers only A.B. Two
    // UserPromptSubmit fire but one Stop. The active-branch projection drops the orphan; the voice entry
    // re-binds from the orphan to the survivor; the reply is synthesized exactly once.
    const transcript = join(dataDir, "transcript.jsonl");
    const parented = (uuid: string, ts: string, text: string, parentUuid: string) =>
      `${JSON.stringify({ type: "user", uuid, parentUuid, timestamp: ts, promptSource: "typed", message: { role: "user", content: text } })}\n`;
    const reply = (uuid: string, ts: string, text: string, parentUuid: string) =>
      `${JSON.stringify({ type: "assistant", uuid, parentUuid, timestamp: ts, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } })}\n`;

    // A prior reply: the daemon reads the file once (turn-progress) → records the floor before our prompts.
    writeFileSync(transcript, reply("P", "2026-06-22T23:01:00.000Z", "ready", "ROOT"));

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
      daemonKey: "dk",
      sessionId: "sid",
      browserUrl: "https://voice.example.com/s/sek"
    });
    await daemon.start();
    for (let i = 0; i < 50 && !sendToDaemon; i++) await sleep(20);
    const port = JSON.parse(readFileSync(join(dataDir, "runtime", "SURF.json"), "utf8")).port as number;
    await post(port, "/turn-progress", { transcriptPath: transcript }); // floor anchor at end of "ready"

    // Both utterances are transcribed + tracked (the daemon injects the first, queues the second).
    vi.mocked(transcribeAudio).mockResolvedValueOnce("первая фраза").mockResolvedValueOnce("Mluvím česky");
    await sendToDaemon?.({ type: "submit_audio", audioBase64: "AAA", mimeType: "audio/webm", mode: "queue" });
    await sleep(120);
    await sendToDaemon?.({ type: "submit_audio", audioBase64: "AAA", mimeType: "audio/webm", mode: "queue" });
    await sleep(120);

    // The merge: orphan "A", then the glued "A.B" (same parent P), then the answer under A.B.
    appendFileSync(transcript, parented("A", "2026-06-22T23:03:57.000Z", "первая фраза", "P"));
    await post(port, "/turn-open", { transcriptPath: transcript, prompt: "первая фраза", permissionMode: "default" });
    appendFileSync(transcript, parented("AB", "2026-06-22T23:04:15.000Z", "первая фраза Mluvím česky", "P"));
    await post(port, "/turn-open", {
      transcriptPath: transcript,
      prompt: "первая фраза Mluvím česky",
      permissionMode: "default"
    });
    appendFileSync(transcript, reply("R", "2026-06-22T23:04:33.000Z", "Smazáno.", "AB"));
    await post(port, "/turn-close", { transcriptPath: transcript });

    const spoken = await waitForSpeak();
    expect(spoken).toEqual(["Smazáno."]); // exactly once — never the orphan, never twice
    expect(await waitForTtsRequestId()).toBe("R"); // keyed to the surviving turn's reply

    daemon.stop();
  }, 20000);

  it("emits prompt_status queued→accepted so the phone shows the message before the reply lands", async () => {
    // Regression: a sent message must appear on the phone the instant Claude takes it, not only with the
    // answer. queueVoice echoes "queued" (we just transcribed it); UserPromptSubmit echoes "accepted".
    const transcript = join(dataDir, "transcript.jsonl");
    writeFileSync(transcript, "");
    const { daemon } = await driveUpToClose(transcript);

    const statuses: { text?: string; state?: string }[] = [];
    for (const env of daemonOut as { channel?: string; threadId?: string; enc?: EncBlob }[]) {
      if (env.channel !== "browser" || !env.enc) continue;
      const event = await openJson<{ type?: string; text?: string; state?: string }>(
        key,
        env.enc,
        aad("browser", env.threadId ?? "SURF")
      );
      if (event.type === "prompt_status") statuses.push({ text: event.text, state: event.state });
    }
    expect(statuses).toContainEqual({ text: CANNED, state: "queued" }); // shown right after transcription
    expect(statuses).toContainEqual({ text: CANNED, state: "accepted" }); // shown on UserPromptSubmit

    daemon.stop();
  }, 20000);

  it("reads an interactive question aloud and routes a spoken answer into the picker (not a new prompt)", async () => {
    const transcript = join(dataDir, "transcript.jsonl");
    writeFileSync(transcript, "");
    const { daemon, port } = await driveUpToClose(transcript);

    // Claude asks an interactive question → it's synthesized at once (a question is read like a final reply).
    appendFileSync(transcript, questionRec("Q", "2026-06-22T13:54:00.000Z"));
    await post(port, "/turn-progress", { transcriptPath: transcript });
    const spoken = await waitForSpeak();
    expect(spoken.some((t) => t.includes("Which?"))).toBe(true);

    // The user speaks while the question is pending → the transcript goes into the picker's custom answer,
    // NOT the inject queue (cmuxAnswerQuestion, never cmuxSubmit).
    vi.mocked(cmuxAnswerQuestion).mockClear();
    vi.mocked(cmuxSubmit).mockClear();
    await sendToDaemon?.({
      type: "submit_audio",
      requestId: "r",
      audioBase64: "QUFB",
      mimeType: "audio/webm",
      mode: "queue"
    });
    for (let i = 0; i < 60 && vi.mocked(cmuxAnswerQuestion).mock.calls.length === 0; i++) await sleep(50);
    expect(vi.mocked(cmuxAnswerQuestion)).toHaveBeenCalledWith("unused", "SURF"); // transcribeAudio mock → "unused"
    expect(vi.mocked(cmuxSubmit)).not.toHaveBeenCalled();
    // The answer lands as a tool_result (no user row), so the mic spinner is cleared by an accepted
    // prompt_status carrying the answer text — else the mic stays locked.
    expect(await waitForPromptStatus("unused", "accepted")).toBe(true);

    daemon.stop();
  }, 20000);

  it("treats the answer as a normal prompt when the picker is already gone (no-picker → queue, never dropped)", async () => {
    const transcript = join(dataDir, "transcript.jsonl");
    writeFileSync(transcript, "");
    const { daemon, port } = await driveUpToClose(transcript);

    // The transcript still shows an unanswered question, but the picker has already been dismissed.
    appendFileSync(transcript, questionRec("Q", "2026-06-22T13:54:00.000Z"));
    await post(port, "/turn-progress", { transcriptPath: transcript });
    await sleep(150);

    vi.mocked(cmuxAnswerQuestion).mockResolvedValueOnce("no-picker");
    await sendToDaemon?.({
      type: "submit_audio",
      requestId: "r",
      audioBase64: "QUFB",
      mimeType: "audio/webm",
      mode: "queue"
    });
    // Falls through to a normal prompt (queueVoice emits a "queued" prompt_status) — the words aren't lost.
    expect(await waitForPromptStatus("unused", "queued")).toBe(true);

    daemon.stop();
  }, 20000);

  it("routes a multi-select question to the terminal instead of mis-answering it via the picker", async () => {
    const transcript = join(dataDir, "transcript.jsonl");
    writeFileSync(transcript, "");
    const { daemon, port } = await driveUpToClose(transcript);

    // A multi-SELECT question: one free-text custom answer can't express multiple picks → answer in terminal.
    appendFileSync(transcript, questionRec("MQ", "2026-06-22T13:54:00.000Z", { multiSelect: true }));
    await post(port, "/turn-progress", { transcriptPath: transcript });
    await sleep(200);

    vi.mocked(cmuxAnswerQuestion).mockClear();
    await sendToDaemon?.({
      type: "submit_audio",
      requestId: "r",
      audioBase64: "QUFB",
      mimeType: "audio/webm",
      mode: "queue"
    });
    await sleep(400);
    expect(vi.mocked(cmuxAnswerQuestion)).not.toHaveBeenCalled(); // never routed to the picker

    daemon.stop();
  }, 20000);
});
