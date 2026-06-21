// The shell command a spawned cmux workspace runs to join this session as a new thread. cmux runs
// its `--command` in a shell, so every interpolated value here must be shell-safe. Kept pure (no
// daemon state) so the exact command shape — which carries the inherited permission mode — is unit-
// testable in isolation.

// The permission modes Claude Code accepts for `--permission-mode` (the same vocabulary it reports in
// hook input as `permission_mode`). We pass the spawning session's LIVE mode straight through so a
// spawned thread inherits it EXACTLY. Allowlisted: the value is interpolated into the spawn command,
// so an unrecognized one is dropped (the spawn falls back to the user's default) rather than passed.
export const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);

// Build the `--permission-mode` fragment (trailing space so it concatenates). A missing/unrecognized
// mode yields "" — the spawn falls back to the user's default rather than interpolating an unknown
// (or hostile) value into the command.
export function permissionModeArg(mode?: string): string {
  return mode && PERMISSION_MODES.has(mode) ? `--permission-mode ${mode} ` : "";
}

// POSIX single-quote: wrap in '…' and turn each embedded ' into '\'' so an odd install path (spaces,
// quotes) can't break out of the argument.
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type SpawnCommandParams = {
  // A uuid we generate; the new daemon echoes it in its first thread_register so the phone follows
  // THIS exact thread. uuid → already shell-safe, passed verbatim.
  spawnId: string;
  // Dev-only plugin-load root (`--plugin-dir`); undefined for an installed plugin (global to every
  // `claude`, so the flag is omitted). Shell-quoted because it's a filesystem path.
  pluginDir?: string;
  // The spawning session's live permission mode (allowlisted by permissionModeArg).
  permissionMode?: string;
};

export function buildClaudeSpawnCommand({ spawnId, pluginDir, permissionMode }: SpawnCommandParams): string {
  const pluginDirArg = pluginDir ? `--plugin-dir ${shellSingleQuote(pluginDir)} ` : "";
  // /voice-control:start is a positional slash command — Claude Code auto-submits + runs it on startup.
  return `VOICE_SPAWN_ID=${spawnId} claude ${pluginDirArg}${permissionModeArg(permissionMode)}/voice-control:start`;
}
