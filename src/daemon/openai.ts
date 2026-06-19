import type { VoiceRemoteConfig } from "./config.js";

const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "marin";
const OPENAI_BASE = "https://api.openai.com/v1";

/** Pick an advisory filename extension from the upload MIME. OpenAI sniffs the
 *  container, but a matching extension avoids any edge-case ambiguity. */
function filenameForMime(mimeType: string): string {
  if (mimeType.includes("mp4")) return "speech.mp4";
  if (mimeType.includes("ogg")) return "speech.ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "speech.mp3";
  if (mimeType.includes("wav")) return "speech.wav";
  return "speech.webm";
}

/** Transcribe a recorded audio clip with the OpenAI speech-to-text API.
 *  Mirrors elevenlabs.transcribeAudio's signature/return so call sites are unchanged. */
export async function transcribeAudio(config: VoiceRemoteConfig, audio: Uint8Array, mimeType: string): Promise<string> {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed view so the DOM Blob type is satisfied.
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  const type = mimeType || "audio/webm";
  form.append("file", new Blob([bytes], { type }), filenameForMime(type));
  form.append("model", config.sttModel ?? DEFAULT_STT_MODEL);
  if (config.language) form.append("language", config.language);
  // We only need the final transcript string; "text" returns it raw (no JSON envelope).
  form.append("response_format", "text");

  const response = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.openaiApiKey}` },
    body: form
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI speech-to-text failed (${response.status}): ${body}`);
  }

  return (await response.text()).trim();
}

export type SynthesizedSpeech = { audioBase64: string; mimeType: string };

/** Render text to speech with the OpenAI text-to-speech API. Returns base64 MP3 with
 *  mimeType "audio/mpeg" — byte-shape identical to elevenlabs.synthesizeSpeech, so the
 *  browser playback contract is unchanged. `voiceOverride` lets the phone pick a voice
 *  for the session ahead of the config default. */
export async function synthesizeSpeech(
  config: VoiceRemoteConfig,
  text: string,
  voiceOverride?: string
): Promise<SynthesizedSpeech> {
  const response = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.ttsModel ?? DEFAULT_TTS_MODEL,
      voice: voiceOverride ?? config.openaiVoice ?? DEFAULT_VOICE,
      input: text,
      response_format: "mp3",
      ...(config.ttsInstructions ? { instructions: config.ttsInstructions } : {})
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI text-to-speech failed (${response.status}): ${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { audioBase64: buffer.toString("base64"), mimeType: "audio/mpeg" };
}
