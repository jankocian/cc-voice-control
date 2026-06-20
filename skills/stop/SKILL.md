---
description: Stop the phone voice remote.
disable-model-invocation: true
allowed-tools: Bash
---

Stop the voice remote by terminating its background task. The daemon writes its own `pid`
into `runtime.json`; sending it `SIGTERM` runs its clean-shutdown handler (drops the phone
session at the bridge, closes the WebSocket, and removes `runtime.json` + `qr.txt`).

```sh
D="${CLAUDE_PLUGIN_DATA}"
PID=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$D/runtime.json" 2>/dev/null)
if [ -n "$PID" ] && kill "$PID" 2>/dev/null; then echo "stopped"; else echo "not-running"; fi
```

This is idempotent: if nothing is running (no `runtime.json`, or the pid is already gone) it
just reports `not-running`. You may also stop the task directly from `/tasks` if you prefer.

Tell the user the voice remote is stopped (the phone page will go offline within a few seconds).
