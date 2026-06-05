# Configuration

Create:

```json
{
  "elevenlabsApiKey": "xi_...",
  "agentId": "agent_...",
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

The API key is read only by the local MCP daemon. It is not sent to Cloudflare or the browser.
