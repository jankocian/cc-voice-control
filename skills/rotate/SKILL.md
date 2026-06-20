---
description: Rotate the voice-remote session secret (re-issues the phone URL/QR).
disable-model-invocation: true
allowed-tools: Bash
---

The phone URL/QR is derived from one **machine-level secret** in `session.json`. Rotating mints
a **new** secret, so the old URL/QR stops working and every phone must re-scan. Use this only to
**kill a leaked URL**. (Normally you never rotate — the session goes dead on its own when no pane
is connected; see `revoke-on-exit`.)

**Rotate only when no voice remote is live**, so an active user is never forced to re-scan
mid-session. A live daemon writes a per-pane file under `runtime/`; rotating while one exists
would break that pane's active thread. So:

1. **Check whether any daemon is live in this machine** (any per-pane runtime file present):

   ```sh
   D="${CLAUDE_PLUGIN_DATA}"
   LIVE=$(ls "$D/runtime/" 2>/dev/null | grep -c '\.json$')
   echo "live-daemons: ${LIVE:-0}"
   ```

2. **If `live-daemons` is `0`** (nothing connected), rotate by removing `session.json` — the next
   `/voice-control:start` mints a fresh secret + URL/QR:

   ```sh
   D="${CLAUDE_PLUGIN_DATA}"
   rm -f "$D/session.json" "$D/qr.txt"
   echo "rotated — the next /voice-control:start mints a new URL/QR"
   ```

   Tell the user the old URL is now dead and they should run `/voice-control:start` to get the new
   QR, then re-scan on their phone.

3. **If `live-daemons` is `1` or more**, a voice remote is currently running. Do **NOT** rotate
   automatically. Warn the user clearly:
   - rotating now **re-issues the QR**, so **all phones must re-scan** and any **active threads
     drop**;
   - ask them to confirm explicitly that they want to rotate while voice is live (e.g. the URL
     leaked and they want to burn it immediately).
   - Only if they confirm, run `/voice-control:stop` in **every** pane first (so no daemon is
     live), then perform step 2. Otherwise stop and do nothing.
