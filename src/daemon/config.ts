import { createHash, randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { type BridgeClientRole, toBridgeBrowserSessionUrl, toBridgeWebSocketUrl } from "../shared/bridge-contract.js";

const ConfigSchema = z.object({
  // OpenAI key, read only by the local daemon for STT + TTS. Never sent to the bridge/browser.
  openaiApiKey: z.string().min(1),
  // Voice used to read Claude Code's replies aloud (gpt-4o-mini-tts voice name).
  openaiVoice: z.string().min(1).default("marin"),
  // OpenAI model ids; overridable, with sensible defaults.
  ttsModel: z.string().min(1).default("gpt-4o-mini-tts"),
  sttModel: z.string().min(1).default("gpt-4o-mini-transcribe"),
  // Optional steering string for gpt-4o-mini-tts delivery (tone, pace, accent…).
  ttsInstructions: z.string().min(1).optional(),
  // Optional ISO-639-1 STT hint (e.g. "en"); short clips can mis-detect language.
  language: z.string().min(1).optional(),
  // Where the daemon connects (and the phone URL points). Defaults to the public bridge so
  // installed users only set openaiApiKey; override to self-host or for local dev.
  bridgeUrl: z.string().url().default("https://voice-control.nee.rs")
});

export type VoiceRemoteConfig = z.infer<typeof ConfigSchema>;

/**
 * Where the plugin keeps runtime state (phone-session URL/QR, the config file,
 * logs). This is Claude Code's managed per-plugin data dir ($CLAUDE_PLUGIN_DATA),
 * NOT the user's ~/.config — a plugin must not create folders there. Falls back
 * to a temp dir if the variable is somehow unset.
 */
export function stateDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "cc-voice-control");
}

/**
 * Per-thread runtime file: `runtime/<surfaceId>.json` carries THIS pane's daemon
 * `port`/`pid`/`surface`/`sessionUrl`. Multi-session means N daemons share one stateDir, so a
 * single `runtime.json` would clobber between panes; keying it by the pane's CMUX_SURFACE_ID
 * keeps each pane's launch handshake (and its Stop/reset hooks) targeting the right daemon.
 *
 * The DO roster is the live truth for "who's connected"; these files are only the local
 * launch handshake (the start skill reads back the file it caused to be written, and the
 * Stop/reset hooks read this pane's file to reach its own daemon).
 *
 * When the surface is unknown (daemon launched outside cmux) we fall back to a stable
 * sentinel name so the path is still well-defined for the single-pane case.
 */
const RUNTIME_DIR_NAME = "runtime";
const RUNTIME_FALLBACK_SURFACE = "default";

export function runtimeDir(): string {
  return join(stateDir(), RUNTIME_DIR_NAME);
}

/** Machine-level runtime.json — used ONLY for the "setup needed" signal (no daemon, no
 *  surface yet, so it can't be per-thread). A live daemon publishes per-thread files via
 *  threadRuntimePath(); the start skill reads this for the no-API-key onboarding path. */
export function runtimePath(): string {
  return join(stateDir(), "runtime.json");
}

export function threadRuntimePath(surfaceId?: string): string {
  return join(runtimeDir(), `${surfaceId || RUNTIME_FALLBACK_SURFACE}.json`);
}

/** Pre-rendered Unicode QR of the phone URL. Machine-level (one URL/QR shared by every
 *  pane, since it's a pure function of the shared secret) so the start skill can print it
 *  straight to the Claude Code chat regardless of which pane started. */
export function qrPath(): string {
  return join(stateDir(), "qr.txt");
}

/** The path we recommend the user create when no config file exists at all. Always lives in
 *  the plugin's managed data dir (via stateDir()) — never the user's ~/.config. */
export function recommendedConfigPath(): string {
  if (process.env.VOICE_REMOTE_CONFIG) return process.env.VOICE_REMOTE_CONFIG;
  return join(stateDir(), "config.json");
}

