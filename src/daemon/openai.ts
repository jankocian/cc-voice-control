import type { VoiceRemoteConfig } from "./config.js";

const OPENAI_BASE = "https://api.openai.com/v1";

/** OpenAI's /audio/speech accepts at most ~4096 characters of input per call. Longer
 *  replies are split on sentence boundaries into ≤-this chunks and the returned mp3
 *  buffers are concatenated, so nothing is ever truncated. */
export const MAX_TTS_INPUT_CHARS = 4096;

/** Pick an advisory filename extension from the upload MIME. OpenAI sniffs the
 *  container, but a matching extension avoids any edge-case ambiguity. */
function filenameForMime(mimeType: string): string {
  if (mimeType.includes("mp4")) return "speech.mp4";
  if (mimeType.includes("ogg")) return "speech.ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "speech.mp3";
  if (mimeType.includes("wav")) return "speech.wav";
  return "speech.webm";
}

/** Transcribe a recorded audio clip with the OpenAI speech-to-text API. */
export async function transcribeAudio(config: VoiceRemoteConfig, audio: Uint8Array, mimeType: string): Promise<string> {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed view so the DOM Blob type is satisfied.
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  const type = mimeType || "audio/webm";
  form.append("file", new Blob([bytes], { type }), filenameForMime(type));
  form.append("model", config.sttModel);
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

/** One OpenAI /audio/speech call for a single chunk that already fits the input limit.
 *  Returns the raw mp3 bytes so callers can concatenate frames across chunks. */
async function synthesizeChunk(config: VoiceRemoteConfig, text: string, voiceOverride?: string): Promise<Buffer> {
  const response = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.ttsModel,
      voice: voiceOverride ?? config.openaiVoice,
      input: text,
      response_format: "mp3",
      ...(config.ttsInstructions ? { instructions: config.ttsInstructions } : {})
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI text-to-speech failed (${response.status}): ${body}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/** Render text to speech with the OpenAI text-to-speech API. Returns base64 MP3 with
 *  mimeType "audio/mpeg". `voiceOverride` lets the phone pick a voice for the session
 *  ahead of the config default.
 *
 *  Chunking is transparent: a reply within the per-call limit is one request (fast path);
 *  a longer reply is split on sentence boundaries (`splitForTts`) into ≤-limit chunks,
 *  each synthesized separately, and the returned mp3 buffers are concatenated. mp3 frames
 *  are self-delimiting, so `Buffer.concat` yields one continuous, gapless clip and no
 *  reply is ever truncated. Chunks run sequentially to guarantee playback order. */
export async function synthesizeSpeech(
  config: VoiceRemoteConfig,
  text: string,
  voiceOverride?: string
): Promise<SynthesizedSpeech> {
  // Fast path: short replies stay a single API call.
  if (text.length <= MAX_TTS_INPUT_CHARS) {
    const buffer = await synthesizeChunk(config, text, voiceOverride);
    return { audioBase64: buffer.toString("base64"), mimeType: "audio/mpeg" };
  }

  // Long reply: synthesize each ≤-limit chunk and concatenate the mp3 byte buffers. If a
  // later chunk fails (transient 5xx / rate-limit) after earlier ones succeeded, speak the
  // partial audio rather than dropping the whole (already paid-for) reply to silence —
  // but if nothing synthesized at all, surface the error so the caller's catch reacts just
  // like the single-call path did.
  const parts: Buffer[] = [];
  for (const chunk of splitForTts(text, MAX_TTS_INPUT_CHARS)) {
    try {
      parts.push(await synthesizeChunk(config, chunk, voiceOverride));
    } catch (error) {
      if (parts.length === 0) throw error;
      break;
    }
  }
  return { audioBase64: Buffer.concat(parts).toString("base64"), mimeType: "audio/mpeg" };
}

/** Split `text` into chunks each at most `limit` characters, preferring sentence
 *  boundaries so speech breaks fall in natural places.
 *
 *  Algorithm: cut the text into sentences (terminator `.`/`!`/`?` plus trailing quotes/
 *  brackets and surrounding whitespace, or a paragraph break), then greedily pack whole
 *  sentences into a chunk until the next one would exceed `limit`. A single sentence that
 *  is itself longer than `limit` is hard-split at the limit as a fallback so it still
 *  gets spoken. Sentences are joined with their original separators preserved, so words
 *  are never glued together and the concatenated chunks reproduce the trimmed input. */
export function splitForTts(text: string, limit: number = MAX_TTS_INPUT_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= limit) return [trimmed];

  // Each match is a sentence including its trailing terminator/whitespace. `[\s\S]` spans
  // newlines so multi-line sentences are captured whole; the final run (with no
  // terminator) is captured by the `$` alternative.
  const sentences = trimmed.match(/[\s\S]*?(?:[.!?]+["')\]]*\s+|\n+|$)/g)?.filter((s) => s.length > 0) ?? [trimmed];

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    // A lone sentence that overflows the limit: flush what we have, then hard-split it.
    if (sentence.length > limit) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      for (const piece of hardSplit(sentence, limit)) chunks.push(piece);
      continue;
    }
    if (current.length + sentence.length > limit) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.length > 0) chunks.push(current);

  // Trim only the outer edges of each chunk; interior spacing is already preserved.
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}

/** Hard-split an over-long sentence into ≤`limit` (UTF-16 length) pieces WITHOUT ever
 *  cutting a surrogate pair in half, so no chunk handed to the API carries a lone
 *  surrogate half. Always makes forward progress (no infinite loop), even at limit 1. */
function hardSplit(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + limit, text.length);
    // If the cut would land just after a high surrogate, back off one unit to keep the
    // pair whole — but only when that still advances past `i`.
    if (end < text.length && end - 1 > i) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    pieces.push(text.slice(i, end));
    i = end;
  }
  return pieces;
}
