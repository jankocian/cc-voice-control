import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateSession, resolveConfig, threadRuntimePath, toBrowserUrl, toWebSocketUrl } from "./config.js";

describe("voice remote URL helpers", () => {
  it("puts the sessionId in the path and the secret in the fragment", () => {
    expect(toBrowserUrl("https://voice.example.com/base", "ab12cd34", "secret")).toBe(
      "https://voice.example.com/s/ab12cd34#secret"
    );
  });

  it("creates daemon websocket URLs routed by sessionId from https bridge URLs", () => {
    expect(toWebSocketUrl("https://voice.example.com", "ab12cd34", "daemon")).toBe(
      "wss://voice.example.com/ws/ab12cd34?role=daemon"
    );
  });

  it("creates local websocket URLs from http bridge URLs", () => {
    expect(toWebSocketUrl("http://localhost:8787", "ab12cd34", "browser")).toBe(
      "ws://localhost:8787/ws/ab12cd34?role=browser"
    );
  });
});

describe("resolveConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "voice-control-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(contents: unknown): string {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify(contents));
    chmodSync(path, 0o600);
    return path;
  }

  it("parses a valid config and applies OpenAI defaults", async () => {
    const path = writeConfig({ openaiApiKey: "sk-test" });
    const result = await resolveConfig(path);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.config.openaiApiKey).toBe("sk-test");
    expect(result.config.openaiVoice).toBe("marin");
    expect(result.config.ttsModel).toBe("gpt-4o-mini-tts");
    expect(result.config.sttModel).toBe("gpt-4o-mini-transcribe");
    expect(result.config.bridgeUrl).toBe("https://voice-control.nee.rs");
  });

  // Case (b): a config file exists but has no openaiApiKey → point at THAT file.
  it("returns setup-needed (not a throw) when the config file has no openaiApiKey", async () => {
    const path = writeConfig({ bridgeUrl: "https://example.workers.dev" });
    const result = await resolveConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected setup needed");
    expect(result.needsSetup).toBe(true);
    expect(result.missing).toBe("openaiApiKey");
    expect(result.reason).toBe("missing-key");
    expect(result.configPath).toBe(path);
    expect(result.message).toContain("OpenAI API key is required");
    expect(result.message).toContain(path);
    expect(result.message).toContain("/voice-control:start");
  });

  // Case (c): no config file at all → recommend the path to create.
  it("returns setup-needed with the path to create when no config file exists", async () => {
    const path = join(dir, "does-not-exist.json");
    const result = await resolveConfig(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected setup needed");
    expect(result.reason).toBe("no-config");
    expect(result.configPath).toBe(path);
    expect(result.message).toContain("create");
    expect(result.message).toContain(path);
  });

  it("still throws on bad file permissions (a real error, not setup)", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ openaiApiKey: "sk-test" }));
    chmodSync(path, 0o644);
    await expect(resolveConfig(path)).rejects.toThrow(/permissions/);
  });
});

describe("loadOrCreateSession (one machine secret, shared by every pane)", () => {
  let dir: string;
  const ORIGINAL = process.env.CLAUDE_PLUGIN_DATA;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "voice-control-session-"));
    // The secret lives in stateDir() = $CLAUDE_PLUGIN_DATA; point it at a throwaway dir.
    process.env.CLAUDE_PLUGIN_DATA = dir;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = ORIGINAL;
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints once and returns the SAME secret on every later call (idempotent → one URL/QR)", () => {
    const first = loadOrCreateSession();
    const second = loadOrCreateSession();
    expect(first.secret).toBe(second.secret);
    expect(first.sessionId).toBe(second.sessionId);
    // sessionId is the short, non-secret hash label — distinct from the secret itself.
    expect(first.secret).not.toBe(first.sessionId);
    expect(first.sessionId.length).toBeGreaterThan(0);
    // daemonKey is a second, independent capability secret — stable across calls and not the secret.
    expect(first.daemonKey).toBe(second.daemonKey);
    expect(first.daemonKey.length).toBeGreaterThan(0);
    expect(first.daemonKey).not.toBe(first.secret);
  });

  it("writes session.json with 0600 permissions (it holds the capability secret)", () => {
    loadOrCreateSession();
    const mode = statSync(join(dir, "session.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("persists the minted secret so a second process reads it back rather than re-minting", () => {
    const session = loadOrCreateSession();
    const onDisk = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    expect(onDisk.secret).toBe(session.secret);
    expect(onDisk.daemonKey).toBe(session.daemonKey);
    expect(onDisk.sessionId).toBe(session.sessionId);
    expect(typeof onDisk.createdAt).toBe("number");
  });

  it("overwrites a malformed/old session.json (no daemonKey) and PERSISTS — not a new secret each start", () => {
    // An older build wrote { secret, sessionId, createdAt } with no daemonKey. The file is present but
    // won't parse under the new schema; we must re-mint AND persist, or every start gets a fresh URL.
    const path = join(dir, "session.json");
    writeFileSync(path, JSON.stringify({ secret: "old", sessionId: "old", createdAt: 1 }));
    chmodSync(path, 0o644); // an old file could be world/group-readable; the overwrite must lock it down
    const first = loadOrCreateSession();
    expect(first.daemonKey.length).toBeGreaterThan(0);
    // The overwrite must re-apply 0600 (writeFileSync's mode doesn't take effect when truncating).
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Persisted: a second call reads it back rather than minting a different secret.
    const second = loadOrCreateSession();
    expect(second.secret).toBe(first.secret);
    expect(second.daemonKey).toBe(first.daemonKey);
    expect(JSON.parse(readFileSync(path, "utf8")).daemonKey).toBe(first.daemonKey);
  });
});

describe("threadRuntimePath (per-pane runtime file so panes don't clobber)", () => {
  const ORIGINAL = process.env.CLAUDE_PLUGIN_DATA;
  beforeEach(() => {
    process.env.CLAUDE_PLUGIN_DATA = "/tmp/voice-state";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = ORIGINAL;
  });

  it("keys the runtime file by the pane's surface id under a runtime/ dir", () => {
    expect(threadRuntimePath("surface-abc")).toBe("/tmp/voice-state/runtime/surface-abc.json");
  });

  it("falls back to a stable sentinel name when launched outside cmux (no surface)", () => {
    expect(threadRuntimePath(undefined)).toBe("/tmp/voice-state/runtime/default.json");
  });
});
