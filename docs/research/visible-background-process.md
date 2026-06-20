# Research: Make the voice session a visible, killable background process

**Status:** Research only — no implementation. (TODO.md item #6.)
**Date:** 2026-06-20.
**Goal:** Today `/voice-control:start` gives no visible, killable artifact — the daemon runs
silently inside the plugin MCP server. We want voice mode to run as a process the user can *see*
(e.g. in `/bashes` / `/tasks`) and *kill* to end the session, with clean teardown.

Everything about Claude Code internals below is marked **[DOC]** (verified against official docs),
**[GH]** (from anthropics/claude-code GitHub issues / changelog), or **[INFER]** (reasoned, not
directly stated — must be confirmed in the live environment). The CRITICAL unknown is the OS-level
process lineage of a backgrounded Bash task; it is **undocumented** and the test plan in §6 is how
the user confirms it.

---

## 0. TL;DR — VERDICT

**Conditionally viable, and promising — but it hinges on one empirically-unconfirmed fact, and the
whole-cloth "drop the MCP host" version carries real risk on current Claude Code.**

- A backgrounded Bash task (`run_in_background: true`) **is a descendant of the interactive Claude
  process while the session is alive** — that is the one thing we need for cmux trust, and the
  public evidence points the right way (§2). **[INFER, high confidence — must be verified, §6.]**
- It **is** visible/killable (`/bashes` menu, or `/tasks`, or the `TaskStop` tool / "kill bash_N")
  — exactly the UX #6 asks for. **[DOC/GH]**
- BUT current Claude Code (≥ 2.1.139) has shifted to a **daemon + `bg-pty-host`** architecture for
  *background sessions/agents*. That machinery reparents to launchd (PID 1). We must prove the
  **in-turn `run_in_background` Bash path does NOT route through it** (it almost certainly doesn't —
  different code path — but this is the risk to retire, §3/§6). **[GH]**
- Teardown is favourable: Claude Code sends **SIGTERM before SIGKILL** to background shell
  subprocesses on session teardown (v2.1.172) **[GH]**, so a daemon launched this way gets a clean
  shutdown signal it can trap.

**Recommendation:** Pursue a **hybrid**, not a rip-and-replace. Keep the MCP host as the
*trust-anchored, lineage-guaranteed* daemon host (it is proven to work), and add a **thin,
visible "indicator" background Bash task** that the user sees and can kill, whose death the daemon
treats as a stop signal. Only collapse to a single background-Bash-hosted daemon **after** the §6
test plan proves the background-Bash lineage retains cmux trust on the user's exact Claude Code +
cmux versions. Replies never needed MCP (Stop hook → HTTP POST), so MCP is droppable *in principle*
— but it is currently our only **guaranteed** lineage anchor, so we drop it last, behind a test.

---

## 1. Why it's invisible today (grounded in this repo)

The daemon is hosted inside the plugin's MCP server (`src/daemon/mcp-server.ts`). The chain:

- `.claude-plugin/plugin.json` registers an `mcpServers.voice-control` entry → Claude Code spawns
  `node dist/daemon/mcp-server.js` **as a child of the Claude process**. That child inherits
  Claude's environment (so `CMUX_SURFACE_ID`, `CMUX_SOCKET_PATH`, `CLAUDE_PLUGIN_DATA` are visible)
  and sits inside cmux's process tree, which is what earns it cmux **socket trust** (see §4).
- `/voice-control:start` (`skills/start/SKILL.md`) does **not** spawn anything. It just
  `touch`es `$CLAUDE_PLUGIN_DATA/active` and polls for `runtime.json`. The MCP server polls that
  flag every 1 s (`setInterval(pollFlag, 1000)`) and, on a rising edge, calls `activate()` →
  `new VoiceDaemon(...).start()` (`reconcile.ts`).
- The daemon opens (a) a localhost HTTP listener for the Stop hook and (b) a WebSocket to the
  Cloudflare bridge. Replies flow **Stop hook → `POST 127.0.0.1:<port>/reply` → daemon → TTS →
  bridge** (`hooks/stop-notify.mjs` + `voice-daemon.ts#startHookListener`). **No MCP tool is ever
  called.** The MCP server is *purely* a lineage-preserving, long-lived host.

So "start" is a flag flip, not a process the user can see in `/bashes`. There is nothing to kill but
"end the whole Claude session" (which does tear the MCP child down — it dies with Claude).

**Consequence for #6:** we want a process artifact the user can *point at* ("voice is on, here it
is") and *kill* ("turn voice off") without ending Claude. A background Bash task is the natural
candidate because Claude Code surfaces those in a first-class UI.

---

## 2. Q1 — Does a background Bash task stay in the Claude process tree (so it keeps cmux trust)?

This is the make-or-break question. Summary: **yes, while the session is alive** — but it is
**undocumented at the OS level** and must be confirmed (§6).

### What's documented [DOC]
- The Bash tool's `run_in_background: true` "start[s] the command as a background task" and
  "List and stop background tasks with `/tasks`." (Tools reference, *Bash tool behavior*.) The
  older surface for the same thing is `/bashes` (an interactive menu of background **shells**); both
  refer to the same background-shell mechanism. Tooling: `TaskStop` (kills a background task by ID),
  `TaskOutput` (deprecated; prefer `Read` on the task's output file), and the `Monitor` tool (a
  related "run in background, stream lines back" primitive).
- The docs do **not** state the spawn mechanism (detached? setsid? process group?) or the PPID. That
  is the gap §6 closes.

### What the GitHub record reveals [GH] — the decisive evidence
- **Issue #43944** ("Background processes started by Bash tool are not cleaned up on session exit"):
  > "Session ends … → **The shell wrapper exits, but child Node processes are reparented to PID 1** →
  > Processes run indefinitely until manually killed."

  This is the key sentence. It says the background process is **a child of Claude's shell wrapper**
  *during* the session, and only **reparents to PID 1 on session exit**. Reparenting *on exit* is
  exactly POSIX orphan behaviour for a process that **was** a descendant. ⇒ **While the interactive
  session is alive, a `run_in_background` Bash task is inside the Claude process tree.** That is the
  property we need for cmux trust. **[INFER from GH, high confidence.]**

- **Changelog v2.1.172:** "Improved background-session teardown (`claude rm`/`stop`, idle reap) to
  send **SIGTERM to running shell subprocesses before SIGKILL**, so cleanup handlers run." ⇒ Claude
  Code **tracks the PIDs of background shell subprocesses and signals them**. A daemon launched as a
  background Bash can trap SIGTERM and tear down cleanly. **[GH]**

- **Changelog v2.1.163:** "background shells are now stopped ~5 s after the result once stdin
  closes" — this is **`claude -p` (print/non-interactive) only**. It does **not** apply to an
  interactive cmux session (stdin stays open). Important so we don't expect our daemon to be reaped
  5 s after a turn. **[GH]**

### The caveat that creates the risk: the daemon / `bg-pty-host` architecture [GH]
Recent Claude Code (≥ ~2.1.123, hard from 2.1.139) introduced a **persistent local daemon**
(`claude daemon run`) with **`bg-pty-host`** and **`bg-spare`** helper processes, used for
**background *sessions* / agents** (`/background`, `claude --bg`, agent fleets). Multiple issues
(#59065, #59848, #62308, #58353) show those helpers **reparented to launchd (PID 1)** and *detached*
from the foreground session. Example `ps` chain from #59065:

```
launchd (1)
 └─ claude --bg-pty-host …       (PPID 1 — daemonized)
     └─ claude --bg-spare …
         └─ /bin/zsh             (a background-session shell)
```

**Why this matters:** if an in-turn `run_in_background` Bash were *also* routed through the daemon /
`bg-pty-host`, it would be **reparented away from the interactive Claude process and lose cmux
trust** — the exact `nohup` failure we're trying to avoid. The evidence says it is a **different
code path** (issue #43944 describes the in-turn case as a child of *Claude's shell wrapper*, not the
daemon), but the two have converged enough in recent versions that **we must verify on the user's
build** before betting the session on it. This is the single biggest unknown in #6.

**Conclusion for Q1:** A `run_in_background` Bash task is, to the best public evidence, a descendant
of the interactive Claude process and therefore inside cmux's process tree (unlike `nohup`, which
reparents immediately). Confidence is high but not certain because (a) the OS spawn mechanism is
undocumented and (b) the daemon architecture is an active, fast-moving area. §6 settles it
empirically in one minute.

---

## 3. Q2 — Can a plugin **skill** launch a process that appears in `/bashes` and is killable?

**Yes — with one important nuance.** `/bashes` (a.k.a. background shells) and `/tasks` list the
background tasks the **Bash tool** started, *regardless of who told Claude to run them*. A skill is
just a prompt: `skills/start/SKILL.md` already has `allowed-tools: Bash` and instructs Claude to run
shell. If that skill instructs Claude to run a long-lived command with the Bash tool's
`run_in_background`, **that task is an ordinary background Bash task** — same mechanism, same
`/bashes`/`/tasks` entry, same `TaskStop`/kill controls. There is no separate "skill-owned vs
Claude-owned" class of background task. **[DOC + INFER; confirm in §6, Test C.]**

### The nuance: a *markdown skill body is instructions to the model*, not a literal exec
The skill cannot itself "fork a process." It must persuade Claude to **call the Bash tool with
`run_in_background: true`**. Two consequences:

1. **`disable-model-invocation: true` is fine** — it only stops the *model* from auto-invoking the
   skill; the user still triggers it with `/voice-control:start`, and Claude then runs the steps.
2. **`run_in_background` is the Bash *tool's* parameter, not a shell construct.** The skill body must
   make Claude background the command *via the tool*, not via shell `&`/`nohup` (which would detach
   to launchd and lose trust). In practice the skill prompt would say e.g. *"Run this command in the
   background (do not append `&`); keep it running."* and the long-running command itself must
   genuinely not return (otherwise the task immediately completes and disappears from `/bashes`).
   **[INFER — the exact phrasing that reliably makes Claude background a command is a UX detail to
   nail in §6, Test C.]**

3. **Determinism caveat.** Because it routes through the model, "did it actually background it?" is
   probabilistic in a way the MCP-host flag-flip is not. The hybrid in §5 keeps the *daemon* on the
   deterministic MCP path and uses the background Bash only as a **visible indicator + kill switch**,
   so a flaky backgrounding degrades the UX (no visible chip) but never the core session.

**Achievable for a plugin:** a `/voice-control:start` skill *can* produce a real, user-visible,
user-killable `/bashes` entry. What it cannot do is *guarantee* it the way a config-file/MCP poll
can, and it cannot bypass the model to do a raw `exec`.

---

## 4. The trust model we must not break (cmux `socketControlMode: cmuxOnly`)

cmux is a native macOS terminal multiplexer with a Unix-socket CLI (`cmux send`, `cmux send-key`,
`cmux read-screen`, `list-surfaces --json`, …) and exports `CMUX_SURFACE_ID`, `CMUX_WORKSPACE_ID`,
`CMUX_SOCKET_PATH` into each pane (cmux docs). The user's `socketControlMode` is **`cmuxOnly`**: the
default, "restricts socket access to cmux-owned processes." Empirically (this repo's hard-won
history, `cmux.ts` + `voice-daemon.ts` comments) that trust is **process-tree based**: a process
inside the cmux pane's tree is trusted; a `nohup &` daemon reparented to launchd PID 1 is **rejected
with "Broken pipe."**

> ⚠️ **Hard rule (per project memory):** never propose changing cmux's config. `cmuxOnly` is the
> user's setting and is off-limits. The plugin must work unmodified. Every design here keeps the
> trusted process *inside* the tree rather than relaxing cmux.

**The cmux docs do not explicitly state that `cmuxOnly` trust is process-tree-membership.** They say
only "cmux-owned processes." The repo's lived evidence (the Broken-pipe bug) is the authority here.
§6 Test D re-confirms it for the background-Bash case on the user's machine. **[INFER from repo
history; cmux docs are silent on the mechanism.]**

