---
description: Open a short pairing window so a new phone/device can connect to the voice remote.
disable-model-invocation: true
allowed-tools: Bash
---

Connecting a device is gated: the session URL/QR is a **single-use** pairing link — it works only
during a brief window AND only until the first device claims it, then it's dead (a paired device stays
in via a per-device cookie). So a leaked link or screenshotted QR can't grant access later.
`/voice-control:start` opens the first window automatically; run **this** command to open a fresh
single-use link for an **additional** device (or to re-pair one that was wiped when the session was
fully stopped, or a pairing that failed mid-handshake).

1. **Open a pairing window on this pane's daemon, then read back the QR + URL.** This pane's daemon
   (the per-pane runtime file `runtime/<CMUX_SURFACE_ID>.json`) must be running. Run **exactly**:

   ```sh
   D="${CLAUDE_PLUGIN_DATA}"
   R="$D/runtime/${CMUX_SURFACE_ID:-default}.json"
   if [ -f "$R" ]; then
     PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$R" 2>/dev/null)
     if [ -n "$PORT" ] && curl -sf -X POST "http://127.0.0.1:$PORT/pair" >/dev/null 2>&1; then
       echo "PAIRING_OPEN"
       cat "$D/qr.txt" 2>/dev/null; echo; cat "$R"
     else
       echo "PAIR_FAILED"
     fi
   else
     echo "NO_SESSION"
   fi
   ```

2. **If you see `PAIRING_OPEN`**, a ~90-second pairing window is now open. Present the QR + URL:
   - **Reproduce the QR block character-for-character inside a fenced code block** (` ``` `) so it stays
     scannable, and show the `sessionUrl` beneath it as a tap/copy fallback.
   - Tell the user clearly: **scan or open it on the new device within about 90 seconds**, and note it's
     **single-use** — the first device to open it pairs, and then the link is dead (even within the 90s).
     After that they'd run `/voice-control:pair` again for a new device. Once a device connects it stays
     connected (it remembers via a cookie), so they only do this once per device.

3. **If you see `NO_SESSION`**, there's no voice remote running in this pane — tell the user to run
   `/voice-control:start` here first (or run `/voice-control:pair` in a pane that already has one).

4. **If you see `PAIR_FAILED`**, the daemon is recorded but didn't accept the request (it may be
   restarting). Suggest `/voice-control:status`, then retry `/voice-control:pair`.

Then **stop and return to normal** — do not call any further tools.
