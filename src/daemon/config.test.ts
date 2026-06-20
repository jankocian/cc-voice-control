import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveConfig, toBrowserUrl, toWebSocketUrl } from "./config.js";

describe("voice remote URL helpers", () => {
  it("creates browser session URLs from the single secret", () => {
    expect(toBrowserUrl("https://voice.example.com/base", "secret")).toBe("https://voice.example.com/s/secret");
  });

  it("creates daemon websocket URLs from https bridge URLs", () => {
    expect(toWebSocketUrl("https://voice.example.com", "secret", "daemon")).toBe(
      "wss://voice.example.com/ws/secret?role=daemon"
    );
  });

  it("creates local websocket URLs from http bridge URLs", () => {
    expect(toWebSocketUrl("http://localhost:8787", "secret", "browser")).toBe(
      "ws://localhost:8787/ws/secret?role=browser"
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

  it("throws via loadConfig when the key is missing", async () => {
    const path = writeConfig({ bridgeUrl: "https://example.workers.dev" });
    await expect(loadConfig(path)).rejects.toThrow(/OpenAI API key is required/);
  });
});
