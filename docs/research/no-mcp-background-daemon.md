# Research: Drop the MCP server — run the voice daemon as a single visible, killable background task

**Status:** Research / design only — no implementation, no code changes. (Supersedes the
hedged recommendation in `visible-background-process.md`; this doc is decisive.)
**Date:** 2026-06-20.
**Author env:** Claude Code **2.1.183**, cmux.app, `socketControlMode: cmuxOnly` (probed live, §2).

**The goal (decisive):** delete the MCP server entirely and run the voice daemon as **one
visible, killable background task inside the Claude Code session** (the kind shown in
`/bashes` / `/tasks`). The MCP host is disliked: opaque UX, no signal that voice is live, and
`/mcp` shows a **warning icon** next to `voice-control` even though it works. This doc
diagnoses that warning, settles the lineage question empirically, and specifies the no-MCP
design end-to-end.

Evidence tags: **[DOC]** official Claude Code docs, **[GH]** anthropics/claude-code issues/
changelog, **[PROBE]** measured live in this environment today, **[REPO]** this codebase.

---

## 0. TL;DR — VERDICT

**GO on the no-MCP design (Option C), pending ONE live test in the user's real cmux pane (§4).**

- **Why `/mcp` warns (root-caused):** Claude Code's `/mcp` panel **"flags servers that advertise
  the tools capability but expose no tools."** **[DOC]** Our server does *exactly* that — in
  `initialize` it returns `capabilities: { tools: {} }` (advertises the tools capability) and in
  `tools/list` returns `{ tools: [] }` (zero tools). That is the documented trigger, verbatim. The
  warning is **not a bug in our server and not fixable while staying an MCP server** — it is the
  intended UI for a tools-capable server with no tools. This alone justifies dropping MCP: our host
  was never a tools provider, it was only ever a lineage anchor. **[DOC + REPO]**
- **The decisive lineage fact (now measured, not inferred):** a `run_in_background: true` Bash task
  **stays a child of the interactive `claude` process while the session is alive** and does **not**
  reparent to launchd or route through `bg-pty-host`. **[PROBE]** I ran the probe as a real
  background task in this environment; its parent chain climbed cleanly `… → claude → cmux → PID 1`,
  and all `CMUX_*` env was inherited (raw output in §2). The two paths the prior doc worried about
  are **confirmed different code paths** (§2.3). Caveat: this harness is not the user's interactive
  cmux pane (env quirks noted), so §4 is the one confirmation that remains.
- **MCP is functionally unnecessary:** replies flow **Stop hook → HTTP POST → daemon**, never through
  an MCP tool (`hooks/stop-notify.mjs`, `voice-daemon.ts#startHookListener`). Nothing the daemon does
  requires MCP. **[REPO]**
- **Teardown is favourable:** Claude Code sends **SIGTERM before SIGKILL** to background shell
  subprocesses on teardown (v2.1.160) **[GH]**, so a standalone daemon can trap SIGTERM and run
  `VoiceDaemon.stop()` cleanly.
