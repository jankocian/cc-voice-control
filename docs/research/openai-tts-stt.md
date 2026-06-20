# Research: Replace ElevenLabs with OpenAI for TTS + STT

**Status:** Research only — no implementation. (TODO.md item #1.)
**Date:** 2026-06-19.
**Goal:** Move both directions (speech-to-text for the phone's recorded clip, text-to-speech
for Claude's reply) from ElevenLabs to OpenAI — much cheaper, and let the user pick the speaking
voice and surface that in the web UI.

All model names, voices, formats, and prices below were verified against the live OpenAI docs
(see **Sources** at the bottom) on 2026-06-19. Anything not verifiable from official docs is
explicitly flagged.

---

## 0. What we do today (the integration we're replacing)

Grounded in the current source:

- **STT** — `src/daemon/elevenlabs.ts` → `transcribeAudio(config, audio, mimeType)`:
  multipart `POST https://api.elevenlabs.io/v1/speech-to-text` with `xi-api-key`,
  `file` (the raw recorded blob, `mimeType` defaulting to `audio/webm`) and
  `model_id` (default **`scribe_v1`**). Returns `{ text }`, we `.trim()` it.
- **TTS** — `synthesizeSpeech(config, text)`:
  `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}?output_format=mp3_44100_128`
  with `xi-api-key`, JSON body `{ text, model_id }` (default **`eleven_turbo_v2_5`**),
  `accept: audio/mpeg`. Returns base64 **MP3** + `mimeType: "audio/mpeg"`.
- **Flow** (`src/daemon/voice-daemon.ts`): phone records via `MediaRecorder`, base64-uploads
  the blob over the bridge WebSocket (`submit_audio`); daemon transcribes → `cmux send` types
  it into the live Claude pane; the Stop hook POSTs Claude's reply text back; daemon caps it at
  **2500 chars** (`MAX_SPEECH_CHARS`) and synthesizes speech; phone plays it.
- **Browser audio facts that constrain the migration** (`worker/src/browser-client.ts`):
  - Recording MIME is picked from `["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]`
    (`pickMimeType`, line 534). In practice: **webm/opus** on Android/desktop Chrome/Firefox,
    **mp4/aac** on iOS Safari. The chosen `mediaRecorder.mimeType` is what's uploaded.
  - TTS playback is an `<audio>` element fed a `blob:` URL built from the base64 + returned
    `mimeType` (`attachAudio`/`loadEntry`).
  - **CSP** (`worker/src/index.ts:559`): `media-src 'self' blob:`, `connect-src 'self'`. All
    audio is in-memory `blob:` and the only network target is the same-origin bridge — so the
    provider swap is **server-side only** and needs **no CSP change for OpenAI** (OpenAI is
    never contacted from the browser). The ElevenLabs CSP/CDN origins to remove are unrelated
    leftovers (see §8).
- **Config** (`src/daemon/config.ts`): `elevenlabsApiKey` (required), `voiceId?`, `ttsModelId?`,
  `sttModelId?`, `bridgeUrl`.

---

## 1. TTS models

OpenAI exposes three TTS models at `POST /v1/audio/speech`:

| Model | Notes | `instructions` steering | Streaming (SSE) |
|---|---|---|---|
| **`gpt-4o-mini-tts`** | Newest, most reliable; LLM-based, **steerable** via `instructions`. Max **2000 input tokens** per request. | **Yes** | **Yes** |
| `tts-1` | Older; lower latency, lower quality. | **No** (incompatible) | No |
| `tts-1-hd` | Older; higher quality, higher latency/cost. | **No** (incompatible) | No |

- `gpt-4o-mini-tts` also has a dated alias `gpt-4o-mini-tts-2025-12-15`.
- Streaming: the endpoint supports realtime audio over chunked transfer encoding ("audio can be
  played before the full file is generated"). A `stream_format` param accepts `"sse"` or
  `"audio"`; **`"sse"` is unavailable for `tts-1`/`tts-1-hd`** (only `gpt-4o-mini-tts` streams).
- **Latency for our use:** we don't stream today (we get the whole base64 blob, then send one
  `tts_audio` event). `gpt-4o-mini-tts` is LLM-based so first-byte latency is higher than the
  older `tts-1`, but for a phone remote that plays a complete reply this is fine. Streaming is a
  *future* optimization (would need a new chunked `tts_audio` browser protocol — out of scope here).

**Verified:** model names, the 2000-token input cap, `instructions` incompatibility with the
`tts-1*` family, and the `stream_format` values are all from the official API reference and the
TTS guide.

---

## 2. Voices

`gpt-4o-mini-tts` supports **13 built-in voices** (the `voice` parameter). Short character
notes below — OpenAI's docs name the voices but give only light descriptions; the character
sketches are the commonly-understood timbres and should be treated as **approximate** (flagged):

| Voice | Rough character |
|---|---|
| `alloy` | Neutral, balanced, androgynous — safe default. |
| `ash` | Warm, measured, slightly gravelly. |
| `ballad` | Soft, expressive, storytelling. *(newer; not on `tts-1*`)* |
| `coral` | Bright, friendly, upbeat. |
| `echo` | Calm, even, clear male-leaning. |
| `fable` | Animated, narration-friendly, British-ish lilt. |
| `nova` | Energetic, youthful female-leaning. |
| `onyx` | Deep, authoritative male. |
| `sage` | Mellow, thoughtful. |
| `shimmer` | Light, airy female-leaning. |
| `verse` | Versatile, dynamic. *(newer; not on `tts-1*`)* |
| `marin` | **Recommended for best quality.** *(newer; not on `tts-1*`)* |
| `cedar` | **Recommended for best quality.** *(newer; not on `tts-1*`)* |

- OpenAI's guidance: *"for best quality, we recommend using `marin` or `cedar`."*
- The older `tts-1`/`tts-1-hd` support a **smaller subset** — they exclude `ballad`, `verse`,
  `marin`, and `cedar`.
- **Steering — verified yes.** `gpt-4o-mini-tts` accepts an optional **`instructions`** string
  (max 4096 chars) that controls delivery: per the docs you can steer *"accent, emotional range,
  intonation, impressions, speed of speech, tone, [and] whispering."* Example:
  `instructions: "Speak in a calm, concise, friendly tone, like a helpful pair-programming partner."`
  `instructions` is **not supported on `tts-1`/`tts-1-hd`**. There's also a separate numeric
  `speed` param (0.25–4.0, default 1.0) that works on all models.
- **Listen before shipping:** voice timbre is subjective. The descriptions above are a starting
  point — audition the shortlist (`marin`, `cedar`, `alloy`, `ash`, `coral`) with our actual
  reply text before locking a default.

---

## 3. Audio output formats (TTS) and browser playback

`response_format` (default `mp3`) accepts: **`mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`**.

For our **phone `<audio>` + `blob:` URL** playback path:

| Format | Phone `<audio>` fit | Verdict |
|---|---|---|
| **`mp3`** | Universally decodable (iOS Safari, Android Chrome). `audio/mpeg`. | **Best default** — drop-in, identical to today's `audio/mpeg`. |
| `aac` | Plays on iOS/Android (`audio/aac`); good compression. | Fine alternative; mp3 is simpler/more universal. |
| `opus` | Raw `.opus`/ogg-opus playback is **inconsistent in `<audio>`** across mobile (esp. iOS). | Avoid for playback. |
| `wav`/`pcm` | Decodable but **large** (uncompressed) — bad over cellular. `pcm` is headerless raw and won't play as a blob without a WAV wrapper. | Only worth it for *streaming low-latency*, not our blob path. |
| `flac` | Lossless, large, weak mobile support. | Avoid. |

- The docs note `wav`/`pcm` give the **fastest first-byte** (no encode step) — relevant only if
  we later stream; for a one-shot reply blob, **`mp3` wins** on size + universal phone support and
  keeps `mimeType: "audio/mpeg"` so `browser-client.ts` needs **zero playback changes**.

**Recommendation: `response_format: "mp3"`**, returned as `audio/mpeg` (exactly today's contract).

---

## 4. STT models

OpenAI exposes transcription at `POST /v1/audio/transcriptions`:

| Model | Notes | Streaming | Response formats |
|---|---|---|---|
| **`gpt-4o-mini-transcribe`** | LLM-based, cheap, good accuracy; modern Whisper-successor. Dated alias `gpt-4o-mini-transcribe-2025-12-15`. | **Yes** (`stream=true`) | `json`, `text` |
| `gpt-4o-transcribe` | Highest accuracy of the GPT-4o STT family; pricier. | Yes | `json`, `text` |
| `gpt-4o-transcribe-diarize` | Speaker-aware (diarization). Overkill — single speaker. | — | `json`, `text`, `diarized_json` |
| `whisper-1` | Legacy open Whisper. Only model with word/segment **timestamps** (`timestamp_granularities[]`, `verbose_json`). **No streaming.** | No | `json`, `text`, `srt`, `verbose_json`, `vtt` |

- **Accuracy:** OpenAI positions `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` as **more accurate
  than `whisper-1`** (lower word error rate), and the mini variant is the cost/accuracy sweet spot.
  Language support spans ~99 languages.
- **Request shape:** required `file` + `model`; optional `language` (ISO-639-1, e.g. `"en"` —
  pinning this speeds things up and avoids mis-detection on short clips), `prompt` (bias terms —
  could seed with coding vocab), `response_format`, `temperature`, `stream`.
- **We only need the final text**, so `response_format: "text"` (or `json` → `.text`) is enough;
  we don't need timestamps, so `whisper-1`'s one advantage is irrelevant.

### Accepted input formats — the key compatibility check

The **API reference** for `createTranscription` lists accepted formats as:
**`flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm`.**

Our browser uploads (`pickMimeType`): **`webm`/opus**, **`mp4`**, or **`ogg`** — **all three are
accepted.** (`audio/webm;codecs=opus` → `webm`; iOS `audio/mp4` → `mp4`; `audio/ogg` → `ogg`.)

> ⚠️ **Doc discrepancy to flag:** the prose **speech-to-text guide** lists the supported set as
> `mp3, mp4, mpeg, mpga, m4a, wav, webm` and **omits `ogg`**, while the **API reference** (more
> authoritative, machine-generated from the schema) **includes `ogg`**. Our `pickMimeType`
> prefers `webm/opus` first and only falls to `ogg` as the last option, and **iOS produces `mp4`**,
> so in practice we'll almost always send `webm` or `mp4`, both unambiguously supported. **Action:**
> verify an actual `audio/ogg` upload transcribes (only Firefox-on-some-platforms would pick it),
> or simply **drop `audio/ogg` from `pickMimeType`** to stay strictly inside the guide's list.

- Max upload size is **25 MB**; a push-to-talk clip is far under this. No change needed to the
  base64-over-WebSocket upload.
- `transcribeAudio` already passes the real `mimeType` from the blob → the OpenAI `file` part can
  reuse it verbatim (filename extension is advisory; OpenAI sniffs the container).

---

## 5. Pricing comparison vs ElevenLabs

### OpenAI prices (verified June 2026)

**TTS**

| Model | Price |
|---|---|
| `gpt-4o-mini-tts` | **$0.60 / 1M text input tokens** + **$12.00 / 1M audio output tokens**. OpenAI's own estimate works out to **~$0.015/minute** of audio (≈ **$15 / 1M characters** at typical text→token ratios — *estimate, flagged*). |
| `tts-1` | **$15.00 / 1M characters** |
| `tts-1-hd` | **$30.00 / 1M characters** |

**STT**

| Model | Price |
|---|---|
| `whisper-1` | **$0.006 / minute** (= $0.36/hour) |
| `gpt-4o-mini-transcribe` | **$1.25 / 1M audio input tokens**, **$5.00 / 1M (text) output** → OpenAI's **estimated ~$0.003/minute** |
| `gpt-4o-transcribe` | **$2.50 / 1M audio input tokens**, **$10.00 / 1M output** → **estimated ~$0.006/minute** |

### ElevenLabs today (inferred from `elevenlabs.ts` + ElevenLabs' public pricing)

- We call **Scribe** (`scribe_v1`) STT and **`eleven_turbo_v2_5`** TTS. ElevenLabs is sold in
  **credit bundles tied to monthly plans**, not flat per-unit, but the effective rates are well
  above OpenAI:
  - **TTS (turbo/flash family):** ~**1 credit per character**; on paid tiers a character costs
    roughly **$0.10–$0.30 / 1,000 characters** depending on plan ⇒ ≈ **$100–$300 / 1M characters**
    (*ballpark, plan-dependent — flagged; ElevenLabs doesn't publish a clean $/char*).
  - **Scribe STT:** roughly **$0.40 / hour** on lower tiers ⇒ ≈ **$0.0067 / minute** — already
    close to whisper-1, but on a metered subscription rather than pure pay-as-you-go.

> ⚠️ ElevenLabs $/unit figures are **inferred** from their credit model and published plan prices,
> not a verbatim API rate card. Treat the **direction** (OpenAI is much cheaper for TTS, comparable
> or cheaper for STT) as the firm conclusion; exact ElevenLabs dollars depend on the active plan.

### Rough monthly example

Assume a fairly heavy day: **50 voice turns/day**, ~**20 days/month** = 1,000 turns. Per turn say
**15s of user speech** in and a **~600-character** Claude reply spoken out.

- **STT in:** 1,000 turns × 15s = **250 minutes/month**.
  - OpenAI `gpt-4o-mini-transcribe` ≈ 250 × $0.003 = **~$0.75/mo**
  - OpenAI `whisper-1` = 250 × $0.006 = **~$1.50/mo**
- **TTS out:** 1,000 × 600 chars = **600,000 characters/month**.
  - OpenAI `gpt-4o-mini-tts` ≈ 0.6M × ~$15/1M = **~$9/mo** (≈ token-based equivalent)
  - OpenAI `tts-1` = 0.6M × $15/1M = **$9/mo**
- **OpenAI total ≈ $10–11/month.**
- **ElevenLabs equivalent:** TTS alone at ~$100–300/1M chars on 0.6M chars = **~$60–180/mo**,
  plus STT ~$1.7/mo ⇒ **~$60–180/month** (plan-dependent).

**Cost delta: OpenAI is roughly 6–15× cheaper end-to-end for this workload, driven almost entirely
by TTS.** STT is roughly a wash to mildly cheaper.

---

## 6. Recommendation

| Concern | Pick | Rationale |
|---|---|---|
| **TTS model** | **`gpt-4o-mini-tts`** | Steerable (`instructions`), best modern voices (`marin`/`cedar`), and cheapest TTS while being far better quality than `tts-1`. The 2000-input-token cap is a non-issue: we already hard-cap spoken text at 2500 **chars** (`MAX_SPEECH_CHARS`) ≈ ~600 tokens. |
| **Default voice** | **`marin`** (fall back `alloy`) | OpenAI's own top-quality recommendation; `alloy` as a neutral, universally-pleasant fallback. **Audition before final lock.** |
| **STT model** | **`gpt-4o-mini-transcribe`** | Cheapest (~$0.003/min), more accurate than `whisper-1`, accepts our `webm`/`mp4` uploads. We need only final text, so no timestamps needed. |
| **TTS format** | **`mp3`** → `audio/mpeg` | Universal mobile `<audio>` playback, small over cellular, byte-identical contract to today (zero browser/CSP change). |
| **`instructions` default** | a short tone prompt | e.g. *"Speak in a calm, clear, friendly tone like a concise pair-programming partner."* Make it overridable later. |
| **`language`** | pin `"en"` (configurable) | Short clips mis-detect; pinning is faster and steadier. Expose as optional config. |

Streaming TTS is a worthwhile **follow-up** (lower time-to-first-audio on long replies) but needs a
new chunked browser protocol — explicitly out of scope for this swap.

---

## 7. Surfacing voice selection in the web UI

**Which voices to expose:** the curated, highest-quality `gpt-4o-mini-tts` set —
**`marin`, `cedar`, `alloy`, `ash`, `coral`, `nova`, `onyx`, `sage`** (the 13 minus the most
niche). Render each with its short character note (§2) and a small **preview/▶** button.

**Persistence model — both:**
- **Config default** (persisted on the machine): a `voice` field in
  `~/.config/voice-remote/config.json` (and the plugin data dir). This is the boot default.
- **Per-session override** (ephemeral, from the phone): a new browser→daemon event, e.g.
  `{ type: "set_voice", voice }`, held in daemon memory for the session and used by the next
  `synthesizeSpeech`. Mirrors how `mode` (queue/interrupt) already flows over the bridge. The
  daemon could echo the current voice in `session_status` so the picker reflects state on reconnect.

**Config shape (proposed):**
```jsonc
{
  "openaiApiKey": "sk-...",
  "voice": "marin",                 // default speaking voice (gpt-4o-mini-tts)
  "ttsModel": "gpt-4o-mini-tts",    // optional override
  "sttModel": "gpt-4o-mini-transcribe",
  "ttsInstructions": "Speak in a calm, clear, friendly tone...",  // optional steering
  "language": "en"                  // optional STT hint
}
```
The picker is small, mobile-first (a horizontal chip row or a compact sheet), fits the
"phone is the primary surface" rule, and doesn't need a server round-trip beyond the one
`set_voice` event.

---

## 8. Concrete migration notes

### Proposed `src/daemon/openai.ts` (mirrors `elevenlabs.ts` signatures)

```ts
import type { VoiceRemoteConfig } from "./config.js";

const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "marin";
const OPENAI_BASE = "https://api.openai.com/v1";

/** Transcribe a recorded clip with OpenAI. Mirrors elevenlabs.transcribeAudio. */
export async function transcribeAudio(
  config: VoiceRemoteConfig,
  audio: Uint8Array,
  mimeType: string
): Promise<string> {
  const form = new FormData();
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  // filename extension is advisory; OpenAI sniffs the container. Pick from mimeType.
  const name = mimeType.includes("mp4") ? "speech.mp4"
             : mimeType.includes("ogg") ? "speech.ogg"
             : "speech.webm";
  form.append("file", new Blob([bytes], { type: mimeType || "audio/webm" }), name);
  form.append("model", config.sttModel ?? DEFAULT_STT_MODEL);
  if (config.language) form.append("language", config.language);
  form.append("response_format", "text"); // we only want the transcript string

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.openaiApiKey}` },
    body: form
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI transcription failed (${res.status}): ${body}`);
  }
  return (await res.text()).trim(); // response_format=text returns raw text
}

export type SynthesizedSpeech = { audioBase64: string; mimeType: string };

/** Render text to speech with OpenAI. Returns base64 MP3. Mirrors elevenlabs.synthesizeSpeech. */
export async function synthesizeSpeech(
  config: VoiceRemoteConfig,
  text: string,
  voiceOverride?: string // per-session voice from the phone
): Promise<SynthesizedSpeech> {
  const res = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.ttsModel ?? DEFAULT_TTS_MODEL,
      voice: voiceOverride ?? config.voice ?? DEFAULT_VOICE,
      input: text,
      response_format: "mp3",
      ...(config.ttsInstructions ? { instructions: config.ttsInstructions } : {})
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI speech failed (${res.status}): ${body}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { audioBase64: buffer.toString("base64"), mimeType: "audio/mpeg" };
}
```

Notes:
- Both functions keep the **exact same external shape** as `elevenlabs.ts`, so `voice-daemon.ts`
  only changes its import line (`./elevenlabs.js` → `./openai.js`). `synthesizeSpeech` gains an
  optional `voiceOverride` for the per-session picker (§7).
- Auth changes from `xi-api-key` header to `Authorization: Bearer <openaiApiKey>`.
- The 2500-char `MAX_SPEECH_CHARS` cap is well under the 2000-**token** input limit, but consider
  re-deriving the cap from tokens to be safe on dense text. *(Minor; flag for implementation.)*

### Config changes (`src/daemon/config.ts`)

- **Add:** `openaiApiKey: z.string().min(1)`, `voice?`, `ttsModel?`, `sttModel?`,
  `ttsInstructions?`, `language?`.
- **Back-compat:** keep `elevenlabsApiKey`/`voiceId`/`ttsModelId`/`sttModelId` **optional** for one
  release (don't hard-break existing configs); make the schema accept either provider's key and
  pick OpenAI when `openaiApiKey` is present. Simplest clean cut: require `openaiApiKey`, drop the
  ElevenLabs fields, and update the local-run notes + README to the new key.
- `voiceId` (ElevenLabs UUID) does **not** map to OpenAI voice names — it's replaced by `voice`,
  not renamed.

### What to remove (per TODO #1 + §0)

- `src/daemon/elevenlabs.ts` (replaced by `src/daemon/openai.ts`).
- ElevenLabs config fields (`elevenlabsApiKey`, `voiceId`, `ttsModelId`, `sttModelId`) once back-compat window closes.
- The unused **ElevenLabs SDK assets + CSP/CDN origins** called out in TODO #1
  (jsdelivr / livekit / elevenlabs). **Grep first** — the active server-side path here is plain
  `fetch`, so these are likely stale leftovers from an earlier browser-SDK approach; confirm before
  deleting. The **runtime CSP in `worker/src/index.ts` needs no OpenAI origin** (browser never calls
  OpenAI), so removing the ElevenLabs origins is pure cleanup.
- Docs: `docs/configuration.md`, README, and the local-run memory note → new provider + `openaiApiKey`.

### `pickMimeType` consideration (browser)

Optionally drop `"audio/ogg"` from the candidate list (`browser-client.ts:535`) to stay strictly
inside the STT *guide's* documented set (the API reference does list `ogg`, but it's the one
ambiguous case — see §4). `webm` and `mp4` cover every mainstream phone.

---

## Sources (verified 2026-06-19)

- TTS guide — https://developers.openai.com/api/docs/guides/text-to-speech
- Speech (TTS) API reference — https://developers.openai.com/api/docs/api-reference/audio/createSpeech
- STT guide — https://developers.openai.com/api/docs/guides/speech-to-text
- Transcription API reference — https://developers.openai.com/api/docs/api-reference/audio/createTranscription
- `gpt-4o-mini-tts` model page (pricing) — https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
- Pricing page — https://developers.openai.com/api/docs/pricing
- Whisper/transcription per-minute corroboration — https://tokenmix.ai/blog/whisper-api-pricing , https://costgoat.com/pricing/openai-transcription
- TTS per-minute/character corroboration — https://tokenmix.ai/blog/gpt-4o-mini-tts-cheapest-tts-api-2026 , https://texttolab.com/blog/openai-tts-pricing

**Flagged as not fully verifiable from official docs:** per-voice character descriptions (§2,
approximate); the ~$15/1M-character TTS estimate (OpenAI prices tokens, not chars — derived);
ElevenLabs $/unit (§5, inferred from their credit/plan model, not a verbatim API rate card).
