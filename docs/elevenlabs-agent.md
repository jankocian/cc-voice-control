# ElevenLabs Setup (Speech-to-Text + Text-to-Speech)

The voice remote uses **push-to-talk**, not a Conversational AI agent. You tap to
record, tap again to send; the local daemon converts your speech to text, forwards
it to Claude Code, and reads Claude's reply back to you. No agent, client tools, or
signed URLs are required, and the ElevenLabs API key never leaves your machine.

## What you need

- An ElevenLabs API key (the daemon calls ElevenLabs server-side from your computer).
- A `voiceId` for the voice that reads replies aloud. Pick any voice from
  `GET https://api.elevenlabs.io/v1/voices`, or use a default shared voice such as
  `21m00Tcm4TlvDq8ikWAM` (Rachel).

Both go in the config file — see `docs/configuration.md`.

## APIs used by the daemon

- **Speech-to-text:** `POST /v1/speech-to-text` with the recorded clip and
  `model_id` (default `scribe_v1`).
- **Text-to-speech:** `POST /v1/text-to-speech/{voiceId}` with the reply text and
  `model_id` (default `eleven_turbo_v2_5`, tuned for low latency).

The phone browser only records audio (`MediaRecorder`) and plays the returned MP3.
It loads no third-party SDK, so the page's Content-Security-Policy is `'self'`-only.
