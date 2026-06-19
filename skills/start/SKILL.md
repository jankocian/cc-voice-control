---
description: Start the phone voice remote for this Claude Code session.
disable-model-invocation: true
allowed-tools: Bash
---

The voice remote runs inside this session as the `voice-control` plugin MCP server
(Claude Code starts it automatically). Starting just activates it and shows a scannable QR
code + the phone URL. State lives in the plugin's own data dir (`${CLAUDE_PLUGIN_DATA}`), not in `~/.config`.

1. Activate it by writing the flag the MCP server watches, then wait for it to publish the
   session. The daemon writes a pre-rendered QR code (`qr.txt`) and the URL (`runtime.json`):

   ```sh
   D="${CLAUDE_PLUGIN_DATA}"
   mkdir -p "$D"
   rm -f "$D/runtime.json" "$D/qr.txt"
   touch "$D/active"
   for i in $(seq 1 20); do [ -f "$D/runtime.json" ] && break; sleep 0.5; done
   if [ -f "$D/runtime.json" ]; then cat "$D/qr.txt" 2>/dev/null; echo; cat "$D/runtime.json"; else echo "NOT_RUNNING"; fi
   ```

2. If you see the QR block and a `sessionUrl`, present **both** to the user:
   - **Reproduce the QR code character-for-character inside a fenced code block** (` ``` `) so it
     renders monospaced and stays scannable — do not summarize, crop, re-wrap, or alter any
     character. This is the primary way in; the user scans it with their phone camera.
   - Show the `sessionUrl` directly beneath it as a tap/copy fallback (desktop, or if the scan fails).
   - Tell them to scan or open it and tap to speak — their words arrive here as normal user messages
     and replies are spoken back.

3. If you see `NOT_RUNNING`, either the MCP server isn't up — relaunch Claude with the plugin
   loaded (`claude --plugin-dir <this repo>`), approving the `voice-control` MCP server once if
   prompted — or it couldn't start because the ElevenLabs config is missing/invalid (see
   `docs/configuration.md`). Fix that, then run `/voice-control:start` again.

Then **stop and return to normal** — do not call any further tools. To end it, run `/voice-control:stop`.
