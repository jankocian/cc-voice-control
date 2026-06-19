import type { VoiceRemoteConfig } from "./config.js";

const DEFAULT_STT_MODEL = "scribe_v1";
const DEFAULT_TTS_MODEL = "eleven_turbo_v2_5";

/** Transcribe a recorded audio clip with the ElevenLabs Scribe speech-to-text API. */
export async function transcribeAudio(
  config: VoiceRemoteConfig,
  audio: Uint8Array,
  mimeType: string
): Promise<string> {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed view so the DOM Blob type is satisfied.
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  form.append("file", new Blob([bytes], { type: mimeType || "audio/webm" }), "speech");
  form.append("model_id", config.sttModelId ?? DEFAULT_STT_MODEL);

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": config.elevenlabsApiKey },
    body: form
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs speech-to-text failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { text?: unknown };
  if (typeof data.text !== "string") {
    throw new Error("ElevenLabs speech-to-text response did not include text");
  }
  return data.text.trim();
}

export type SynthesizedSpeech = { audioBase64: string; mimeType: string };

/** Render text to speech with the ElevenLabs text-to-speech API. Returns base64 MP3. */
export async function synthesizeSpeech(config: VoiceRemoteConfig, text: string): Promise<SynthesizedSpeech> {
  if (!config.voiceId) {
    throw new Error("No voiceId configured for text-to-speech");
  }

  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}`);
  url.searchParams.set("output_format", "mp3_44100_128");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.elevenlabsApiKey,
      "content-type": "application/json",
      accept: "audio/mpeg"
    },
    body: JSON.stringify({ text, model_id: config.ttsModelId ?? DEFAULT_TTS_MODEL })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs text-to-speech failed (${response.status}): ${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { audioBase64: buffer.toString("base64"), mimeType: "audio/mpeg" };
}
