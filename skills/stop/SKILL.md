---
description: Stop the phone voice remote.
disable-model-invocation: true
allowed-tools: Bash
---

Deactivate the voice remote. The MCP server keeps running with the session (it does nothing
while idle); removing the flag makes it disconnect from the bridge and drop the phone session:

```sh
rm -f "${CLAUDE_PLUGIN_DATA}/active"
echo "stopped"
```

Tell the user the voice remote is stopped (the phone page will go offline within a few seconds).
