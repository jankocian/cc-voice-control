// The shell command a spawned cmux workspace runs to join this session as a new thread. cmux runs it
// in a shell, so every interpolated value must be shell-safe. Pure (no daemon state) so the exact
// command shape — which carries the inherited permission mode — is unit-testable.

// Modes Claude Code accepts for `--permission-mode` (same vocabulary it reports as `permission_mode`).
// Allowlisted because the value is interpolated into the command; an unknown one is dropped, not passed.
export const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);

// `--permission-mode <mode> ` (trailing space to concatenate), or "" for a missing/unrecognized mode
// so the spawn falls back to the user's default rather than interpolating a hostile value.
export function permissionModeArg(mode?: string): string {
  return mode && PERMISSION_MODES.has(mode) ? `--permission-mode ${mode} ` : "";
}

// POSIX single-quote: wrap in '…', escape embedded ' as '\'' so an odd path can't break out.
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type SpawnCommandParams = {
  spawnId: string; // uuid the new daemon echoes in its first register so the phone follows THIS thread
  pluginDir?: string; // dev-only `--plugin-dir` root; omitted for an installed (global) plugin
  permissionMode?: string;
};

export function buildClaudeSpawnCommand({ spawnId, pluginDir, permissionMode }: SpawnCommandParams): string {
  const pluginDirArg = pluginDir ? `--plugin-dir ${shellSingleQuote(pluginDir)} ` : "";
  return `VOICE_SPAWN_ID=${spawnId} claude ${pluginDirArg}${permissionModeArg(permissionMode)}/voice-control:start`;
}
