import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceDaemon } from "./voice-daemon.js";

const BROWSER_URL = "https://voice.example.com/s/sek";

describe("VoiceDaemon runtime publication", () => {
  let dataDir: string;
  let homeDir: string;
  let previousDataDir: string | undefined;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousCmuxBin: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousCmuxBin = process.env.CMUX_BIN;
    dataDir = mkdtempSync(join(tmpdir(), "voice-control-test-"));
    // The per-thread runtime file lives under $HOME (fixed, plugin-data-independent), so isolate it.
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows — set both.
    homeDir = mkdtempSync(join(tmpdir(), "voice-control-home-"));
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    // Point cmux at a harmless binary so the health monitor's spawn never touches a real
    // cmux socket during the test (its result is fire-and-forget; we don't assert on it).
    process.env.CMUX_BIN = "true";
  });

  afterEach(() => {
    restoreEnv("CLAUDE_PLUGIN_DATA", previousDataDir);
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("CMUX_BIN", previousCmuxBin);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
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
      threadId: "SURF",
      secret: "sek",
      sessionId: "sid",
      browserUrl: BROWSER_URL
    });
  }

  it("writes a PER-THREAD runtime file (URL + port) and qr.txt on start(), removing its own on stop()", async () => {
    // The runtime IPC file is keyed by surface id under $HOME (not CLAUDE_PLUGIN_DATA) so the hooks
    // find it even when their plugin-data dir differs from the daemon's. qr.txt stays plugin-data-level.
    const runtime = join(homeDir, ".cache", "cc-voice-control", "runtime", "SURF.json");
    const qr = join(dataDir, "qr.txt");
    expect(existsSync(runtime)).toBe(false);

    const d = daemon();
    await d.start();

    expect(existsSync(runtime)).toBe(true);
    expect(existsSync(qr)).toBe(true);
    const parsed = JSON.parse(readFileSync(runtime, "utf8"));
    expect(parsed.sessionUrl).toBe(BROWSER_URL);
    expect(parsed.surface).toBe("SURF");
    expect(typeof parsed.port).toBe("number");
    expect(parsed.pid).toBe(process.pid);

    // stop() removes ONLY this pane's runtime file (siblings keep theirs). qr.txt is
    // machine-level and deliberately left in place (a sibling pane may still be live).
    d.stop();
    expect(existsSync(runtime)).toBe(false);
    expect(existsSync(qr)).toBe(true);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
