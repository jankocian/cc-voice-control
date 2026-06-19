---
description: Show the phone voice remote status.
disable-model-invocation: true
allowed-tools: Bash
---

Report whether the voice remote is active and show its phone URL:

```sh
D="${CLAUDE_PLUGIN_DATA}"
if [ -f "$D/active" ]; then echo "active"; else echo "stopped"; fi
cat "$D/runtime.json" 2>/dev/null || echo "no active session"
```

Summarize for the user: active or stopped, and the phone `sessionUrl` if present.
