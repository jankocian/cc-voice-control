import { mkdirSync, writeFileSync } from "node:fs";
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

export function runtimePath(): string {
  return join(stateDir(), "runtime.json");
}

/** Pre-rendered Unicode QR of the phone URL, written next to runtime.json so the
 *  start skill can print it straight to the Claude Code chat. */
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

const SETUP_EXAMPLE = '{ "openaiApiKey": "sk-...", "bridgeUrl": "https://...workers.dev" }';

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
 * Strict loader that throws on any problem, including a missing key. Kept for callers
 * (and tests) that want the hard failure; daemon activation uses `resolveConfig` instead
 * so a missing key becomes friendly onboarding rather than a thrown error.
 */
export async function loadConfig(explicitPath?: string): Promise<VoiceRemoteConfig> {
  const result = await resolveConfig(explicitPath);
  if (!result.ok) throw new Error(result.message);
  return result.config;
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

export function toWebSocketUrl(bridgeUrl: string, secret: string, role: BridgeClientRole): string {
  return toBridgeWebSocketUrl(bridgeUrl, secret, role);
}

export function toBrowserUrl(bridgeUrl: string, secret: string): string {
  return toBridgeBrowserSessionUrl(bridgeUrl, secret);
}
