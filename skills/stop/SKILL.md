---
description: Stop the phone voice remote.
disable-model-invocation: true
allowed-tools: Bash
---

Stop the voice remote **in this pane** by terminating its background task. Each pane runs its
own daemon, which writes its `pid` into a **per-pane** runtime file
(`runtime/<CMUX_SURFACE_ID>.json`). Sending that pid `SIGTERM` runs its clean-shutdown handler
(drops its thread at the bridge, closes the WebSocket, removes its runtime file). Sibling panes
are untouched — this stops only the voice remote for the current pane.

```sh
D="${CLAUDE_PLUGIN_DATA}"
R="$D/runtime/${CMUX_SURFACE_ID:-default}.json"
PID=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$R" 2>/dev/null)
if [ -n "$PID" ] && kill "$PID" 2>/dev/null; then echo "stopped"; else echo "not-running"; fi
```

This is idempotent: if nothing is running in this pane (no runtime file, or the pid is already
gone) it just reports `not-running`. You may also stop the task directly from `/tasks`.

Tell the user the voice remote is stopped for this pane (its thread on the phone goes offline
within a few seconds). To stop voice in another pane, run `/voice-control:stop` there.
