import type { VoiceRemoteConfig } from "./config.js";

export async function getElevenLabsSignedUrl(config: VoiceRemoteConfig): Promise<string> {
  const url = new URL("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url");
  url.searchParams.set("agent_id", config.agentId);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "xi-api-key": config.elevenlabsApiKey
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs signed URL request failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { signed_url?: unknown };
  if (typeof data.signed_url !== "string" || data.signed_url.length === 0) {
    throw new Error("ElevenLabs response did not include signed_url");
  }

  return data.signed_url;
}
