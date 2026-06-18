import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  toBridgeBrowserSessionUrl,
  toBridgeWebSocketUrl,
  type BridgeClientRole
} from "../shared/bridge-contract.js";

const ConfigSchema = z.object({
  elevenlabsApiKey: z.string().min(1),
  // Voice used to read Claude Code's replies aloud (ElevenLabs voice_id).
  voiceId: z.string().min(1).optional(),
  // ElevenLabs model ids; sensible defaults applied at call sites when omitted.
  ttsModelId: z.string().min(1).optional(),
  sttModelId: z.string().min(1).optional(),
  // Legacy: the conversational-agent id. No longer used by the push-to-talk flow.
  agentId: z.string().min(1).optional(),
  bridgeUrl: z.string().url(),
  sessionTimeoutMinutes: z.number().int().positive().default(120)
});

export type VoiceRemoteConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "voice-remote", "config.json");

export async function loadConfig(path = process.env.VOICE_REMOTE_CONFIG ?? DEFAULT_CONFIG_PATH): Promise<VoiceRemoteConfig> {
  const fileStat = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`Missing config file at ${path}`);
    }
    throw error;
  });

  if ((fileStat.mode & 0o077) !== 0) {
    throw new Error(`Config file permissions must be 0600: ${path}`);
  }

  const raw = await readFile(path, "utf8");
  return ConfigSchema.parse(JSON.parse(raw));
}

export function toWebSocketUrl(
  bridgeUrl: string,
  sessionId: string,
  token: string,
  role: BridgeClientRole,
  expiresAt?: number
): string {
  return toBridgeWebSocketUrl(bridgeUrl, sessionId, token, role, expiresAt);
}

export function toBrowserUrl(bridgeUrl: string, sessionId: string, token: string, expiresAt?: number): string {
  return toBridgeBrowserSessionUrl(bridgeUrl, sessionId, token, expiresAt);
}
