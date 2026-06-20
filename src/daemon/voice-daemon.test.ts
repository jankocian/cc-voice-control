import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSlashCommand, permissionModeArg, VoiceDaemon } from "./voice-daemon.js";

describe("isSlashCommand (keep plugin/CLI commands out of the phone's mirrored history)", () => {
  it("flags slash commands so they aren't mirrored", () => {
    expect(isSlashCommand("/voice-control:start")).toBe(true);
    expect(isSlashCommand("  /clear")).toBe(true);
  });

  it("lets real typed messages through", () => {
    expect(isSlashCommand("fix the spawn bug")).toBe(false);
    expect(isSlashCommand("what's the status?")).toBe(false);
  });
});

describe("permissionModeArg (spawn inherits the session's permission mode)", () => {
  it("mirrors a known mode so a spawn matches the parent exactly", () => {
    expect(permissionModeArg("bypassPermissions")).toBe("--permission-mode bypassPermissions ");
    expect(permissionModeArg("plan")).toBe("--permission-mode plan ");
  });

  it("drops a missing or unrecognized mode (falls back to the user's default, never interpolated)", () => {
    expect(permissionModeArg(undefined)).toBe("");
    expect(permissionModeArg("")).toBe("");
    expect(permissionModeArg("haxx; rm -rf /")).toBe("");
  });
});

const BROWSER_URL = "https://voice.example.com/s/sek";

describe("VoiceDaemon runtime publication", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let previousCmuxBin: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
    previousCmuxBin = process.env.CMUX_BIN;
    dataDir = mkdtempSync(join(tmpdir(), "voice-control-test-"));
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    // Point cmux at a harmless binary so the health monitor's spawn never touches a real
    // cmux socket during the test (its result is fire-and-forget; we don't assert on it).
    process.env.CMUX_BIN = "true";
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    if (previousCmuxBin === undefined) delete process.env.CMUX_BIN;
    else process.env.CMUX_BIN = previousCmuxBin;
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
      threadId: "SURF",
      secret: "sek",
      sessionId: "sid",
      browserUrl: BROWSER_URL
    });
  }

  it("writes a PER-THREAD runtime file (URL + port) and qr.txt on start(), removing its own on stop()", async () => {
    // The runtime file is keyed by the pane's surface id so panes don't clobber each other.
    const runtime = join(dataDir, "runtime", "SURF.json");
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