- **One residual risk, fully mitigated in the design:** on a *plain* interactive exit, an in-turn
  background task can be **orphaned to PID 1** instead of killed (#43944) **[GH]**. The design adds an
  **orphan self-reap guard** (§3.4) so a daemon that loses its Claude parent detects it and exits.

If §4 passes (it almost certainly will on 2.1.183), build Option C and delete `mcp-server.ts` + the
`mcpServers` block. If §4 fails, the daemon must stay hosted in-tree some other way — but every
public + measured signal points to PASS.

---

## 1. WHY `/mcp` shows a warning for OUR server — concrete diagnosis

### 1.1 The documented trigger (the answer)
The official MCP docs state, verbatim **[DOC, https://code.claude.com/docs/en/mcp]**:

> **"The `/mcp` panel shows the tool count next to each connected server and flags servers that
> advertise the tools capability but expose no tools."**

This is a deliberate UI affordance, not an error: a server that *says* "I have tools"
(`capabilities.tools`) but *lists none* is almost always misconfigured, so Claude Code surfaces it
with a warning/caution marker next to the otherwise-connected server.

### 1.2 Our server hits it exactly
`src/daemon/mcp-server.ts` (lines 99–107) does both halves of the trigger:

```ts
case "initialize":
  reply(msg.id, {
    protocolVersion: msg.params?.protocolVersion || "2024-11-05",
    capabilities: { tools: {} },          // ← ADVERTISES the tools capability
    serverInfo: { name: "voice-control", version: "1.0.0" }
  });
  return;
case "tools/list":
  reply(msg.id, { tools: [] });           // ← EXPOSES ZERO tools
  return;
```

So `voice-control` connects fine (it answers `initialize`, `tools/list`, `ping`), the panel shows it
as connected with **`0 tools`**, and — because it advertised `capabilities.tools` while listing none
— Claude Code **flags it**. That is the warning the user sees. **[DOC + REPO]**

### 1.3 Other candidate causes — ruled out (so we're sure it's 1.2)
The user asked for the *most likely concrete cause(s)*. I checked the alternatives:

- **Protocol-version mismatch** — *not it.* The server echoes the client's `protocolVersion` (or a
  valid default `2024-11-05`), so negotiation succeeds. A mismatch would show **failed**, not a
  warning. **[DOC: failed-vs-warning are distinct states.]**
- **Slow init / connect timeout** — *not it.* The server replies to `initialize` synchronously on the
  first stdin line; it connects well within the 5 s connect budget. A timeout marks the server
  **failed/pending**, not connected-with-warning. **[DOC]**
- **stderr noise** — *not it.* `mcp-server.ts` tees *all* logs to stderr (and a file), and Claude Code
  only captures MCP stderr up to the handshake (per the code's own comment). stderr after connect is
  ignored; it does not produce a `/mcp` warning. **[REPO comment + DOC]**
- **stdout pollution** — *not it, and well-guarded.* stdout is the JSON-RPC channel; the server
  overrides `console.log → console.error` (line 39) so nothing stray reaches stdout. Pollution would
  cause parse failures / **failed**, not a warning. **[REPO]**
- **OAuth / auth (401/403)** — *not applicable* to a local stdio server. **[DOC]**

**Conclusion:** the warning is the **zero-tools-but-tools-capable** flag (§1.1/§1.2), full stop. It
is *expected behaviour for a server shaped like ours* and cannot be removed while we remain an MCP
server **except** by not advertising `capabilities.tools` — and even a no-capabilities server is a
degenerate MCP server that exists only to stay alive, which is precisely the smell the user objects
to. **The clean fix is to stop being an MCP server.** This diagnosis is itself a first-class argument
for the no-MCP design.

### 1.4 How to confirm in 5 seconds (for the user)
Run `/mcp`, select `voice-control`. Expected: status **connected**, **`Tools: 0`** (or "no tools"),
with the caution/warning marker. Cross-check with `claude mcp list` — it will list `voice-control`
as connected, not failed. Seeing "connected + 0 tools + flagged" confirms §1.2.

---

## 2. THE decisive fact — does an in-turn background Bash task keep Claude lineage (and cmux trust)?

The prior doc rated this "high confidence yes, but unconfirmed." **I measured it.**

### 2.1 The live probe (raw result) **[PROBE]**
I launched a script as a real `run_in_background: true` Bash task in *this* Claude Code session
(v2.1.183) that recorded its own PID, walked its full parent chain to PID 1 via
`ps -o pid,ppid,comm`, dumped the `CMUX_*`/`CLAUDE_*` env, slept 8 s, then re-read its PPID to catch
any reparent. Raw output:

```
self_pid=47311
self_PPID_env=47308

--- parent chain to PID 1 (pid ppid comm) ---
47311 47308 /bin/sh                                   ← the background task
47308 36470 /bin/zsh                                  ← its parent shell
36470   972 /Users/honza/.local/bin/claude           ← THE INTERACTIVE CLAUDE PROCESS
  972   966 -/bin/zsh
  966   716 /usr/bin/login
  716     1 /Applications/cmux.app/Contents/MacOS/cmux ← cmux owns the tree; parent is PID 1
   1                                                   ← launchd

--- inherited env (cmux + plugin) ---
CMUX_SURFACE_ID=FD023DCC-D3CE-40F2-87E3-84D68397DF69
CMUX_SOCKET_PATH=/Users/honza/Library/Application Support/cmux/cmux.sock
CMUX_WORKSPACE_ID=A972E3A3-A9A0-42E5-A45A-A0887AF10585
CLAUDE_PLUGIN_DATA=/Users/honza/.claude/plugins/data/codex-openai-codex   ← see caveat
CLAUDE_PLUGIN_ROOT=<UNSET>                                                 ← see caveat
CLAUDECODE=1
CLAUDE_CODE_ENTRYPOINT=cli

--- re-check PPID after 8s sleep ---
self_pid=47311 ppid_now=47308    ← UNCHANGED: no reparent while the session lived
```

**Reading of the result — this is the hard fact we needed:**
- The background task's parent chain climbs **through the interactive `claude` process (PID 36470)**
  and then to **cmux.app (PID 716)**, whose own parent is `1`. The task's *immediate* parent is a
  zsh that is itself a child of `claude`. It is **firmly inside cmux's process tree**, exactly like
  the MCP child is today. It is **NOT** a child of PID 1, and **NOT** a child of `claude --bg-pty-host`.
- **No reparent during the session:** PPID was `47308` before and after the sleep.
- **cmux env is inherited:** `CMUX_SURFACE_ID`, `CMUX_SOCKET_PATH`, `CMUX_WORKSPACE_ID` all present —
  everything a standalone daemon needs to resolve and inject into the pane (`cmux.ts` reads exactly
  these).

### 2.2 Caveats on the probe (so it's a data point, not a claim of proof)
- **This is the research harness, not the user's interactive cmux Claude pane.** Per repo lore the
  Bash *tool* sandbox in some environments relocates/kills detached procs; here it did not, and the
  lineage is real, but the *only* fully authoritative environment is the user's live pane → §4.
- **`CLAUDE_PLUGIN_DATA` points at `codex-openai-codex` and `CLAUDE_PLUGIN_ROOT` is UNSET** in this
  harness. That is because this session is *not* running with the voice-control plugin as the active
  plugin context — it's a generic agent shell. In the user's real session launched with the plugin,
  `CLAUDE_PLUGIN_DATA`/`CLAUDE_PLUGIN_ROOT` are set to voice-control's dirs (that's how the daemon and
  hooks resolve state today). The takeaway: **env *inheritance* works; the specific plugin values are
  a function of how the session was launched**, and §4 re-checks them in the real pane.
- **One nuance for Option C:** the background task here got `CLAUDE_PLUGIN_ROOT=<UNSET>`. The standalone
  launch command must therefore **not rely on `$CLAUDE_PLUGIN_ROOT` being present in the Bash
  environment** — but it doesn't need to: the *skill* runs with `${CLAUDE_PLUGIN_ROOT}` substituted by
  Claude Code into the skill body (same mechanism `hooks.json` uses today), so the path is baked into
  the command string the model runs, not read from the child's env. §3.2 accounts for this.

### 2.3 In-turn background Bash vs the `bg-pty-host` daemon — CONFIRMED different code paths
This was the prior doc's "central risk." It is now retired with direct evidence.

- **In-turn `run_in_background` (our path).** Issue **#43944** describes it precisely **[GH]**:
  > *"The shell wrapper exits, but child Node processes are reparented to PID 1 … the spawned Node
  > processes get reparented to PID 1 (launchd on macOS) and continue running indefinitely."*

  Reparenting **on exit** is ordinary POSIX orphan behaviour for a process that **was a descendant**.
  It confirms the task is a child of *Claude's shell wrapper during the session* (matching my probe),
  and only detaches *when the session ends*. ⇒ While alive, it's in-tree and cmux-trusted.

- **Background *sessions / agents* (`bg-pty-host` / `bg-spare`).** A *different* mechanism, triggered
  by `/background`, `claude --bg`, agent view / teams / workflows (≥ 2.1.139). Issue **#59065** **[GH]**:
  > *"The `bg-pty-host` daemon is daemonized and reparented to launchd (PPID 1) **before** forking the
  > `bg-spare` child. From the `bg-spare`'s perspective there is no foreground app in the parent
  > chain."*

  Here reparent-to-launchd happens **at spawn, by design** — the opposite of the in-turn path. Related:
  #59848 (interactive sessions mis-classified as bg post-2.1.139), #61740 (bg-spare orphans),
  changelog 2.1.154/2.1.166 (orphaned `--bg-pty-host` CPU spin). **[GH]**

  **Crucially, an ordinary `run_in_background: true` Bash call does NOT enter this path.** My probe
  proves it on 2.1.183: had the task gone through `bg-pty-host`, its parent would have been a
  launchd-reparented `claude --bg-…`, not the interactive `claude` (PID 36470). It was the interactive
  claude. The docs back this: `run_in_background` is described purely as "start the command as a
  background task … list and stop with `/tasks`" with no mention of the daemon. **[DOC]**

### 2.4 Plain-English: what is the `bg-pty-host` "reparent-to-launchd" risk? (the user asked)
Claude Code can run whole *background Claude sessions/agents* (the "agent view", `claude --bg`). To
keep those alive independently of your foreground window, it launches a helper called `bg-pty-host`
and **deliberately detaches it so its parent becomes launchd (PID 1)** — i.e. it's no longer a child
of your interactive Claude, on purpose, so it survives you closing the window. **If our voice daemon
were ever spawned through *that* machinery, it would land under launchd too — and cmux's `cmuxOnly`
trust is process-tree based, so a process whose parent is launchd (not in the cmux pane's tree) is
treated like a `nohup &` daemon and rejected with "Broken pipe" when it tries `cmux send`.** The good
news (§2.1–2.3): an in-turn `run_in_background` Bash task does **not** go through `bg-pty-host`; it
stays a child of your interactive Claude, inside cmux's tree, and keeps trust — exactly what we need.

### 2.5 cmux trust model (unchanged, must not be touched) **[REPO + DOC]**
cmux's `socketControlMode: cmuxOnly` "restricts socket access to cmux-owned processes." Repo lore
(the Broken-pipe bug) establishes that "cmux-owned" is **process-tree membership**: a process inside
the cmux pane's tree is trusted; a launchd-reparented one is not. A background-Bash-hosted daemon is
trust-safe **iff** it stays a descendant of the interactive Claude — which §2.1 measured it does.
**Hard rule (project memory): never change cmux config; the plugin must work unmodified.** Every part
of this design keeps the daemon *inside the tree* rather than relaxing cmux.

---

## 3. THE definitive NO-MCP design (Option C, fully specified)

One sentence: **`/voice-control:start` launches `node dist/daemon/standalone.js` as a
`run_in_background: true` Bash task; that process IS the daemon, IS the visible/killable `/tasks`
entry, traps SIGTERM/SIGINT to `VoiceDaemon.stop()`, and self-reaps if it loses its Claude parent.
The MCP server and its `plugin.json` entry are deleted.**

### 3.1 New entry point — `src/daemon/standalone.ts` (does what MCP `activate()` does)
A thin entry that reproduces `mcp-server.ts`'s `activate()` *without* any JSON-RPC/stdio:

```ts
// src/daemon/standalone.ts  (compiles to dist/daemon/standalone.js)
import { mkdirSync } from "node:fs";
import { resolveConfig, stateDir, writeSetupNeededRuntime } from "./config.js";
import { createDaemonInit, VoiceDaemon } from "./voice-daemon.js";
// (reuse mcp-server.ts's console.error→file tee verbatim; see note below)

async function main(): Promise<void> {
  mkdirSync(stateDir(), { recursive: true });
  const result = await resolveConfig();
  if (!result.ok) {
    // No OpenAI key yet: publish onboarding runtime.json and EXIT 0 (task ends → no
    // ghost entry, start skill shows setup help, exactly as today).
    writeSetupNeededRuntime(result);
    console.error(`[standalone] setup needed: ${result.missing} (${result.configPath})`);
    process.exit(0);
  }
  const daemon = new VoiceDaemon(createDaemonInit(result.config));
  await daemon.start();          // opens hook HTTP listener + bridge WS, writes runtime.json + qr.txt
  console.error("[standalone] voice remote active — kill this task (/tasks) to stop voice.");

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[standalone] ${signal} → stopping`);
    daemon.stop();               // closes WS+HTTP, terminates bridge session, rm runtime.json/qr.txt
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));   // Claude Code teardown (v2.1.160)
  process.on("SIGINT",  () => stop("SIGINT"));    // /tasks kill / TaskStop / Ctrl-C
  startOrphanGuard(daemon, stop);                 // §3.4
  // Keep the process alive: VoiceDaemon's timers (cmux health 5s) + WS + HTTP listener
  // are active handles, so Node won't exit. No artificial keep-alive needed.
}
main().catch((e) => { console.error(`[standalone] fatal: ${e?.message ?? e}`); process.exit(1); });
```

Notes:
- **Reuse, don't rewrite.** `VoiceDaemon`, `createDaemonInit`, `resolveConfig`, `writeSetupNeededRuntime`,
  the `stateDir()` layout, and the `console.error→${stateDir}/daemon.log` tee are all reused as-is.
  `standalone.ts` is essentially `activate()` + signal handlers + orphan guard, minus the MCP plumbing.
- **No flag-file / reconcile poll needed.** The whole `active`-flag + `reconcile()` dance existed only
  because the long-lived MCP host had to be told *when* to start/stop a daemon it hosted. With the task
  *being* the daemon, **start = launch the task, stop = kill the task.** `reconcile.ts` and the
  `active`-flag mechanism can be removed (the `ensureRuntimePublished` re-publish hack also goes — the
  daemon writes `runtime.json` once at `start()` and the start skill reads it directly).
- **`VoiceDaemon` already forbids stdout writes** (its class comment). As a standalone process stdout
  is now free, but keeping logs on stderr/file is still correct (the `/tasks` BashOutput shows stderr
  too, and we don't want to spam it). One tidy follow-up: the class comment "never write to stdout …
  JSON-RPC channel" can be relaxed in wording, but behaviour stays.

### 3.2 How `/voice-control:start` launches it (exact skill mechanics)
A markdown skill body is **instructions to the model**, not a literal exec — it cannot fork a process
itself. It must make Claude **call the Bash tool with `run_in_background: true`**. So the rewritten
`skills/start/SKILL.md` (keeps `allowed-tools: Bash`, `disable-model-invocation: true`) instructs:

1. **Launch the daemon as a background task** (the load-bearing step). Wording must be explicit that
   this is the Bash *tool's* background mode, not shell `&`/`nohup` (which would detach to launchd and
   lose trust — §2.4). Example skill copy:

   > Start the voice daemon as a **background task** — use the Bash tool's background mode
   > (`run_in_background`), **do not** append `&` or use `nohup`/`setsid`/`disown`. Run exactly:
   > ```sh
   > node "${CLAUDE_PLUGIN_ROOT}/dist/daemon/standalone.js"
   > ```
   > It will not return; that is correct — it is the live voice session and must keep running.

   `${CLAUDE_PLUGIN_ROOT}` is substituted by Claude Code into the skill body at load time (same as
   `hooks.json` uses it today), so the absolute path is baked into the command string — this sidesteps
   the `CLAUDE_PLUGIN_ROOT=<UNSET>`-in-child caveat from §2.2.

2. **Poll for the published session**, then show it — reuse today's logic almost verbatim, but poll
   `runtime.json` written by the daemon's `start()` (no `touch active`):

   ```sh
   D="${CLAUDE_PLUGIN_DATA}"
   for i in $(seq 1 20); do [ -f "$D/runtime.json" ] && break; sleep 0.5; done
   if [ -f "$D/runtime.json" ]; then cat "$D/qr.txt" 2>/dev/null; echo; cat "$D/runtime.json"; else echo "NOT_RUNNING"; fi
   ```

3. **Branch on `needsSetup`** (unchanged from today's skill §2) and **present the QR + `sessionUrl`**
   (unchanged §3). The "no API key" case now ends because the *task exited* after writing the
   onboarding `runtime.json`, so there's no ghost `/tasks` entry.

4. **Tell the user how to stop:** "run `/voice-control:stop`, or just kill this task in `/tasks`
   (`/tasks` → select → stop, or `TaskStop`). Either ends voice." This is the visible+killable UX the
   whole change is for.

**Determinism caveat [GH/INFER]:** because the launch routes through the model, "did it actually
background it?" is probabilistic (the model could run it foreground or with `&`). Mitigations baked
into the skill copy: (a) explicit "use the Bash tool's background mode, no `&`/`nohup`"; (b) the
command genuinely never returns, so a foreground run would visibly hang the turn — a strong signal to
the model (and user) that it must be background; (c) the start skill's own poll-and-show step gives
immediate feedback (QR appears ⇒ daemon up). This is the one ergonomic risk of dropping the
deterministic MCP poll; §4 includes a check that `/tasks` shows the entry.

### 3.3 Teardown — SIGTERM/SIGINT → `VoiceDaemon.stop()`
`VoiceDaemon.stop()` already (a) clears reconnect/health timers, (b) sends `{type:"terminate"}` to the
bridge so a leaked phone URL can't reconnect, (c) closes the WS, (d) closes the hook HTTP server,
(e) `rm`s `runtime.json` + `qr.txt`. The standalone entry wires it to **SIGINT** (the `/tasks`-kill /
`TaskStop` / Ctrl-C signal) and **SIGTERM** (Claude Code's teardown signal). Claude Code sends
**SIGTERM before SIGKILL** on background-shell teardown (changelog **v2.1.160**) **[GH]**, so `stop()`
runs to completion before any SIGKILL. `/voice-control:stop` becomes simply "kill the task" (§3.5).

### 3.4 Orphan self-reap guard (the #43944 mitigation)
**The problem:** on a *plain* interactive exit (user closes the cmux pane / quits Claude without
`/voice-control:stop`, and Claude Code doesn't reap it), #43944 says the task can be **orphaned to
PID 1** instead of killed. **[GH]** An orphaned daemon has **lost cmux trust** (now a child of
launchd, not in the pane tree → injection breaks with Broken pipe) but might keep the bridge WS up — a
"zombie deaf session" the phone still appears connected to.

**The guard:** the daemon must detect that it has lost its Claude parent and exit. Two complementary
signals, both already cheap given the existing 5 s `cmuxHealth` timer:

```ts
// §3.1 startOrphanGuard(daemon, stop)
function startOrphanGuard(daemon: VoiceDaemon, stop: (s: string) => void): void {
  const PPID_AT_START = process.ppid;        // the Claude shell wrapper
  setInterval(() => {
    // (1) Hard signal: reparented to launchd. On macOS/Linux an orphaned child's PPID
    //     becomes 1. (Also catch "parent changed from the one we started under".)
    if (process.ppid === 1 || process.ppid !== PPID_AT_START) {
      stop("orphaned (ppid→1)");
      return;
    }
    // (2) Soft signal: sustained positive "pane gone" from cmux. Reuse the daemon's
    //     existing optimistic cmuxHealth verdict, but require it to be POSITIVELY gone
    //     for N consecutive ticks before reaping, so a transient cmux blip never kills a
    //     live session. (Wire a small counter into refreshCmuxHealth, or expose its last
    //     surfaceAlive verdict to this guard.)
  }, 5000);
}
```

Design rules for the guard (consistent with the daemon's hard-won optimism):
- **PPID===1 is the authoritative, fast trigger** — it is unambiguous and means trust is already lost;
  reap immediately. (`process.ppid` is available in Node on macOS/Linux.)
- **The cmux-pane-gone signal must be SUSTAINED and POSITIVE** before it reaps. The existing
  `refreshCmuxHealth` already only declares "not listening" on a *positive* `surfaceAlive===false`
  (never on an ambiguous blip). Reuse that, and require it true for a few consecutive ticks, so we
  never kill a perfectly-alive session over a momentary cmux hiccup. This belt-and-braces covers the
  case where the pane closed but the OS hasn't reparented us to 1 yet.
- **Reaping = `stop()` + `process.exit(0)`** — same clean teardown as a normal stop, so the bridge
  session is terminated and no leaked URL survives.

This guard is *the* thing that makes Option C safe to ship without the MCP host's "dies-with-Claude"
guarantee. (Validate against §4's exit test.)

### 3.5 `/voice-control:stop` rewrite
Today: `rm -f "${CLAUDE_PLUGIN_DATA}/active"` (the MCP poll then deactivates). New: there's no flag —
stopping means **killing the background task**. The stop skill instructs Claude to:
- find the voice task in `/tasks` and stop it (`TaskStop`, or "stop that background task"), **or**
- if the model tracks the task id from start, stop it directly.
On SIGINT the daemon's trap runs `stop()` → bridge `terminate` → phone goes offline within seconds
(unchanged user-visible outcome). Copy: "Voice remote stopped (the phone page goes offline in a few
seconds)."

### 3.6 Files: added / changed / deleted

| File | Action | What changes |
|---|---|---|
| `src/daemon/standalone.ts` | **ADD** | New entry: `activate()`-equivalent + SIGTERM/SIGINT→`stop()` + orphan guard (§3.1, §3.4). |
| `src/daemon/mcp-server.ts` | **DELETE** | The MCP host disappears. Its `console.error→daemon.log` tee migrates into `standalone.ts` (copy verbatim). |
| `.claude-plugin/plugin.json` | **CHANGE** | **Remove the entire `mcpServers` block** (lines 11–16). No MCP server is registered anymore → `/mcp` no longer lists (or warns about) `voice-control`. |
| `skills/start/SKILL.md` | **CHANGE** | Replace "touch `active` + poll" with "launch `node …/standalone.js` via Bash `run_in_background`, then poll `runtime.json`" (§3.2). Add the kill-to-stop hint. |
| `skills/stop/SKILL.md` | **CHANGE** | Replace `rm active` with "stop the voice background task (`/tasks`/`TaskStop`)" (§3.5). |
| `src/daemon/reconcile.ts` (+ `reconcile.test.ts`) | **DELETE** | The flag/desired-vs-actual reconcile existed only for the hosted-daemon poll. Gone with MCP. |
| `src/daemon/voice-daemon.ts` | **CHANGE (minor)** | (a) Relax the "never write to stdout (JSON-RPC)" comment wording (behaviour unchanged — still log to stderr/file). (b) `ensureRuntimePublished()` is no longer needed (no external poll re-publishes); the one-shot `writeRuntime()` in `start()` suffices. Optionally drop it + its caller. |
| `hooks/stop-notify.mjs`, `hooks/hooks.json` | **UNCHANGED** | The reply path (Stop hook → `127.0.0.1:<port>/reply`) is independent of MCP. It reads `runtime.json` for the port exactly as today. **This is why MCP is droppable.** |
| `src/daemon/cmux.ts`, `openai.ts`, `config.ts`, `history-ring.ts`, `qr.ts` | **UNCHANGED** | Pure daemon internals; reused as-is. |
| build/bundle scripts | **CHANGE** | Ensure `dist/daemon/standalone.js` is built/bundled (it's the new entry); drop `dist/daemon/mcp-server.js` from the bundle. |

**What migrates:** the daemon itself (`VoiceDaemon`) is untouched; only its *host* changes from
"long-lived MCP child that polls a flag" to "the background task is the daemon." Replies, cmux
injection, config, QR, history — all unchanged.

---

## 4. The single live test that settles GO / NO-GO

Everything above except the user's *exact* interactive cmux pane is already evidenced (docs + the §2
probe). This one test confirms the four properties that matter, in the real environment, in under a
minute. **Run it in your real cmux Claude pane, with the voice-control plugin loaded.**

Tell Claude, verbatim:

> Run this command as a **background task** using the Bash tool's `run_in_background` mode — do NOT
> append `&`, and do NOT use nohup/setsid/disown:
> ```sh
> sh -c '
>   echo "voice-probe pid=$$ ppid=$PPID";
>   echo "surface=${CMUX_SURFACE_ID:-UNSET} sock=${CMUX_SOCKET_PATH:+SET} data=${CLAUDE_PLUGIN_DATA:-UNSET}";
>   P=$$; echo "--- parent chain ---";
>   while [ "$P" -gt 1 ]; do ps -o pid=,ppid=,comm= -p "$P"; P=$(ps -o ppid= -p "$P" | tr -d " "); done;
>   echo "--- cmux trust check ---";
>   env -u CMUX_WORKSPACE_ID cmux ${CMUX_SOCKET_PATH:+--socket "$CMUX_SOCKET_PATH"} \
>     read-screen --surface "$CMUX_SURFACE_ID" --lines 1 >/dev/null 2>&1 \
>     && echo "CMUX-TRUST-OK" || echo "CMUX-TRUST-DENIED";
>   while true; do sleep 5; done
> '
> ```
> Then show me that task's output, and confirm it appears in `/tasks`.

**Expected PASS output (all four must hold):**
```
voice-probe pid=<N> ppid=<M>
surface=<a UUID> sock=SET data=<...voice-control... or your plugin data dir>   (a) env inherited
--- parent chain ---
<N>  <M>  /bin/sh
<M>  <C>  ...                          ← climbs through a 'claude' process …
<C>  ...  .../claude                   ← (b) the INTERACTIVE claude, NOT 'claude --bg-pty-host'
...  ...  .../cmux …                   ←      … up to cmux. NO 'launchd'/PID 1 as the task's parent,
...                                    ←      and NO 'claude --bg-pty-host' anywhere in the chain.
--- cmux trust check ---
CMUX-TRUST-OK                          ← (c) cmux send/read works from the bg task; no "Broken pipe"
```
and **(d)** the task is listed in `/tasks` and is stoppable there (`TaskStop` / select → stop).

**Interpretation:**
- **All four PASS → GO.** Build Option C exactly as §3 (and keep the §3.4 orphan guard — it's cheap
  insurance, not optional). The daemon will keep cmux trust hosted as a background task.
- **(b) shows parent = PID 1 or `claude --bg-pty-host`, or (c) is `CMUX-TRUST-DENIED`/Broken pipe →
  NO-GO for Option C.** The in-turn path is being routed through the daemon/`bg-pty-host` on this
  build; hosting the daemon there would lose trust (the §2.4 failure). In that (per all evidence
  unlikely) case, do not delete the MCP host yet — but note that even then, the `/mcp` warning
  diagnosis (§1) stands and is fixable by other means.

*(Optional, informs but doesn't gate the guard:* after PASS, close the cmux pane without stopping the
task, then from another shell `pgrep -af voice-probe` — if it survives with PPID 1, that's #43944's
orphaning and confirms the §3.4 guard earns its keep; if it's gone, Claude Code reaped it and the
guard is belt-and-braces.)*

---

## 5. Sources

Official Claude Code docs (verified 2026-06-20):
- **MCP** — "**The `/mcp` panel shows the tool count next to each connected server and flags servers
  that advertise the tools capability but expose no tools.**"; plugin `mcpServers`; reconnect/failed
  vs pending states: https://code.claude.com/docs/en/mcp
- Tools reference — Bash `run_in_background` ("start the command as a background task … list and stop
  with `/tasks`"), `TaskStop`/`TaskOutput`, no daemon mention for in-turn bg:
  https://code.claude.com/docs/en/tools-reference
- Changelog — **v2.1.160** SIGTERM-before-SIGKILL on background-session teardown; v2.1.163 `-p` 5 s
  reap on stdin close; v2.1.154/2.1.166 orphaned `--bg-pty-host` CPU spin; v2.1.139 agent view:
  https://code.claude.com/docs/en/changelog
- Skills — `allowed-tools`, `disable-model-invocation`: https://code.claude.com/docs/en/skills

anthropics/claude-code GitHub (behavioural evidence; not normative):
- **#43944** — in-turn Bash bg processes "reparented to PID 1 **on session exit**" (⇒ children of the
  shell wrapper *during* the session): https://github.com/anthropics/claude-code/issues/43944
- **#59065** — "`bg-pty-host` daemon is daemonized and reparented to launchd (PPID 1) **before**
  forking the `bg-spare` child": https://github.com/anthropics/claude-code/issues/59065
- #59848 — interactive sessions mis-classified as bg post-2.1.139:
  https://github.com/anthropics/claude-code/issues/59848
- #61740 — bg-spare orphan session dirs: https://github.com/anthropics/claude-code/issues/61740
- #58353 — bg agents spawned by claude daemon: https://github.com/anthropics/claude-code/issues/58353

cmux:
- Configuration (`socketControlMode`, `cmuxOnly` = "cmux-owned processes"):
  https://cmux.com/docs/configuration
- CLI/API (`send`, `read-screen`, `--surface`/`--socket`, `CMUX_*` env): https://cmux.com/docs/api

Live probe (this environment, Claude Code 2.1.183, 2026-06-20): raw output reproduced in §2.1.

Repo evidence (this codebase — authority on cmux trust + the reply path): `src/daemon/mcp-server.ts`
(the `capabilities:{tools:{}}` + `tools/list:[]` that triggers the warning), `src/daemon/voice-daemon.ts`,
`src/daemon/cmux.ts`, `src/daemon/reconcile.ts`, `src/daemon/config.ts`, `skills/start/SKILL.md`,
`skills/stop/SKILL.md`, `hooks/stop-notify.mjs`, `hooks/hooks.json`, `.claude-plugin/plugin.json`.
```
