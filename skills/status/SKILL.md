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

Summarize for the user: active or stopped. If a session is present, **reproduce the QR block
character-for-character inside a fenced code block** (so it stays scannable) and show the phone
`sessionUrl` beneath it as a tap/copy fallback.
