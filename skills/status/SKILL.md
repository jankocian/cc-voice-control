---
description: Show the phone voice remote status.
disable-model-invocation: true
allowed-tools: Bash
---

Report whether the voice remote is running **in this pane** and re-show its QR code + phone URL.
Each pane runs its own daemon; this pane's per-pane runtime file
(`runtime/<CMUX_SURFACE_ID>.json`, written by the daemon, removed on stop) is the source of
truth, and its `pid` lets us confirm the task is actually alive. (The QR/URL is machine-level —
the same for every pane.)

```sh
D="${CLAUDE_PLUGIN_DATA}"
R="$D/runtime/${CMUX_SURFACE_ID:-default}.json"
if [ -f "$R" ]; then
  PID=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$R" 2>/dev/null)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo "active"; else echo "stale"; fi
elif [ -f "$D/runtime.json" ]; then echo "needs-setup"   # no API key yet (machine-level notice)
else echo "stopped"
fi
cat "$D/qr.txt" 2>/dev/null
cat "$R" 2>/dev/null || cat "$D/runtime.json" 2>/dev/null || echo "no active session"
```

Summarize for the user: **active** (running in this pane), **stopped** (no session here), or
**stale** (a runtime file exists but its task is gone — suggest re-running
`/voice-control:start`). Then:

- If the output contains `"needsSetup": true`, the remote can't start because the OpenAI API
  key is missing. Don't show a QR code. Tell the user an OpenAI API key is required, show the
  exact `configPath` from the JSON to open or create, show a tiny example to paste
  (`{ "openaiApiKey": "sk-..." }`), and say to re-run
  `/voice-control:start` after saving.
- Otherwise, if a session is present, **reproduce the QR block character-for-character inside a
  fenced code block** (so it stays scannable) and show the phone `sessionUrl` beneath it as a
  tap/copy fallback.
