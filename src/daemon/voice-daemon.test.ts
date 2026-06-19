import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectMissedReply, VoiceDaemon } from "./voice-daemon.js";

const BROWSER_URL = "https://voice.example.com/s/sid?token=tok";

describe("VoiceDaemon.ensureRuntimePublished", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
    dataDir = mkdtempSync(join(tmpdir(), "voice-control-test-"));
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function daemon() {
    return new VoiceDaemon({
      config: {
        openaiApiKey: "k",
        openaiVoice: "marin",
        ttsModel: "gpt-4o-mini-tts",
        sttModel: "gpt-4o-mini-transcribe",
        bridgeUrl: "https://voice.example.com"
      },
      surface: "SURF",
      sessionId: "sid",
      token: "tok",
      browserUrl: BROWSER_URL
    });
  }

  it("writes runtime.json with the phone URL when it is missing", () => {
    const runtime = join(dataDir, "runtime.json");
    expect(existsSync(runtime)).toBe(false);

    daemon().ensureRuntimePublished();

    expect(existsSync(runtime)).toBe(true);
    const parsed = JSON.parse(readFileSync(runtime, "utf8"));
    expect(parsed.sessionUrl).toBe(BROWSER_URL);
    expect(parsed.surface).toBe("SURF");
  });

  // The exact recovery the bug needed: the start skill deletes runtime.json while
  // the daemon keeps running; the next reconcile tick must bring it back.
  it("re-creates runtime.json after it is deleted out from under a running daemon", () => {
    const runtime = join(dataDir, "runtime.json");
    const d = daemon();

    d.ensureRuntimePublished();
    rmSync(runtime);
    expect(existsSync(runtime)).toBe(false);

    d.ensureRuntimePublished();
    expect(existsSync(runtime)).toBe(true);
  });
});

describe("selectMissedReply", () => {
  const audio = { audioBase64: "AAAA", mimeType: "audio/mpeg" };

  it("replays nothing when there is no reply yet", () => {
    expect(selectMissedReply(undefined, undefined)).toEqual([]);
  });

  it("replays nothing when the phone already has the latest reply", () => {
    expect(selectMissedReply({ requestId: "r1", text: "hi", audio }, "r1")).toEqual([]);
  });

  it("replays text and audio when the phone missed the latest reply", () => {
    expect(selectMissedReply({ requestId: "r2", text: "hi", audio }, "r1")).toEqual([
      { type: "claude_reply", requestId: "r2", text: "hi" },
      { type: "tts_audio", requestId: "r2", replay: true, ...audio }
    ]);
  });

  it("replays a fresh phone (no last-seen id) and omits audio when none was synthesized", () => {
    expect(selectMissedReply({ requestId: "r3", text: "hi" }, undefined)).toEqual([
      { type: "claude_reply", requestId: "r3", text: "hi" }
    ]);
  });
});
