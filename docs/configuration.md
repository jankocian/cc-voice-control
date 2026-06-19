# Configuration

The daemon needs one config file with your ElevenLabs credentials:

```json
{
  "elevenlabsApiKey": "sk_...",
  "voiceId": "21m00Tcm4TlvDq8ikWAM",
  "ttsModelId": "eleven_turbo_v2_5",
  "sttModelId": "scribe_v1",
  "bridgeUrl": "https://voice.example.com",
  "sessionTimeoutMinutes": 120
}
```

It is looked up in this order (first match wins):

1. `$VOICE_REMOTE_CONFIG` — an explicit path you set in your shell.
2. `$CLAUDE_PLUGIN_DATA/config.json` — the plugin's own managed data dir
   (`~/.claude/plugins/data/voice-command…/`). **Recommended** — this is where the
   plugin keeps all its state, so nothing lands in your `~/.config`.
3. `~/.config/voice-remote/config.json` — legacy location, still read for back-compat.

Lock it down (it holds a secret):

```sh
chmod 600 <your-config>.json
```

- `elevenlabsApiKey` (required) — read **only** by the local daemon. It is never sent
  to Cloudflare or the browser.
- `voiceId` (recommended) — the ElevenLabs voice used to read Claude's replies aloud.
  Without it, replies are shown as text but not spoken.
- `ttsModelId` / `sttModelId` (optional) — override the default ElevenLabs models
  (`eleven_turbo_v2_5` / `scribe_v1`).
- `bridgeUrl` (required) — the Cloudflare Worker bridge URL. For local testing this
  is `http://localhost:8787`.
- `sessionTimeoutMinutes` (optional, default 120) — how long a session stays valid.