Implication: a background-Bash-hosted daemon is trust-safe **iff** it stays a descendant of the
interactive Claude process (which is a descendant of the cmux pane). Q1 says it does, while alive.

---

## 5. Q3 — Design: launch the daemon as a visible, killable background task

Three options, in increasing ambition. I recommend **Option B (hybrid)** to ship #6 safely, with a
clear path to **Option C** once §6 de-risks it.

### Option A — Pure indicator (smallest, zero risk to the working daemon)
Keep the daemon exactly where it is (MCP host). Have `/voice-control:start` *additionally* launch a
trivial, long-lived **background Bash** whose only jobs are to (a) be visible in `/bashes`/`/tasks`
as "voice-control: ON" and (b) act as a **kill switch**. Concretely, a tiny shell loop:

```sh
# launched by the start skill via the Bash tool with run_in_background: true
# It is the visible "voice is active" chip AND the kill switch.
echo "voice-control: session active — kill this task (/bashes → k, or 'kill bash_N') to stop voice"
trap 'rm -f "$CLAUDE_PLUGIN_DATA/active"; echo "voice-control: stopping"; exit 0' TERM INT
while [ -f "$CLAUDE_PLUGIN_DATA/active" ]; do sleep 1; done
echo "voice-control: stopped"
```

- **Visible:** it shows in `/bashes`/`/tasks` with a human label.
- **Killable → clean stop:** killing it (the trap) removes the `active` flag; the **MCP server's
  existing reconcile poll** sees the flag gone and calls `deactivate()` → `daemon.stop()`, which
  already closes the WS + HTTP server, sends `terminate` to the bridge, and removes
  `runtime.json`/`qr.txt`. **We reuse the entire existing teardown path.** The trap also covers
  Claude Code's SIGTERM-before-SIGKILL teardown (v2.1.172), so even an ungraceful session end flips
  the flag.