// Config is looked up in order: explicit $VOICE_REMOTE_CONFIG, then the plugin's managed
// data dir ($CLAUDE_PLUGIN_DATA, via stateDir()).
function configCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.VOICE_REMOTE_CONFIG) candidates.push(process.env.VOICE_REMOTE_CONFIG);
  candidates.push(join(stateDir(), "config.json"));
  return candidates;
}

/**
 * Result of loading config without throwing for the expected "not set up yet" cases.
 *
 *   { ok: true, config }         — a valid config file was found and parsed.
 *   { ok: false, needsSetup }    — no usable OpenAI key yet. `configPath` is the exact
 *                                  file the user should edit/create, and `message` is
 *                                  friendly onboarding text the start skill can print.
 *
 * Two "needs setup" sub-cases are distinguished by `reason`:
 *   "missing-key"  — a config file exists but has no `openaiApiKey` (point them at THAT file).
 *   "no-config"    — no config file anywhere (point them at the recommended path to create).
 */
export type ConfigSetupNeeded = {
  ok: false;
  needsSetup: true;
  missing: "openaiApiKey";
  reason: "missing-key" | "no-config";
  configPath: string;
  message: string;
};

export type ConfigLoadResult = { ok: true; config: VoiceRemoteConfig } | ConfigSetupNeeded;

const SETUP_EXAMPLE = '{ "openaiApiKey": "sk-..." }';

function setupMessage(configPath: string, exists: boolean): string {
  const action = exists ? `add your OpenAI API key to ${configPath}` : `create ${configPath}`;
  return [
    "An OpenAI API key is required to start the voice remote.",
    `To finish setup, ${action} with at least:`,
    `    ${SETUP_EXAMPLE}`,
    "Then re-run /voice-control:start."
  ].join("\n");
}

/**
 * Resolve config without throwing for the everyday "no API key yet" cases, so the start
 * skill can show friendly onboarding instead of a cryptic zod/throw. Genuine errors
 * (bad permissions, malformed JSON, a present-but-invalid key) still throw.
 */
export async function resolveConfig(explicitPath?: string): Promise<ConfigLoadResult> {
  const candidates = explicitPath ? [explicitPath] : configCandidates();
  let chosen: string | undefined;
  for (const candidate of candidates) {
    const isFile = await stat(candidate)
      .then((s) => s.isFile())
      .catch(() => false);
    if (isFile) {
      chosen = candidate;
      break;
    }
  }

  // (c) No config file at all → recommend the path to create.
  if (!chosen) {
    const configPath = explicitPath ?? recommendedConfigPath();
    return {
      ok: false,
      needsSetup: true,
      missing: "openaiApiKey",
      reason: "no-config",
      configPath,
      message: setupMessage(configPath, false)
    };
  }

  const fileStat = await stat(chosen);
  if ((fileStat.mode & 0o077) !== 0) {
    throw new Error(`Config file permissions must be 0600: ${chosen}`);
  }

  const raw = await readFile(chosen, "utf8");
  const parsed: unknown = JSON.parse(raw);

  // (b) A config file exists but has no openaiApiKey → point them at THAT file.
  if (!parsed || typeof parsed !== "object" || !("openaiApiKey" in (parsed as Record<string, unknown>))) {
    return {
      ok: false,
      needsSetup: true,
      missing: "openaiApiKey",
      reason: "missing-key",
      configPath: chosen,
      message: setupMessage(chosen, true)
    };
  }

  // (a) Valid config (any other validation issue is a real error → throw).
  return { ok: true, config: ConfigSchema.parse(parsed) };
}

/**
 * Publish a "setup needed" runtime.json so the start skill (which polls runtime.json)
 * can show friendly onboarding instead of NOT_RUNNING. Shaped so the skill can branch on
 * `needsSetup` and surface the exact `configPath` + `message`. No session is started.
 */
export function writeSetupNeededRuntime(setup: ConfigSetupNeeded): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    runtimePath(),
    JSON.stringify(
      {
        needsSetup: true,
        missing: setup.missing,
        configPath: setup.configPath,
        message: setup.message
      },
      null,
      2
    )
  );
}

// ---- machine session secret (one URL/QR, shared by every pane) ------------------------

