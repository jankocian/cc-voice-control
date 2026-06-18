# Configuration

Create:

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

at:

```sh
~/.config/voice-remote/config.json
```

Then lock the file down:

```sh
chmod 600 ~/.config/voice-remote/config.json
```

- `elevenlabsApiKey` (required) — read only by the local MCP daemon. It is not sent
  to Cloudflare or the browser.
- `voiceId` (recommended) — the ElevenLabs voice used to read Claude's replies aloud.
  Without it, replies are shown as text but not spoken.
- `ttsModelId` / `sttModelId` (optional) — override the default ElevenLabs models.
- `bridgeUrl` (required) — the Cloudflare Worker bridge URL. For local testing this
  is `http://localhost:8787`.
- `sessionTimeoutMinutes` (optional, default 120) — how long a session stays valid.