- **Also self-heals the inverse:** if the user runs `/voice-control:stop` (removes `active`), the
  `while` loop exits on the next tick and the indicator disappears on its own.
- **Risk: essentially none.** This task does not need cmux trust (it never talks to cmux); it only
  watches a file. So even if Q1's lineage claim were wrong, Option A still works — the *daemon*
  keeps its proven MCP lineage; the Bash task is just a flag-watching chip.

**This is the recommended first vertical slice for #6.** It delivers the visible + killable UX with
zero risk to the working session, and it makes the MCP host's invisibility moot.

### Option B — Hybrid: daemon on MCP, *control* on background Bash (recommended target)
Option A, but make the indicator script the **single source of truth for "voice on"**: the skill
flips `active` *by launching the Bash task* (the task `touch`es the flag on start, removes it on
trap). This makes the visible task and the session lifecycle one and the same — the user's mental
model ("kill the task = stop voice") is exactly right, and there is exactly one visible artifact.
The daemon still runs under the MCP host (trusted, deterministic). Net effect: we get #6's UX with
the reliability of the current architecture.

### Option C — Full: background Bash **hosts** the daemon; drop the MCP server
The end-state #6 hints at: `/voice-control:start` launches the **daemon itself** as a background
Bash task (`node dist/daemon/standalone.js`, a new thin entry that does what `activate()` does), and
we **delete the MCP server** entirely.

