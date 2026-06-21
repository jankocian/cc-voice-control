---
description: Open a NEW voice-controlled Claude session in another cmux workspace, joining this phone's voice remote as a new switchable thread. Use when the user asks to spin up / open / start another session, instance, or workspace — optionally at a given repo path.
allowed-tools: Bash
---

Open a new voice-controlled session. This pane's daemon spawns a fresh cmux workspace running
`claude … /voice-control:start`, which joins the **same phone URL/QR** as a new thread and
**inherits this session's permission mode** (e.g. if you're in bypass, the new one is too).

Decide the target directory from the user's request: the repo/path they named, or the current
working directory if they didn't specify one. Then run the command below, replacing `TARGET_DIR`
with that directory as an ABSOLUTE path — use `$HOME/...` (NOT `~`, which won't expand inside the
quotes) or `$PWD` for the current directory. It's quoted, so paths with spaces are fine.

```sh
D="${CLAUDE_PLUGIN_DATA}"
R="$D/runtime/${CMUX_SURFACE_ID:-default}.json"
PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$R" 2>/dev/null)
[ -z "$PORT" ] && { echo "no-daemon"; exit 0; }
DIR=$(cd "TARGET_DIR" 2>/dev/null && pwd) || { echo "bad-path"; exit 0; }
OUT=$(curl -s -w '\n%{http_code}' -X POST "http://127.0.0.1:$PORT/spawn" -H 'content-type: application/json' -d "{\"cwd\":\"$DIR\"}")
CODE=$(printf '%s' "$OUT" | tail -1)
[ "$CODE" = "404" ] && { echo "stale-daemon"; exit 0; }
printf '%s' "$OUT" | sed '$d'; echo
```

Report back to the user:

- `{"ok":true,"ref":"workspace:N"}` → a new voice-controlled session is opening at that path; it
  will appear as a new thread on their phone in a few seconds (same QR — no re-scan).
- `stale-daemon` → the voice daemon running in this pane predates the spawn feature. Tell them to
  restart it once: `/voice-control:stop` then `/voice-control:start`, then try again.
- `no-daemon` → voice isn't running in this pane; tell them to run `/voice-control:start` first.
- `bad-path` → the directory doesn't exist; ask for a valid path.
- `{"ok":false}` or any other output → cmux couldn't open the workspace; report it.
