import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveRoutingId,
  loadOrCreateSession,
  resolveConfig,
  threadRuntimePath,
  toBrowserUrl,
  toWebSocketUrl
} from "./config.js";

describe("voice remote URL helpers", () => {
  it("puts the secret in the fragment of the browser URL (never the path the worker sees)", () => {
    expect(toBrowserUrl("https://voice.example.com/base", "secret")).toBe("https://voice.example.com/s#secret");
  });

  it("creates daemon websocket URLs routed by routingId from https bridge URLs", () => {
    expect(toWebSocketUrl("https://voice.example.com", "rid", "daemon")).toBe(
      "wss://voice.example.com/ws/rid?role=daemon"
    );
  });

  it("creates local websocket URLs from http bridge URLs", () => {
    expect(toWebSocketUrl("http://localhost:8787", "rid", "browser")).toBe("ws://localhost:8787/ws/rid?role=browser");
  });
});

describe("deriveRoutingId", () => {
  it("is sha256(secret) as lowercase hex — must match the browser's WebCrypto derivation", () => {
    // sha256("secret") — pinned so a divergence from the web client's derivation is caught here.
    expect(deriveRoutingId("secret")).toBe("2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b");
    expect(deriveRoutingId("secret")).toMatch(/^[0-9a-f]{64}$/);
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
