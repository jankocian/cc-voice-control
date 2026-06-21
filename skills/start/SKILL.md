---
description: Start the phone voice remote for this Claude Code session.
disable-model-invocation: true
allowed-tools: Bash
---

The voice remote runs as a **visible, killable background task** inside this Claude Code
session — it appears in `/tasks` and dies with the session. Starting it launches that task,
then shows a scannable QR code + the phone URL. State lives in the plugin's own data dir
(`${CLAUDE_PLUGIN_DATA}`), not in `~/.config`.

1. **Launch the voice daemon as a background task.** Use the **Bash tool's background mode**
   (`run_in_background`) — do **not** append `&`, and do **not** use `nohup`/`setsid`/`disown`
   (those detach it to launchd and it loses the cmux trust it needs to type into the pane).
   Run **exactly** this command (the env is set explicitly so it can't pick up another
   plugin's data dir):

   ```sh
   CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/dist/daemon/standalone.js"
   ```

   It will not return — that is correct; this process **is** the live voice session and must
   keep running. (If the OpenAI key is missing it instead writes onboarding state and exits.)

2. **Wait for the daemon to publish the session, then show it.** The daemon writes a
   machine-level QR code (`$CLAUDE_PLUGIN_DATA/qr.txt`, same URL/QR for every pane) and a
   **per-pane** runtime file at a fixed, plugin-data-independent path
   (`$HOME/.cache/cc-voice-control/runtime/<CMUX_SURFACE_ID>.json` — fixed so the Stop/UserPromptSubmit
   hooks find the same file even when their `CLAUDE_PLUGIN_DATA` differs from the daemon's, e.g. under a
   Codex companion). Poll for THIS pane's runtime file in a **separate, normal (foreground) Bash
   call** — and also handle the no-API-key case, which writes `$CLAUDE_PLUGIN_DATA/runtime.json` and exits:

   ```sh
   D="${CLAUDE_PLUGIN_DATA}"
   R="$HOME/.cache/cc-voice-control/runtime/${CMUX_SURFACE_ID:-default}.json"
   for i in $(seq 1 20); do { [ -f "$R" ] || [ -f "$D/runtime.json" ]; } && break; sleep 0.5; done
   if [ -f "$R" ]; then cat "$D/qr.txt" 2>/dev/null; echo; cat "$R";
   elif [ -f "$D/runtime.json" ]; then cat "$D/runtime.json";   # may be a needsSetup notice
   else echo "NOT_RUNNING"; fi
   ```

3. **If the output contains `"needsSetup": true`** (instead of a `sessionUrl`), the daemon
   could not start because the OpenAI API key is missing (the background task already exited, so
   there's no ghost `/tasks` entry). Do **not** show a QR code. Instead, print a friendly,
   clearly-formatted message that:
   - says **an OpenAI API key is required to start the voice remote**;
   - shows the exact `configPath` from the JSON to open or create (use that value verbatim);
   - shows a tiny example to paste into that file:
     ```json
     { "openaiApiKey": "sk-..." }
     ```
   - tells them to **re-run `/voice-control:start` after saving**.

   The `message` field in `runtime.json` already contains suitable text — you may surface it
   as-is and/or reformat it nicely. Then stop.

4. **If you see the QR block and a `sessionUrl`**, present **both** to the user:
   - **Reproduce the QR code character-for-character inside a fenced code block** (` ``` `) so it
     renders monospaced and stays scannable — do not summarize, crop, re-wrap, or alter any
     character. This is the primary way in; the user scans it with their phone camera.
   - Show the `sessionUrl` directly beneath it as a tap/copy fallback (desktop, or if the scan fails).
   - Tell them to scan or open it and tap to speak — their words arrive here as normal user messages
     and replies are spoken back.
   - Tell them the voice remote is now a **visible background task**: it shows up in `/tasks`, and to
     end it they can run `/voice-control:stop` or stop that task from `/tasks`.

5. If you see `NOT_RUNNING` after the poll, the background task didn't come up — check `/tasks`
   for its output (it logs to stderr) and `${CLAUDE_PLUGIN_DATA}/daemon.log`. Confirm the plugin
   is loaded, then run `/voice-control:start` again.

Then **stop and return to normal** — do not call any further tools. To end it, run `/voice-control:stop`.
