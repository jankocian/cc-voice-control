---
description: Start the phone voice remote for this Claude Code session.
disable-model-invocation: true
allowed-tools: Bash
---

The voice remote runs inside this session as the `voice-command` plugin MCP server
(Claude Code starts it automatically). Starting just activates it and shows the phone URL.
State lives in the plugin's own data dir (`${CLAUDE_PLUGIN_DATA}`), not in `~/.config`.

1. Activate it by writing the flag the MCP server watches, then wait for it to publish the URL:

   ```sh
   D="${CLAUDE_PLUGIN_DATA}"
   mkdir -p "$D"
   rm -f "$D/runtime.json"
   touch "$D/active"
   for i in $(seq 1 20); do [ -f "$D/runtime.json" ] && break; sleep 0.5; done
   cat "$D/runtime.json" 2>/dev/null || echo "NOT_RUNNING"
   ```

2. If you see a `sessionUrl`, show it to the user and tell them to open it on their phone and
   tap to speak — their words arrive here as normal user messages and replies are spoken back.

3. If you see `NOT_RUNNING`, either the MCP server isn't up — relaunch Claude with the plugin
   loaded (`claude --plugin-dir <this repo>`), approving the `voice-command` MCP server once if
   prompted — or it couldn't start because the ElevenLabs config is missing/invalid (see
   `docs/configuration.md`). Fix that, then run `/voice-command:start` again.

Then **stop and return to normal** — do not call any further tools. To end it, run `/voice-command:stop`.
