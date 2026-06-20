---
description: Show the phone voice remote status.
disable-model-invocation: true
allowed-tools: Bash
---

Report whether the voice remote is running and re-show its QR code + phone URL. The remote is
a background task; `runtime.json` (written by the daemon, removed on stop) is the source of
truth, and its `pid` lets us confirm the task is actually alive:

```sh
D="${CLAUDE_PLUGIN_DATA}"
if [ -f "$D/runtime.json" ]; then
  PID=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$D/runtime.json" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo "active"; else echo "stale"; fi
else
  echo "stopped"
fi
cat "$D/qr.txt" 2>/dev/null
cat "$D/runtime.json" 2>/dev/null || echo "no active session"
```

Summarize for the user: **active** (running), **stopped** (no session), or **stale** (a
`runtime.json` exists but its task is gone — suggest re-running `/voice-control:start`). Then:

- If `runtime.json` contains `"needsSetup": true`, the remote can't start because the OpenAI API
  key is missing. Don't show a QR code. Tell the user an OpenAI API key is required, show the
  exact `configPath` from the JSON to open or create, show a tiny example to paste
  (`{ "openaiApiKey": "sk-...", "bridgeUrl": "https://...workers.dev" }`), and say to re-run
  `/voice-control:start` after saving.
- Otherwise, if a session is present, **reproduce the QR block character-for-character inside a
  fenced code block** (so it stays scannable) and show the phone `sessionUrl` beneath it as a
  tap/copy fallback.
