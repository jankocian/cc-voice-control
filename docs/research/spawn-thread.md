# Spawning a new cmux workspace that auto-runs `/voice-control:start`

**Question:** How do we reliably open a NEW cmux workspace running an interactive `claude` that
auto-runs `/voice-control:start` on startup, so a freshly-spawned pane joins a voice session
hands-free?

**Date:** 2026-06-20 · cmux **0.64.6 (86)** · claude **2.1.183** · plugin **voice-control 1.0.1**
(loaded via `--plugin-dir /Users/honza/Dev/Code/cc-voice-control`).

Findings are doc-backed (docs.claude.com / code.claude.com, anthropics/claude-code issues,
manaflow-ai/cmux issues) **and** empirically verified on this machine. Every load-bearing claim is
cited or marked "tested here".

---

## VERDICT (one line)

```sh
cmux new-workspace --cwd <trusted-dir> \
  --command 'claude --plugin-dir /Users/honza/Dev/Code/cc-voice-control "/voice-control:start"' \
  --focus false
```

…**plus a guaranteed focus of the new workspace** (it will not run otherwise — see below). On this
build the realized equivalent is: create unfocused, then `cmux select-workspace --workspace <ws>`
once. A positional slash command **does auto-submit and execute** in an interactive `claude`
session — proven below — so no keystroke injection is required for activation. The only thing that
is *not* automatic is cmux actually starting the `--command` process: with `--focus false` that is
**deferred until the workspace is first focused** (focus-gated PTY attach).

**Two residual gotchas the implementation must handle** (details in §5):
1. **Focus-gating** (cmux): `--command` does not run while the workspace is unfocused. Either pass
   `--focus true`, or spawn `--focus false` and then focus once programmatically.
2. **Trust dialog** (claude): a *new* session in an untrusted cwd shows
   "Is this a project you trust?" *before* the prompt runs, which blocks activation. Spawn into an
   already-trusted dir, or add `--permission-mode bypassPermissions` (a.k.a.
   `--dangerously-skip-permissions`).

---

## 1. Does `claude "<prompt>"` auto-SUBMIT in an interactive session? — YES. And a slash command auto-EXECUTES.

### Documentary evidence
- The CLI reference lists `claude "query"` as **"Start interactive session with initial prompt"**,
  example `claude "explain this project"`. The wording ("initial prompt", not "pre-filled input")
  implies submission.
  Source: <https://code.claude.com/docs/en/cli-reference> (CLI commands table).
- **Issue #11476 — "[FEATURE] Command line arg to not auto-submit the provided prompt"** (CLOSED,
  *not planned*). Its body states verbatim:
  > "Currently, when Claude Code is launched with a prompt as an argument, Claude will launch and
  > **automatically run that prompt**."
  The *existence* of a request to *opt out of* auto-submit is itself proof that auto-submit is the
  current default; closing it "not planned" means the default stands.
  Source: <https://github.com/anthropics/claude-code/issues/11476>
- **Issue #3180 — "[BUG] Passing prompt on command line doesn't work with -c"** confirms the
  baseline: without `-c`, `claude "Who Are You"` "automatically processes and returns a response";
  the *bug* is only that `-c` (continue) suppresses it. So a fresh (non-`-c`) session auto-submits.
  Source: <https://github.com/anthropics/claude-code/issues/3180>

### Empirical proof (this machine) — slash command specifically
Spawned a throwaway cmux workspace running `claude --model haiku '/status'` (a harmless, read-only
built-in slash command) and read the resulting screen via `cmux read-screen`. After clearing the
one-time trust dialog, the screen showed the **rendered `/status` panel** (Version / Session ID /
Model / "MCP servers: 6 connected" / Setting sources) — i.e. the slash command **ran by itself**,
no Enter sent by us. This proves a **positional slash command auto-submits and executes** in
interactive mode, not merely pre-fills.

> Conclusion: `claude --plugin-dir <root> "/voice-control:start"` is sufficient to *activate* the
> command hands-free. The remaining work is purely getting cmux to *start that claude process* and
> getting past the trust gate.

### Note on the plugin command itself
`skills/start/SKILL.md` has front-matter `disable-model-invocation: true`. That only stops the
*model* from auto-invoking the skill as a tool; it does **not** stop a **user-typed / positionally-
submitted** `/voice-control:start`. The positional-prompt path lands as a real user message, which
is exactly how a human typing `/voice-control:start` triggers it, so `disable-model-invocation` is
not a blocker. (Plugin name `voice-control` + skill dir `start` ⇒ command id `/voice-control:start`,
confirmed in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `skills/start/`.)

---

