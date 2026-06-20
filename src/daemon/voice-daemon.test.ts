import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceDaemon } from "./voice-daemon.js";

const BROWSER_URL = "https://voice.example.com/s/sek";

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
      secret: "sek",
      sessionId: "sid",
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
