---
description: Open a NEW voice-controlled Claude session in another cmux workspace, joining this phone's voice remote as a new switchable thread. Use when the user asks to spin up / open / start another session, instance, or workspace — optionally at a given repo path.
allowed-tools: Bash
---

Open a new voice-controlled session. This pane's daemon spawns a fresh cmux workspace running
`claude … /voice-control:start`, which joins the **same phone URL/QR** as a new thread and
**inherits this session's permission mode** (e.g. if you're in bypass, the new one is too).

Decide the target directory from the user's request: the repo/path they named, or the current
working directory if they didn't specify one. Then run the command below, replacing `TARGET_DIR`
with that directory (you may use `~` or an absolute path; use `$PWD` for the current directory):

```sh
D="${CLAUDE_PLUGIN_DATA}"
R="$D/runtime/${CMUX_SURFACE_ID:-default}.json"
PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$R" 2>/dev/null)
[ -z "$PORT" ] && { echo "no-daemon"; exit 0; }
DIR=$(cd TARGET_DIR 2>/dev/null && pwd) || { echo "bad-path"; exit 0; }
curl -s -X POST "http://127.0.0.1:$PORT/spawn" -H 'content-type: application/json' -d "{\"cwd\":\"$DIR\"}"; echo
```

Report back to the user:

- `{"ok":true,"ref":"workspace:N"}` → a new voice-controlled session is opening at that path; it
  will appear as a new thread on their phone in a few seconds (same QR — no re-scan).
- `no-daemon` → voice isn't running in this pane; tell them to run `/voice-control:start` first.
- `bad-path` → the directory doesn't exist; ask for a valid path.
- `{"ok":false}` or any other output → cmux couldn't open the workspace; report it.