## 2. Is there a dedicated flag / hook to run an initial prompt or slash command on interactive startup?

**No interactive-mode mechanism beats the positional prompt. Specifically:**

- **No `--initial-prompt`-style flag.** The full flag table on
  <https://code.claude.com/docs/en/cli-reference> has nothing that injects an interactive turn. The
  positional `prompt` arg *is* the mechanism.
- **`--remote-control [name]` / `--rc`** = "Start an interactive session with **Remote Control**
  enabled so you can also control it from claude.ai or the Claude app." It does **not** run an
  initial prompt; it just exposes the session to remote control. (`claude remote-control` as a
  *subcommand* runs *server mode, no local interactive session* — wrong for us.) Not relevant to
  hands-free activation. Source: cli-reference flags + commands tables.
- **SessionStart hook — cannot run a slash command in interactive mode.** Per
  <https://code.claude.com/docs/en/hooks>: SessionStart supports only `type:"command"` and
  `type:"mcp_tool"`; its `additionalContext` is injected as a *system reminder* (read on the next
  model request, **not auto-submitted as a turn**); and its `initialUserMessage` field
  **"Applies in non-interactive mode (`-p`)"** only. There is **no** way for a hook to auto-execute
  a slash command or start an interactive turn. **The SessionStart-hook path is ruled out.**
- **Issue #10282 — "[FEATURE] Auto-execute slash commands on session start"** (CLOSED) asked for
  exactly a `{"type":"slash-command"}` SessionStart hook and notes "There's no way to automatically
  execute slash commands on session initialization." It was not shipped as a hook type. So no
  config/hook route exists; the positional prompt remains the only lever.
  Source: <https://github.com/anthropics/claude-code/issues/10282>
- `--init-only` / `--init` / `--maintenance` run Setup/SessionStart hooks then (for `--init-only`)
  **exit** — they do not start a live interactive session. Not usable.
  Source: cli-reference flags table.

> Conclusion: the positional prompt (`claude … "/voice-control:start"`) is the *only* supported
> hands-free activation for an interactive session.

---

## 3. Cross-surface send: does one pane's process drive ANOTHER workspace's surface? — YES (this is already how the plugin works), with one precondition.

The user's empirical "Terminal surface not found" was reproduced **and explained**. Two independent
causes, both fixable:

### (a) Ref-resolution: target by `--surface`, not `--workspace`, with `CMUX_WORKSPACE_ID` cleared
- `cmux read-screen --workspace workspace:29` → `Error: ... Terminal surface not found` (reproduced
  here). `read-screen`/`send` resolve a **surface**, and the `--workspace` form did not select the
  terminal surface cleanly for a foreign workspace.
- The **production plugin already solves this**. `src/daemon/cmux.ts` documents the "hard-won
  contract": **clear `CMUX_WORKSPACE_ID`** so a bare `--surface <ref>` resolves **globally**, and
  **target by `--surface` only, never `--workspace`**. With that, the daemon types into and reads
  from a pane in a *different* workspace every day (the whole voice feature depends on it). The
  same module exposes `cmuxSubmit()` = `send --surface <s> -- <text>` then
  `send-key --surface <s> enter` — a proven cross-surface "type + Enter".
- Verified here: once the surface was realized, `env -u CMUX_WORKSPACE_ID cmux read-screen --surface
  surface:55` returned the live screen of the *foreign* workspace, and `env -u CMUX_WORKSPACE_ID
  cmux send-key --surface surface:55 enter` drove its trust dialog. **Cross-surface send works.**

### (b) The deeper reason it failed *right after creation*: the surface had no PTY yet (see §4)
Before the new workspace was focused, `cmux top --processes` showed **0 processes / 0 B** for it,
and `read-screen --surface` returned `Surface is not a terminal` / `Terminal surface not found`.
There was nothing to read or send to because **the terminal had not been instantiated**. After a
single `select-workspace`, a `claude` PID appeared and the surface became readable/sendable. So the
original "not found" was *partly* a not-yet-realized surface, not only a ref bug.

> Cross-surface send/read **is fully supported** for a foreign workspace's terminal surface, via
> `--surface <ref>` + cleared `CMUX_WORKSPACE_ID` (global resolution) — **but only after that
> surface has been realized** (focused at least once). You cannot send keystrokes to a surface whose
> PTY does not exist yet.

---

## 4 & 5. cmux `new-workspace` specifics + the focus-gating blocker

