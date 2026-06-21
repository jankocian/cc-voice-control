import { describe, expect, it } from "vitest";
import { buildClaudeSpawnCommand, permissionModeArg } from "./spawn-command.js";

describe("permissionModeArg (a spawn inherits the session's permission mode)", () => {
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

describe("buildClaudeSpawnCommand", () => {
  it("inherits the permission mode and omits --plugin-dir for an installed plugin", () => {
    expect(buildClaudeSpawnCommand({ spawnId: "abc-123", permissionMode: "bypassPermissions" })).toBe(
      "VOICE_SPAWN_ID=abc-123 claude --permission-mode bypassPermissions /voice-control:start"
    );
  });

  it("adds --plugin-dir (dev/-inline load) and falls back to the default mode when none is given", () => {
    expect(buildClaudeSpawnCommand({ spawnId: "id1", pluginDir: "/home/me/plugin" })).toBe(
      "VOICE_SPAWN_ID=id1 claude --plugin-dir '/home/me/plugin' /voice-control:start"
    );
  });

  it("shell-quotes a plugin path with spaces or quotes so it can't break the command", () => {
    expect(buildClaudeSpawnCommand({ spawnId: "id1", pluginDir: "/has space/it's odd" })).toBe(
      "VOICE_SPAWN_ID=id1 claude --plugin-dir '/has space/it'\\''s odd' /voice-control:start"
    );
  });

  it("never interpolates a hostile permission mode", () => {
    expect(buildClaudeSpawnCommand({ spawnId: "id1", permissionMode: "x; rm -rf /" })).toBe(
      "VOICE_SPAWN_ID=id1 claude /voice-control:start"
    );
  });
});
