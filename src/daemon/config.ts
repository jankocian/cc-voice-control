import { readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { type BridgeClientRole, toBridgeBrowserSessionUrl, toBridgeWebSocketUrl } from "../shared/bridge-contract.js";

const ConfigSchema = z.object({
  elevenlabsApiKey: z.string().min(1),
  // Voice used to read Claude Code's replies aloud (ElevenLabs voice_id).
  voiceId: z.string().min(1).optional(),
  // ElevenLabs model ids; sensible defaults applied at call sites when omitted.
  ttsModelId: z.string().min(1).optional(),
  sttModelId: z.string().min(1).optional(),
  // Where the daemon connects (and the phone URL points). Defaults to the public bridge so
  // installed users only set elevenlabsApiKey; override to self-host or for local dev.
  bridgeUrl: z.string().url().default("https://voice-control.nee.rs")
});

export type VoiceRemoteConfig = z.infer<typeof ConfigSchema>;

/**
 * Where the plugin keeps runtime state (phone-session URL, the active flag,
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

const LEGACY_CONFIG_PATH = join(homedir(), ".config", "voice-remote", "config.json");

// Config is looked up in order: explicit $VOICE_REMOTE_CONFIG, then the plugin
// data dir, then the legacy ~/.config path (back-compat for existing setups).
function configCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.VOICE_REMOTE_CONFIG) candidates.push(process.env.VOICE_REMOTE_CONFIG);
  if (process.env.CLAUDE_PLUGIN_DATA) candidates.push(join(process.env.CLAUDE_PLUGIN_DATA, "config.json"));
  candidates.push(LEGACY_CONFIG_PATH);
  return candidates;
}

export async function loadConfig(explicitPath?: string): Promise<VoiceRemoteConfig> {
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
  if (!chosen) {
    throw new Error(`Missing config file. Looked in: ${candidates.join(", ")}`);
  }

  const fileStat = await stat(chosen);
  if ((fileStat.mode & 0o077) !== 0) {
    throw new Error(`Config file permissions must be 0600: ${chosen}`);
  }

  const raw = await readFile(chosen, "utf8");
  return ConfigSchema.parse(JSON.parse(raw));
}

export function toWebSocketUrl(bridgeUrl: string, sessionId: string, token: string, role: BridgeClientRole): string {
  return toBridgeWebSocketUrl(bridgeUrl, sessionId, token, role);
}

export function toBrowserUrl(bridgeUrl: string, sessionId: string, token: string): string {
  return toBridgeBrowserSessionUrl(bridgeUrl, sessionId, token);
}