### `--command` semantics
`cmux new-workspace --command` is documented as **"Send text+Enter to the new workspace after
creation"** (local `cmux new-workspace --help`). It is **not** a process `argv`; it is typed into
the new workspace's shell with an Enter — i.e. it runs as a shell command line. So
`--command 'claude --plugin-dir … "/voice-control:start"'` launches `claude` in that shell. `--cwd`
sets the launched shell's working directory (verified: the spawned claude reported `cwd:
/private/tmp` when spawned with `--cwd /tmp`).

### `--focus false` does NOT start the command until the workspace is focused (THE blocker)
Confirmed by direct test on **cmux 0.64.6**:
- Spawned `new-workspace --cwd /tmp --command 'echo SPAWN_MARKER…; sleep 600' --focus false`.
- **14 s later, unfocused:** `top --processes` = `0 B / 0 total`, **no marker file** → the command
  did **not** run.
- **Immediately after `cmux select-workspace --workspace <ws>`:** the marker file appeared and a
  process tree materialized → the command ran **on first focus**.

This is a real, documented cmux behaviour, not a fluke:
- **manaflow-ai/cmux #4090** — "Regression in 0.64.4: `cmux new-workspace` with `--command` or
  `--layout` silently drops the command when invoked unfocused." Root cause cited as the
  `view.window != nil` gate in `GhosttyTerminalView.swift` (no PTY attach while unfocused). Implied
  workaround: `--focus true`. (PRs #3876/#4115/#4137 in flight.)
  Source: <https://github.com/manaflow-ai/cmux/issues/4090>
- **#2555** "new workspace terminal doesn't render until tab switch", **#915** "New workspace
  terminal not loaded until clicked" — same lazy/focus-gated surface attach.
  Sources: <https://github.com/manaflow-ai/cmux/issues/2555>, <https://github.com/manaflow-ai/cmux/issues/915>

On 0.64.6 (this machine) the command was **queued and replayed on focus** rather than dropped
outright (better than the 0.64.4 regression), but the operational fact is identical: **the command
will not execute until the workspace is focused at least once.**

**Implications for the spawn design — pick one:**
- **Option A (simplest, hands-free):** `--focus true`. The command runs immediately. Cost: it steals
  focus to the new pane (cmux #3215 notes `new-workspace` also raises the cmux app). Acceptable if
  "the new pane becomes active" is the desired UX (a freshly-spawned voice pane the user wants to
  look at anyway).
- **Option B (spawn in background, then realize):** `--focus false` to create it, capture
  `workspace:<N>` from the `OK workspace:<N>` stdout, then `cmux select-workspace --workspace
  <N>` once to trigger the deferred command. You can immediately re-select the original caller
  workspace afterward; the spawned claude keeps running (verified: after focusing then closing
  focus, the process persisted). This is the route if you must not permanently move the user.
- **Do NOT rely on `--focus false` alone** — the command never fires.

### Resolving the new workspace's surface ref (for any later cross-surface send)
1. `OUT=$(cmux new-workspace … )` → parse `workspace:<N>` from `OK workspace:<N>`.
2. After it is realized (focused once): `cmux list-pane-surfaces --workspace workspace:<N>` →
   parse `surface:<M>` (verified: returns e.g. `surface:55`). `list-panes --workspace <ws>` gives
   the `pane:<P>` if you need to `focus-pane`.
3. Send/read with `env -u CMUX_WORKSPACE_ID cmux <send|send-key|read-screen> --surface surface:<M>`
   (global resolution; matches `src/daemon/cmux.ts`).

> Note: because the positional `/voice-control:start` **auto-executes on its own** (§1), step 2–3
> are **not needed for activation**. They are only needed if you later want to *drive* the spawned
> session (e.g. inject text), which the plugin daemon already does for its own pane.

---

## Putting it together — recommended implementation

```sh
# 1. Spawn (Option A: hands-free, accepts focus move):
OUT=$(cmux new-workspace \
  --cwd "$REPO_OR_TRUSTED_DIR" \
  --command 'claude --plugin-dir /Users/honza/Dev/Code/cc-voice-control --permission-mode bypassPermissions "/voice-control:start"' \
  --focus true)
WS=$(printf '%s' "$OUT" | grep -oE 'workspace:[0-9]+' | head -1)
# claude boots → /voice-control:start auto-submits → daemon launches → QR shown. Done, hands-free.
```

```sh
# 1'. Spawn (Option B: keep user where they are):
OUT=$(cmux new-workspace --cwd "$DIR" \
  --command 'claude --plugin-dir /Users/honza/Dev/Code/cc-voice-control --permission-mode bypassPermissions "/voice-control:start"' \
  --focus false)
