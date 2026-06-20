# Configuration

The daemon needs one config file with your OpenAI credentials:

```json
{
  "openaiApiKey": "sk-...",
  "openaiVoice": "marin"
}
```

It is looked up in this order (first match wins):

1. `$VOICE_REMOTE_CONFIG` — an explicit path you set in your shell.
2. `$CLAUDE_PLUGIN_DATA/config.json` — the plugin's own managed data dir
   (`~/.claude/plugins/data/voice-control…/`). This is where the plugin keeps all
   its state, so nothing lands in your `~/.config`.

Lock it down (it holds a secret):

```sh
chmod 600 <your-config>.json
```

- `openaiApiKey` (required) — read **only** by the local daemon. It is never sent
  to Cloudflare or the browser. If it's missing, `/voice-control:start` shows a friendly
  setup prompt (with the exact file to edit) instead of starting.
- `openaiVoice` (optional, default `marin`) — the `gpt-4o-mini-tts` voice used to read
  Claude's replies aloud. OpenAI recommends `marin` or `cedar` for best quality; other
  options include `alloy`, `ash`, `coral`, `nova`, `onyx`, `sage`.
- `ttsModel` / `sttModel` (optional) — override the default OpenAI models
  (`gpt-4o-mini-tts` / `gpt-4o-mini-transcribe`).
- `ttsInstructions` (optional) — a short steering string for `gpt-4o-mini-tts` that
  controls delivery (tone, pace, accent), e.g.
  `"Speak in a calm, clear, friendly tone like a concise pair-programming partner."`
- `language` (optional) — an ISO-639-1 hint for transcription (e.g. `"en"`). Short clips
  can mis-detect language; pinning it is faster and steadier.
- `bridgeUrl` (optional) — defaults to the public bridge (`https://voice-control.nee.rs`).
  Override it only to self-host the Worker or for local testing (`http://localhost:8787`).

The session has no wall-clock timeout: it stays valid while the voice remote is running
and ends on `/voice-control:stop` (or stopping its task in `/tasks`) or when the Claude Code
session closes. The daemon runs as a background task inside Claude's own process tree, so it
can't outlive the session — closing Claude tears it down even if you never run stop, and if
it's ever orphaned it self-reaps.