/**
 * The one machine-level capability: a single secret minted once into session.json and
 * shared by every pane's daemon, so every pane derives the same phone URL/QR (TODO #2).
 * Replaces the per-activation randomBytes(16) that gave each pane a different URL.
 *
 *   $CLAUDE_PLUGIN_DATA/session.json  (mode 0600, like config.json)
 *   { "secret": "...", "daemonKey": "...", "sessionId": "...", "createdAt": <ms> }
 *
 * `daemonKey` is a SECOND, independent secret that authenticates the daemon ROLE to the bridge. It is
 * never put in any URL/QR and is not derivable from `secret`, so a leaked phone URL (which carries only
 * `secret`, in the fragment) cannot impersonate a daemon to re-open a pairing window or terminate the
 * session. The bridge pins it to the session on the first daemon connect (trust-on-first-use).
 */
export type MachineSession = { secret: string; sessionId: string; daemonKey: string };

const SESSION_SECRET_BYTES = 16; // 128 bits — the E2E key seed; rides in the URL fragment.
const DAEMON_KEY_BYTES = 32; // daemon-role auth secret (never leaves the machine except to the bridge).
// The session handle = sha256(secret) truncated. It's the routing key AND the visible id in the URL
// path, so it's kept short to keep the QR small; 8 base64url chars (48 bits) is far beyond any realistic
// collision risk for this tool (it's non-secret and only ever routes to a gated DO, so it need only be
// collision-resistant, not unguessable). The daemon and phone derive it identically.
const SESSION_ID_CHARS = 8;

function sessionFilePath(): string {
  return join(stateDir(), "session.json");
}

const SessionFileSchema = z.object({
  secret: z.string().min(1),
  daemonKey: z.string().min(1),
  sessionId: z.string().min(1),
  createdAt: z.number()
});

function deriveSessionId(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url").slice(0, SESSION_ID_CHARS);
}

/**
 * Load the machine session, minting it on first use. Idempotent and race-safe:
 *  - a well-formed session.json is returned as-is;
 *  - otherwise mint a secret and write it atomically (temp + rename, 0600), then RE-READ the
 *    file and return its contents. Under a two-pane start race both panes write, `rename`
 *    makes the last writer win, and the re-read makes both converge on that one secret — so
 *    no pane is ever stranded on a different URL.
 */
export function loadOrCreateSession(): MachineSession {
  const path = sessionFilePath();
  const existing = readSessionFile(path);
  if (existing) return existing;

  mkdirSync(stateDir(), { recursive: true });
  const secret = randomBytes(SESSION_SECRET_BYTES).toString("base64url");
  const daemonKey = randomBytes(DAEMON_KEY_BYTES).toString("base64url");
  const session = { secret, daemonKey, sessionId: deriveSessionId(secret), createdAt: Date.now() };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  // linkSync is atomic AND exclusive (fails if the target exists), unlike rename which overwrites.
  // So in a two-pane startup race the FIRST writer's secret wins and the loser falls through to
  // re-read it — both panes converge on one secret (= one URL/QR), never two.
  try {
    linkSync(tmp, path);
  } catch {
    // lost the race → the winner's session.json is already on disk
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp already gone
    }
  }
  const settled = readSessionFile(path) ?? session;
  return { secret: settled.secret, sessionId: settled.sessionId, daemonKey: settled.daemonKey };
}

function readSessionFile(path: string): MachineSession | undefined {
  try {
    const parsed = SessionFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return { secret: parsed.secret, sessionId: parsed.sessionId, daemonKey: parsed.daemonKey };
  } catch {
    return undefined; // absent or malformed → caller mints.
  }
}

export function toWebSocketUrl(
  bridgeUrl: string,
  sessionId: string,
  role: BridgeClientRole,
  threadId?: string
): string {
  return toBridgeWebSocketUrl(bridgeUrl, sessionId, role, threadId);
}

export function toBrowserUrl(bridgeUrl: string, sessionId: string, secret: string): string {
  return toBridgeBrowserSessionUrl(bridgeUrl, sessionId, secret);
}
