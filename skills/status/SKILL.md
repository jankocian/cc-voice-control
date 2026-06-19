---
description: Show the phone voice remote status.
disable-model-invocation: true
allowed-tools: Bash
---

Report whether the voice remote is active and re-show its QR code + phone URL:

```sh
D="${CLAUDE_PLUGIN_DATA}"
if [ -f "$D/active" ]; then echo "active"; else echo "stopped"; fi
cat "$D/qr.txt" 2>/dev/null
cat "$D/runtime.json" 2>/dev/null || echo "no active session"
```

Summarize for the user: active or stopped. Then:

- If `runtime.json` contains `"needsSetup": true`, the remote can't start because the OpenAI API
  key is missing. Don't show a QR code. Tell the user an OpenAI API key is required, show the
  exact `configPath` from the JSON to open or create, show a tiny example to paste
  (`{ "openaiApiKey": "sk-...", "bridgeUrl": "https://...workers.dev" }`), and say to re-run
  `/voice-control:start` after saving.
- Otherwise, if a session is present, **reproduce the QR block character-for-character inside a
  fenced code block** (so it stays scannable) and show the phone `sessionUrl` beneath it as a
  tap/copy fallback.