WS=$(printf '%s' "$OUT" | grep -oE 'workspace:[0-9]+' | head -1)
cmux select-workspace --workspace "$WS"     # REQUIRED: realizes the PTY → runs the --command
# (optional) cmux select-workspace --workspace "$ORIGINAL_WS"   # hop back; spawned claude keeps running
```

Why each piece:
- **`--plugin-dir /Users/honza/Dev/Code/cc-voice-control`** — without it the spawned `claude` has no
  voice-control plugin and `/voice-control:start` is an unknown command. (Confirmed the plugin is
  loaded this way in the running sessions: `ps` shows `claude … --plugin-dir
  /Users/honza/Dev/Code/cc-voice-control …`.) A global install would also satisfy this.
- **`"/voice-control:start"`** quoted — a positional slash command that **auto-submits/executes**
  (§1). Quote it so the shell does not treat the leading `/` oddly and to keep it one arg.
- **`--permission-mode bypassPermissions`** (≡ `--dangerously-skip-permissions`) — avoids the
  one-time **trust dialog** that otherwise blocks the prompt before it runs (observed: a fresh
  session in `/tmp` showed "Is this a project you trust?" and waited). cmux's own claude launcher
  already passes `--dangerously-skip-permissions` (seen in `ps` of every cmux-hosted claude), so a
  raw `--command` invocation must supply it or spawn into an already-trusted cwd. If the cwd is
  known-trusted, you may omit this flag.
- **Focus** — mandatory to actually start the process (§4/§5). Option A bakes it in; Option B does
  it explicitly.

---

## Confidence & residual unknowns (needs a live test)

- **Auto-submit of the slash command: PROVEN here** with `/status`. *Not yet executed end-to-end with
  the real `/voice-control:start`* (avoided in research to not spin up a live OpenAI daemon). The
  mechanism is identical (positional → user message → command runs); risk is low. **Recommended live
  test:** run Option A into a trusted dir with a valid `OPENAI_API_KEY` configured and confirm the QR
  appears unattended.
- **Trust dialog vs. `bypassPermissions`:** confirmed the dialog appears for an untrusted cwd; did
  not separately confirm that `--permission-mode bypassPermissions` suppresses it on the *very first*
  run of a never-trusted dir (docs say bypass skips permission *prompts*; the trust gate is adjacent).
  Safe fallback is to spawn into the already-trusted repo dir. **Verify once.**
- **cmux focus-gating is version-sensitive.** Proven on 0.64.6 (queued-then-runs-on-focus). On 0.64.4
  the command is *dropped* (#4090). If the plugin must support a range of cmux builds, **always
  focus** (Option A or B) — never depend on an unfocused command firing. After PRs #3876/#4115/#4137
  land this may relax, but don't assume it.
- **Focus side effects:** `new-workspace` can raise the cmux app / steal OS focus (cmux #3215). If the
  voice flow runs while the user is in another app, expect a focus jump on spawn.

---

## Sources

- Claude Code CLI reference — <https://code.claude.com/docs/en/cli-reference>
- Claude Code interactive mode — <https://code.claude.com/docs/en/interactive-mode>
- Claude Code hooks (SessionStart, additionalContext, initialUserMessage) — <https://code.claude.com/docs/en/hooks>
- anthropics/claude-code #11476 — opt out of auto-submit (proves auto-submit is default) — <https://github.com/anthropics/claude-code/issues/11476>
- anthropics/claude-code #3180 — command-line prompt auto-processes without `-c` — <https://github.com/anthropics/claude-code/issues/3180>
- anthropics/claude-code #10282 — auto-execute slash commands on session start (no hook shipped) — <https://github.com/anthropics/claude-code/issues/10282>
- manaflow-ai/cmux #4090 — `new-workspace --command` dropped when unfocused (focus-gated PTY) — <https://github.com/manaflow-ai/cmux/issues/4090>
- manaflow-ai/cmux #2555 — new workspace terminal not rendered until focus — <https://github.com/manaflow-ai/cmux/issues/2555>
- manaflow-ai/cmux #915 — new workspace terminal not loaded until clicked — <https://github.com/manaflow-ai/cmux/issues/915>
- manaflow-ai/cmux #3215 — new-workspace steals macOS focus — <https://github.com/manaflow-ai/cmux/issues/3215>
- manaflow-ai/cmux #120 — original request for `--command` — <https://github.com/manaflow-ai/cmux/issues/120>
- Local: `cmux 0.64.6 (86)`, `claude 2.1.183`, `cmux new-workspace --help`, `cmux send/--help`, plus
  empirical spawn tests (focus-gating, slash-command auto-exec, cross-surface read/send).
- Plugin contract for cross-surface drive: `src/daemon/cmux.ts` (clear `CMUX_WORKSPACE_ID`,
  `--surface`-only, `cmuxSubmit` = send + `send-key enter`).