- **Replies still work without MCP** — confirmed: the reply path is Stop hook → HTTP POST, not MCP
  (`hooks/stop-notify.mjs`, `voice-daemon.ts`). So MCP is genuinely unnecessary for function.
- **Teardown:** the daemon already has `VoiceDaemon.stop()`. As a standalone process it must install
  `process.on('SIGTERM'|'SIGINT', () => { daemon.stop(); process.exit(0); })` (the MCP server's
  `shutdown()` already does this for the MCP case). v2.1.172's SIGTERM-first teardown means the
  daemon gets to run `stop()` (close WS + HTTP, `terminate` the bridge, rm runtime/qr) before
  SIGKILL.
- **The catch — orphaning (#43944):** on a *plain interactive exit* (not `/stop`, not idle-reap),
  the GitHub record says in-turn background Bash processes can be **orphaned to PID 1 rather than
  killed**. For our daemon that means: close Claude's pane without `/voice-control:stop` and the
  daemon could keep running, reparented to launchd — at which point it has **lost cmux trust** (now
  a child of PID 1) and injection breaks, but the WS/bridge may stay up showing a "live" but
  deaf session. We'd need a **liveness guard**: the daemon already polls cmux health
  (`cmuxHealth`, 5 s); extend it to **self-terminate** if it detects it has been reparented (e.g.
  `process.ppid === 1` on Linux/macOS, or a sustained positive "pane gone" verdict). The existing
  optimistic-health logic must be tightened for this mode so an orphan reaps itself.
- **Risk:** this is the version that *requires* Q1 to hold (background Bash keeps cmux trust while
  alive) AND requires the orphan-self-reap guard. Do **not** ship Option C until §6 confirms both.

### Can the MCP host be dropped entirely?
**Functionally yes** (replies don't use it). **Operationally, drop it last**, because today it is the
**only guaranteed in-tree, deterministic host**. The safe sequence: ship A → B (MCP still hosts the
daemon, Bash is the visible control) → run §6 → if green, build the standalone entry + orphan guard
and move to C, deleting the MCP server. If §6 is red (background Bash loses trust on the user's
build), **stay on B forever** — it already delivers #6's user-visible goal.

---

## 6. Q4 — Empirical TEST PLAN (run in the real cmux Claude session)

> You cannot test this in the doc-writing sandbox (it kills detached processes and has no live cmux
> pane). Run these in your **real** Claude Code session **inside a cmux pane**, with the plugin
> loaded. Each test is copy-pasteable; the "look for" line is the pass/fail signal.

### Test A — Does a `run_in_background` Bash task stay a child of Claude (NOT PID 1)? *(the crux)*
Ask Claude, in the cmux Claude pane:

> Run this command **in the background** (use the Bash tool's run_in_background — do NOT append `&`
> or use nohup):
> ```sh
> echo "marker $$ ppid=$PPID"; while true; do sleep 5; done
> ```

Then, in a **separate** normal shell (another cmux pane or Terminal), inspect the lineage of that
sleep loop:

```sh
# find the backgrounded loop and walk its parent chain to PID 1
pgrep -af 'while true; do sleep 5' || ps -axo pid,ppid,command | grep -i 'sleep 5'
# then, with its PID:
P=<pid-from-above>
while [ "$P" -gt 1 ]; do ps -o pid=,ppid=,command= -p "$P"; P=$(ps -o ppid= -p "$P" | tr -d ' '); done
```

- **PASS (Option C viable):** the chain climbs through a `claude` / node process that is the
  interactive session, i.e. PPID is **the Claude process (or a shell wrapper that is itself a child
  of Claude)**, *not* `1`, and *not* `claude --bg-pty-host` reparented to 1.
- **FAIL (stay on Option A/B):** the immediate parent is `1` (launchd) or `claude --bg-pty-host`
  (the daemon path) — it has detached, like `nohup`. Background-Bash hosting would lose cmux trust.
- Also note the value printed by `echo "... ppid=$PPID"` (the BashOutput) — `$PPID` inside the task
  is the spawner Claude Code used; if it's `1`, that alone is a FAIL.

### Test B — Does the backgrounded task inherit Claude's env (cmux vars)?
With the same task still running, ask Claude:

> Run in the background: `env | grep -E 'CMUX_|CLAUDE_PLUGIN_DATA' ; while true; do sleep 5; done`

…and read its BashOutput (`/bashes` → select → output, or `Read` the task output file).

- **PASS:** `CMUX_SURFACE_ID`, `CMUX_SOCKET_PATH`, `CLAUDE_PLUGIN_DATA` are present. (Needed for a
  standalone daemon to find the pane + state dir.) **[Confirms the §3 env-inheritance assumption.]**
- **FAIL:** they're absent → a standalone background-Bash daemon couldn't resolve the surface; we'd
  have to pass them through the skill explicitly, or stay on the MCP host (which inherits them).

### Test C — Can the start skill make a visible, killable `/bashes` entry, and does killing it stop voice?
Implement Option A's indicator loop as a temporary skill step (or just ask Claude to background it),
then:

```sh
# in the cmux Claude pane, after /voice-control:start launched the indicator:
/bashes        # (or /tasks)  → confirm a "voice-control: session active" entry is listed
```

- Kill it from the `/bashes` menu (select → `k`), **or** tell Claude "kill bash_N", **or** use
  `TaskStop`.
- **PASS:** the entry appears with a readable label; killing it removes `$CLAUDE_PLUGIN_DATA/active`
  (verify: `ls "$CLAUDE_PLUGIN_DATA"`), the phone page goes offline within a few seconds, and
  `runtime.json`/`qr.txt` are gone. (The MCP reconcile poll did the teardown.)
- **FAIL:** no entry (Claude ran it foreground or with `&`), or killing it didn't flip the flag
  (trap not firing) → refine the skill prompt / trap signals.

### Test D — Does `cmux send` still work *from* a background-Bash-hosted process? *(trust check, only if Test A passed)*
Only run this if Test A passed. Launch a background Bash that tries to use cmux against its own pane:

```sh
# background task body:
echo "surface=$CMUX_SURFACE_ID"; \
cmux ${CMUX_SOCKET_PATH:+--socket "$CMUX_SOCKET_PATH"} read-screen --surface "$CMUX_SURFACE_ID" --lines 1 \
  && echo "CMUX-TRUST-OK" || echo "CMUX-TRUST-DENIED"; \
while true; do sleep 5; done
```

(Mirror `cmux.ts`: clear `CMUX_WORKSPACE_ID` for global surface resolution — prepend
`env -u CMUX_WORKSPACE_ID` to the `cmux` call.)

- **PASS:** prints `CMUX-TRUST-OK` (and no "Broken pipe") → a background-Bash-hosted daemon **keeps
  cmux trust** → Option C is safe to build.
- **FAIL:** `CMUX-TRUST-DENIED` / Broken pipe → cmux rejects it (it's effectively detached) → **stay
  on Option B**; the daemon must remain on the MCP host.

### Test E — Orphan behaviour on session end (informs the Option C self-reap guard)
With a background task running, **close the cmux Claude pane / exit Claude without `/voice-control:stop`**.
Then from another shell:

```sh
pgrep -af 'while true; do sleep 5'   # is the loop still alive? what's its PPID now?
```

- If it **survives with PPID 1** → confirms #43944's orphaning. Option C **must** include the
  daemon-self-reap guard (detect reparent-to-1 / sustained pane-gone → `daemon.stop()` + exit).
- If it's **gone** → Claude Code reaped it (SIGTERM/SIGKILL); the orphan guard is a belt-and-braces
  nicety but less critical.

### What "green light for Option C" means
A → C is justified only if **Test A = PASS, Test D = PASS** (trust survives), and you've added the
**orphan self-reap guard** validated against **Test E**. Test B decides whether the standalone
daemon needs env passthrough. If A or D is red, **B is the shipping design** and still satisfies #6.

---

## 7. Risks & unknowns (ranked)

1. **[CRITICAL] Background-Bash lineage / cmux trust is unverified on the user's build.** The whole
   "host the daemon in a background Bash" idea (Option C) rests on Test A + D. The daemon-/`bg-pty-
   host`-architecture (≥ 2.1.139) is a live regression risk: a future Claude Code could route
   in-turn `run_in_background` through the reparented daemon path and silently break trust. **Mitigation:**
   ship A/B (which don't depend on it); gate C behind the test plan; pin behaviour to the user's CC
   version in the doc when tested.
2. **[HIGH] Orphaning on plain session exit (#43944).** A standalone daemon could outlive Claude as a
   PID-1 orphan that's lost cmux trust but still holds the bridge socket — a "zombie deaf session."
   **Mitigation:** self-reap guard (`ppid===1` / sustained pane-gone → stop). Option A/B sidestep
   this entirely (the daemon dies with the MCP child).
3. **[MED] Model-mediated backgrounding is probabilistic.** A skill can't `exec`; it must convince
   Claude to call the Bash tool with `run_in_background`. The model might run it foreground, or with
   `&`. **Mitigation:** explicit skill wording + a self-check step ("confirm it appears in
   `/bashes`"); keep the daemon off this path in A/B so a miss is cosmetic, not fatal.
4. **[MED] `/bashes` vs `/tasks` naming + versions.** Both exist; `/tasks` is the current docs term,
   `/bashes` the background-shells menu. The skill copy should mention both so the instruction
   doesn't go stale. (Don't hardcode one in user-facing text.)
5. **[LOW] cmux trust mechanism is repo-lore, not cmux-documented.** cmux docs say only "cmux-owned
   processes," not "process-tree membership." Our evidence is the Broken-pipe bug. If cmux ever
   changes the trust model, retest. (We must not touch cmux config regardless.)
6. **[LOW] `-p`-mode 5 s reaping (v2.1.163) is irrelevant** to interactive cmux sessions, but worth
   noting so nobody mis-attributes a daemon death to it.

---

## 8. Recommended path (concrete)

1. **Ship Option A now** — add an indicator background-Bash step to `skills/start/SKILL.md` (launch
   the flag-watching loop in the background; document killing it). Zero risk; delivers #6's
   "visible + killable" immediately. The MCP host keeps running the daemon.
2. **Fold into Option B** — make that task the lifecycle owner (it sets/clears `active`), so there's
   one visible artifact = the session. Update `/voice-control:stop` copy to mention killing the task
   as an equivalent way to stop.
3. **Run §6 (Tests A–E)** in the live cmux session. Record results + CC/cmux versions in this doc.
4. **If green → Option C:** add `dist/daemon/standalone.js` (does `activate()`'s work, traps
   SIGTERM/SIGINT → `daemon.stop()`), add the orphan self-reap guard, switch the skill to launch the
   daemon directly as a background Bash, and **delete the MCP server** (`mcp-server.ts`, the
   `mcpServers` block in `plugin.json`). Replies keep working via the Stop hook → HTTP POST.
5. **If red → stay on Option B.** It already satisfies #6.

---

## Sources

Official Claude Code docs (verified 2026-06-20):
- Tools reference — Bash tool behavior, `run_in_background`, `/tasks`, `TaskStop`/`TaskOutput`,
  `Monitor`: https://code.claude.com/docs/en/tools-reference
- Commands reference — `/tasks` ("lists what's running in the background of the current session"),
  `/background`, `/btw`: https://code.claude.com/docs/en/commands
- Skills — `allowed-tools`, `disable-model-invocation`, invocation control:
  https://code.claude.com/docs/en/skills
- Changelog — v2.1.172 (SIGTERM-before-SIGKILL teardown), v2.1.163 (`-p` 5 s reap on stdin close),
  v2.1.154 (teammate bg tasks killed on turn end): https://code.claude.com/docs/en/changelog

anthropics/claude-code GitHub (behavioural evidence; not normative):
- #43944 — Bash-tool background processes not cleaned up on session exit ("child Node processes are
  reparented to PID 1"): https://github.com/anthropics/claude-code/issues/43944
- #59065 — bg-pty-host children + macOS TCC; shows `bg-pty-host` PPID 1 daemonization:
  https://github.com/anthropics/claude-code/issues/59065
- #59848 — interactive sessions classified as bg post-2.1.139; daemon/bg-spare/bg-pty-host tree:
  https://github.com/anthropics/claude-code/issues/59848
- #62308 — `--bg-pty-host` CPU spin; daemon + bg-pty-host architecture:
  https://github.com/anthropics/claude-code/issues/62308
- #58353 — bg agents spawned by claude daemon: https://github.com/anthropics/claude-code/issues/58353

cmux:
- Configuration (socketControlMode values, `cmuxOnly` default):
  https://cmux.com/docs/configuration
- CLI/API (send, send-key, new-split, --surface/--workspace/--socket, CMUX_* env vars):
  https://cmux.com/docs/api

Repo evidence (this codebase, the authority on cmux trust): `src/daemon/cmux.ts`,
`src/daemon/voice-daemon.ts`, `src/daemon/mcp-server.ts`, `skills/start/SKILL.md`,
`hooks/stop-notify.mjs`.
