# Design: Multiple Claude Code sessions per computer — one URL, multiple threads

**Status:** Research + design only — no implementation. (TODO.md item #7.)
**Date:** 2026-06-20.
**Vision:** **One phone app / one URL + QR per machine** that multiplexes **multiple Claude Code
instances** (one per cmux pane) as switchable **threads**. Spin up another pane — optionally **by
voice** — and it joins the **same** session as a new thread (same QR), so you can talk to instance B
while instance A is still working.

This is the big architectural bet. It touches every layer: the shared state files, the per-activation
secret, the Durable Object's 2-role model, the wire protocol, and the web UI. Below, current-state
claims are grounded in this repo's code; Claude Code / cmux internals are flagged **[DOC]/[GH]/[INFER]**;
everything depends on **#6** (a thread should ideally be a visible/killable process — see
`docs/research/visible-background-process.md`).

---

## 0. TL;DR — recommended architecture

- **One machine-level session identity.** Mint **one** stable `secret` (→ one URL/QR) **once per
  machine**, persisted in `stateDir()` (`session.json`), shared by every pane. Replaces the
  per-activation random secret in `createDaemonInit()`.
- **N daemons, one DO, one browser-set.** Drop the DO's "exactly one daemon" rule. The DO holds a
  **map of threads** (one daemon socket each) + browser(s). Every envelope gains a **`threadId`**;
  browser→daemon routes to one thread, daemon→browser is tagged with its `threadId`.
- **Per-thread registry.** Each daemon **registers** on connect with a human **label** (pane title /
  cwd / git branch) and streams **per-thread status**. The DO keeps a thread table; presence/lifecycle
  events let the UI list, switch, and badge threads. This **replaces the singleton `active`/
  `runtime.json`** model with per-thread registration (no more clobbering).
- **Spawn-a-thread by voice.** A pane can ask cmux (CLI only) to **`new-split`** a pane and launch
  `claude … /voice-control:start` there; it reads the same `session.json` secret → joins the same DO
  → appears as a new thread → the QR is unchanged.
- **Security:** one **session token** with **per-thread revocation** + rotation; blast radius and
  mitigations in §8.
- **Web UI:** a **thread switcher** (chat-list, à la iMessage conversations) on top of the existing
  hero+thread; per-thread status + unread badges; the hero and message thread scope to the active
  thread.

Build it as **5 vertical slices** (§10), each shippable. The riskiest unknowns are the cmux
spawn-a-pane ergonomics and the security model for one token reaching many instances (§11).

---

## 1. Current single-session limitation (confirmed in code)

1. **Singleton state files.** `config.ts`: `stateDir()` → one dir; `runtimePath()` → **one**
   `runtime.json`; `qrPath()` → **one** `qr.txt`; `ACTIVE_FLAG` → **one** `active` file
   (`mcp-server.ts:41`). Every Claude Code instance on the machine shares the *same* paths
   (`$CLAUDE_PLUGIN_DATA` is per-plugin, not per-pane). Two panes both write `runtime.json` → they
   **clobber** each other.
2. **Fresh secret per activation.** `createDaemonInit()` (`voice-daemon.ts:48-58`):
   `randomBytes(16)` → a **new** `secret` → a **new** `sessionId` → a **new** URL every time
   `/voice-control:start` runs. Two panes ⇒ two different URLs, neither stable.
3. **DO is a strict 2-role bridge.** `worker/src/index.ts`: keyed by `idFromName(sha256(secret))`;
   roles are exactly `{daemon, browser}` (`SocketAttachment`); on a 2nd daemon it **evicts** the
   first (`evictRole("daemon")`, lines 90, 165-175). Browsers aren't deduped, but there is **no
   notion of multiple daemons** — the model is one daemon ↔ one phone.
4. **Protocol has no thread dimension.** `src/shared/protocol.ts`: envelopes are
   `{channel, event}` with no `threadId`; `SessionState` has a single `sessionId`; the daemon's
   `emitStatus()` reports one machine's state.

⇒ **In practice: one session per machine.** A second pane mints a clobbering URL and (if it reused
the same secret) would get evicted from the DO. #7 lifts every one of these.

---

## 2. Machine-level session identity (one URL/QR for all panes)

### Persist one secret, once
Replace the per-activation secret with a **machine session record** written once to
`stateDir()/session.json`:

```jsonc
// $CLAUDE_PLUGIN_DATA/session.json  (mode 0600)
{
  "secret":    "<base64url, 128-bit>",   // the one capability → one URL/QR
  "sessionId": "<sha256(secret)[:12]>",  // non-secret label
  "createdAt": 1750000000000,
  "rotatedAt": 1750000000000
}
```

- **`createDaemonInit()` becomes `loadOrCreateSession()`:** read `session.json`; if absent, mint and
  write it (atomic: write temp + rename, like `runtime.json`); return its `secret`/`sessionId`.
  Every pane's daemon now derives the **same** URL → **same** QR. The `/voice-control:start` skill
  shows that one stable QR regardless of which pane runs it.
- **The QR is now per-machine, not per-activation.** Re-running start in a new pane re-shows the
  *same* code (satisfies #2's "same URL/QR reused" cross-ref).

### Token expiry / rotation / revocation
Today there is **no wall-clock expiry** (the session lives while the daemon runs; a single secret is
the whole capability — `bridge-contract.ts`). With one long-lived machine secret reaching multiple
instances, we want explicit controls:

- **Rotation:** a `/voice-control:rotate` action mints a new `secret`, rewrites `session.json`,
  pushes a `session_rotated` control event so the DO `expireSession()`s the old key, and re-renders
  the QR. Old phone tabs go offline; rescan the new QR. (Cheap: reuse the existing terminate path.)
- **Expiry (optional):** add `expiresAt` to `session.json`; daemons refuse to start past it and the
  skill prompts a rotate. Default: **no expiry** (matches today), opt-in for shared machines.
- **Revocation = rotation** for the *whole* session; **per-thread revoke** (kick one instance) is a
  separate, finer control covered in §8.

**Trade-off acknowledged:** a stable secret is a bigger blast radius than today's ephemeral one
(§8). Mitigated by rotation, the unguessable 128-bit secret, and the DO's hash-routing (a leaked URL
only reaches *this* machine's threads, never another user's).

---

## 3. Multi-thread bridge (the protocol + DO changes)

### 3.1 Add `threadId` to the wire (extend `src/shared/protocol.ts`)
Introduce a thread dimension without breaking the existing event shapes:

```ts
// New: every daemon is a "thread". threadId is stable for the life of that pane's daemon.
export type ThreadId = string; // e.g. the cmux CMUX_SURFACE_ID (stable per pane) or a uuid

// Thread descriptor the daemon registers with and the DO relays to browsers.
export type ThreadInfo = {
  threadId: ThreadId;
  label: string;          // human label: pane title / cwd basename / git branch (see §4)
  cwd?: string;
  gitBranch?: string;
  surface?: string;       // CMUX_SURFACE_ID, for spawn/targeting + dedup
  state: SessionRuntimeState;  // idle | working
  listening: boolean;          // cmux pane reachable
};

// Daemon → DO, on connect / when its metadata changes.
export type ThreadRegister = { type: "thread_register"; info: ThreadInfo };
export type ThreadUpdate   = { type: "thread_update"; threadId: ThreadId; patch: Partial<ThreadInfo> };

// DO → browser: the current roster + lifecycle deltas.
export type ThreadRoster   = { type: "thread_roster"; threads: ThreadInfo[] };
export type ThreadJoined   = { type: "thread_joined"; info: ThreadInfo };
export type ThreadLeft      = { type: "thread_left"; threadId: ThreadId; lastSeenAt: number };
```

**Envelope change (the core routing move):** add an optional `threadId` to every envelope so the DO
can route per-thread:

```ts
export type BridgeEnvelope =
  | { channel: "daemon";  threadId?: ThreadId; event: BrowserToDaemonEvent }   // browser → one thread
  | { channel: "browser"; threadId: ThreadId;  event: DaemonToBrowserEvent }   // a thread → browser(s)
  | { channel: "control"; event: BridgeControlEvent }
  | { channel: "registry"; event: ThreadRegister | ThreadUpdate | ThreadRoster | ThreadJoined | ThreadLeft };
```

- **Browser → daemon:** the browser sets `threadId` to the **selected** thread; the DO forwards only
  to that daemon's socket. (Back-compat: a missing `threadId` could broadcast to all — but we should
  require it once multi-thread ships, to avoid fan-out surprises.)
- **Daemon → browser:** each daemon **tags every outbound event with its own `threadId`**, so the
  browser attributes transcripts/replies/status/audio to the right thread. This is the minimal,
  surgical change — every existing `DaemonToBrowserEvent` keeps its shape; only the envelope grows a
  tag.
- **History/get_audio stay per-thread automatically** — they ride the daemon channel and inherit the
  `threadId` tag, so the existing ring + reconciliation (`history-ring.ts`, `messages.ts`) work
  unchanged *within* a thread. The browser just keeps **N message lists keyed by `threadId`**.

`web/src/lib/protocol.ts` re-exports `src/shared/protocol.ts` (single source of truth — TODO #8
note), so the web side picks these up for free.

### 3.2 Durable Object changes (`worker/src/index.ts`)
Today the DO is a near-stateless relay with a single `daemonLastSeenAt`. Extend it to a small thread
registry:

- **Attachment gains a `threadId`** for daemon sockets:
  `serializeAttachment({ role, threadId })`. Browser sockets stay role-only.
- **Drop `evictRole("daemon")`.** Replace with **per-thread dedup**: if a daemon reconnects with a
  `threadId` already present (a zombie from a moved/killed pane), evict *that thread's* old socket
  only — never sibling threads. (Keeps the existing "newer connection wins" safety, scoped to one
  thread.)
- **Routing:**
  - `channel: "daemon"` from a browser with `threadId` → `send` to the **one** daemon socket whose
    attachment `threadId` matches (not broadcast).
  - `channel: "browser"` from a daemon → broadcast to all browser sockets (tagged with the daemon's
    `threadId`).
  - `channel: "registry"` (`thread_register`/`thread_update`) from a daemon → update the DO's thread
    table in `ctx.storage`, then broadcast a `thread_roster` (or a `thread_joined`/`thread_left`
    delta) to browsers.
- **Presence per thread.** Replace the single `daemonLastSeenAt` with a **per-thread** `lastSeenAt`
  map in storage (stamped on a daemon socket close, keyed by `threadId`). On a browser connect, send
  the full roster *with* each thread's `lastSeenAt`, so the phone can render "Thread A — last active
  3h ago" exactly like today's session-offline UX (#10), but per thread.
- **`thread_left`** on a daemon socket close: broadcast it so the UI can grey out / remove that
  thread (or grade it offline by `lastSeenAt`).

**The DO stays content-agnostic** — it relays envelopes and keeps a tiny roster (labels + per-thread
last-seen). It never stores conversation content (that remains the daemon ring per thread). This
preserves the "dumb relay, privacy-light worker" posture of the current design.

---

## 4. Thread registry + labels (per-thread identity & status)

Each daemon, on `start()`, builds its `ThreadInfo` and sends `thread_register`:

- **`threadId`** = `CMUX_SURFACE_ID` (stable per pane for the pane's life — the repo already relies
  on this stability in `cmux.ts`). Fall back to a per-process uuid if unset.
- **`label`** = best human name available, in priority order:
  1. cmux pane/surface **title** (look up via `cmux list-surfaces --json` filtered by
     `CMUX_SURFACE_ID` — see §6 / Sources). **[INFER — confirm the title field name in the live CLI.]**
  2. `gitBranch` (cheap: `git -C <cwd> rev-parse --abbrev-ref HEAD`).
  3. `basename(cwd)` (the project dir). `cwd` = `process.cwd()`.
  - e.g. `"voice-control · main"` or `"api-server · fix/login"`.
- **`state` / `listening`** come straight from the existing daemon signals (`emitStatus()` already
  computes `state: working|idle` and `listening` from `cmuxHealth`). We just **tag the existing
  status event with `threadId`** and additionally fold `state`/`listening` into `thread_update`s.
- **Lifecycle:** `thread_register` on connect; `thread_update` on label/status change (e.g. branch
  switch, pane move); `thread_left` is emitted by the **DO** on socket close (the daemon can't always
  send its own goodbye — a killed pane just drops).

This **replaces** the daemon's single `emitStatus()`-to-one-browser model with a **registry the DO
owns**, so a freshly-connected phone gets the whole roster + per-thread status at once (generalizes
the current `sync` → `history` reconnect path to the thread level).

---

## 5. Replace singleton state (no more clobbering)

Per-thread registration over the bridge **is** the new state model — but the local files still need
rework so two panes on one machine don't fight:

- **`session.json` (machine-shared, §2):** the one secret/URL. Written once; every pane reads it.
  Safe to share (read-mostly; mint-on-absence is idempotent with temp+rename).
- **`active` flag → per-thread.** Today one `active` file gates the singleton daemon. With #6's
  visible-process model, the natural per-thread activation is **"the daemon is the thread"**: a pane
  that ran `/voice-control:start` has a live daemon registered in the DO; that registration *is* the
  presence. If we keep a flag at all, make it **`active/<surfaceId>`** (a dir of per-pane flags) so
  panes don't clobber. **Cleaner:** drop the flag entirely and let the daemon's DO registration be
  the source of truth (the MCP-host poll model from today is replaced by #6's per-pane process).
- **`runtime.json` / `qr.txt` → derived, shared.** Both are now functions of `session.json` (the URL
  + QR are machine-level), so they no longer carry per-pane data and **can't clobber meaningfully**
  — every pane would write the *same* bytes. Keep a single shared `qr.txt`/`runtime.json` derived
  from `session.json`; the start skill in any pane shows the same QR. (Optionally add a
  `threads.json` snapshot for the status skill, but the DO roster is the live truth.)
- **Clean removal when a pane dies.** The DO emits `thread_left` on the daemon socket close; the
  phone removes/greys the thread. No file cleanup is needed for a dead pane because per-pane state no
  longer lives in shared files — it lives in the (ephemeral) DO roster + that pane's own daemon
  process.

**Dependency call-out:** this is cleanest **if each thread is its own process (#6)**. Under today's
single MCP host, one host can't cleanly run N daemons for N panes (the MCP server is per-Claude-
instance, so there's actually one MCP host *per pane* already — good — but the shared `active`
file and singleton daemon-per-host assumptions in `reconcile.ts`/`mcp-server.ts` need the per-pane
rework above). See §9.

---

## 6. Spawn a thread (including by voice)

Goal: from pane A (or from the phone, by voice), open a **new** cmux pane, launch Claude there
running `/voice-control:start`, so it joins the **same** session as a new thread — **same QR**.

### cmux CLI mechanism (CLI only — never touch system config)
From cmux docs (Sources): cmux exposes **`cmux new-split <direction>`** (left|right|up|down) to
create a split pane, and per-pane env (`CMUX_SURFACE_ID`, `CMUX_SOCKET_PATH`). The daemon already
wraps the CLI in `cmux.ts` (with the critical `CMUX_WORKSPACE_ID`-cleared, `--socket`, global-surface
conventions). Extend it with:

```ts
// new helper in cmux.ts — open a split and run a command in it.
// 1) create the split (returns/locates the new surface)
await runCmux(["new-split", direction]);             // direction: "right" | "down" | ...
// 2) resolve the new surface id (list-surfaces --json, pick the newest / focused)
// 3) type the launch command into it and submit
await runCmux(["send", "--surface", newSurface, "--", `claude` /* + args */]);
await runCmux(["send-key", "--surface", newSurface, "enter"]);
// 4) once Claude is up, type the activation:
await runCmux(["send", "--surface", newSurface, "--", "/voice-control:start"]);
await runCmux(["send-key", "--surface", newSurface, "enter"]);
```

- **The new daemon reads the same `session.json`** → derives the same secret/URL → connects to the
  **same DO** → registers as a new thread. **The QR never changes** (re-show it for confirmation).
- **By voice:** add a browser→daemon event `spawn_thread { direction?, cwd? }`. The phone sends it to
  *any* live thread (or a dedicated "control" thread); that daemon runs the cmux spawn sequence
  above. Add to `BrowserToDaemonEvent`. The voice phrasing ("open a new session in ~/api") maps to
  `spawn_thread { cwd }`.

### Open questions / risks for spawn [INFER — verify live]
- **`new-split` vs new window/workspace.** cmux docs show `new-split`; whether there's a "new window"
  / "new workspace + surface" command, and how to **target a specific cwd** when launching, needs
  live confirmation (`cmux --help`, `cmux new-split --help`). The launch command may need a
  `cd <cwd> && claude` prefix typed into the new pane.
- **Resolving the *new* surface id** deterministically (vs racing focus) — likely diff
  `list-surfaces --json` before/after, or read the newly-focused surface. Confirm there's no
  one-shot "create-and-return-id".
- **Timing:** the new Claude needs to be *ready* before `/voice-control:start` is typed. Use a
  `read-screen` poll for the prompt, or a fixed delay + retry (mirror the daemon's existing
  optimistic/retry ethos). This is a UX-reliability detail, not a blocker.
- **Trust:** the spawned daemon is inside the *new* pane's cmux tree, so it has cmux trust for *its*
  pane — consistent with the per-thread model. Spawning a pane is a cmux CLI op from a trusted
  in-tree process; it does not require touching config.

---

## 7. Web UI — thread switcher (depends on #3, shipped)

The app already has hero + iMessage-style thread + sticky mini-controls (PRs #4–#8). Multi-thread
adds a **conversation switcher** on top — the natural iMessage metaphor (a list of conversations →
tap one → see its thread).

Sketch (mobile-first, one-hand reach):

- **Thread list / switcher.** A horizontally-scrollable **segmented pill bar** (or a tap-to-open
  conversation sheet) just under the `TopBar`, one chip per thread:
  - chip shows the **label** (`voice-control · main`), a **status dot** (idle = calm, working =
    pulsing Claude-brand, offline = grey), and an **unread badge** (count of replies arrived on a
    non-active thread).
  - the **active** chip is highlighted; tapping a chip switches the hero + message thread to it.
- **Hero + thread scope to the active thread.** `App.tsx` today holds one `messages: Message[]`.
  Make it **`Map<ThreadId, Message[]>`** (or a `messagesByThread` reducer); the hero reads the active
  thread's `state`/`listening`; the message thread renders the active thread's list. Recording/
  submit send with the **active `threadId`**.
- **Unread + presence.** A reply arriving on a background thread increments its badge + can fire a
  subtle flash/toast ("Claude · api-server replied"). Offline threads (from `thread_left` /
  stale `lastSeenAt`) grey out and disable their mic, reusing #10's session-offline grading
  **per thread**.
- **Spawn affordance (ties to §6).** A `+` chip at the end of the switcher → "New session" → optional
  cwd input → sends `spawn_thread`. By voice, the same is reachable hands-free.
- **Empty/one-thread state:** with a single thread, the switcher can hide (or show one chip), so the
  UX is identical to today until a second thread joins — **graceful progressive disclosure**.

This is the only part that hard-depends on #3 being done (it is, ~90%). It also leans on the existing
`usePlayback`/`useRecorder`/`useBridge` hooks, which become **thread-aware** (keyed by `threadId`).

---

## 8. Security — one token reaching multiple instances

This is the part to get right; it's the cost of the "one URL" convenience.

### The shift
Today: an **ephemeral** secret, fresh per activation, dies with the daemon — tiny blast radius. #7:
**one stable secret** that authorizes **typing into every Claude instance on the machine** (each
daemon `cmux send`s into a real pane). A leaked URL is materially more dangerous: it can drive *all*
your sessions, not one ephemeral one.

### Options
1. **One session token, per-thread routing (recommended for v1).** Keep one secret (one URL/QR);
   the DO routes per `threadId`. Simpler UX, single QR. Blast radius = all threads. Mitigate with
   rotation (§2), short-ish optional expiry on shared machines, and **revoke-on-exit** (a pane that
   ends removes its thread; the DO refuses re-registration of a stale `threadId` until a live daemon
   claims it).
2. **Per-thread sub-tokens (defense-in-depth, v2).** One session secret routes/authorizes *joining*;
   each thread additionally carries a **per-thread capability** the daemon mints and the browser must
   present to send to that thread. Lets you **revoke a single thread** without rotating the whole
   session (kick one instance). More moving parts; defer unless a real multi-user/shared-machine
   need appears.
3. **One token, read-vs-write split.** A leaked URL could be limited to *observing* threads unless it
   also holds a write capability — overkill for a single-user remote; note as a possibility.

### Recommendation
Ship **Option 1** (one session token + per-thread routing) with **rotation + per-thread
revoke-on-exit**, and design the protocol so **Option 2's per-thread sub-tokens can be added later**
without a wire break (reserve a `threadToken?` field on the daemon-channel envelope now). Keep the
existing hard protections that already make this safe-ish:
- **Hash-routed DO** (`idFromName(sha256(secret))`) — a leaked/guessed URL only ever reaches *this*
  machine's DO, never another user's. Preimage-resistance is the capability gate (`worker/index.ts`).
- **Origin check** on browser sockets (only the bridge origin may open a browser WS).
- **Secret never on the wire as a value** — it's in the URL path only; the daemon hashes it.

### Concrete security to-dos
- **Revoke-on-exit:** when a thread leaves, the DO clears its routing entry; a stale `threadId` from
  a dropped phone can't address a dead pane.
- **Rotation UX:** `/voice-control:rotate` → new QR; old tabs evicted (1008).
- **Document the trade-off** plainly in `docs/configuration.md` (one URL = controls all your panes;
  rotate if it leaks; lock `session.json` 0600 like config).

---

## 9. Dependency on #6 (visible/killable process)

#7 is **much cleaner if each thread is its own visible/killable process** (#6). Why:

- **Per-thread lifecycle = per-process lifecycle.** If a thread is a background-Bash-hosted daemon
  (#6 Option C) or even just an MCP-host daemon **per pane** (which already exists — one MCP host per
  Claude instance), then "thread joined/left" maps 1:1 to "process up/down," and **killing the
  visible task ends exactly that thread** — no shared-flag gymnastics.
- **No singleton clobber.** #6's per-pane process model is what makes §5's "drop the shared `active`
  flag" safe — each pane's process owns its own registration, not a shared file.
- **Verdict from #6 feeds in:** if #6 lands as **Option B** (daemon stays on the MCP host, a
  background-Bash chip is just the indicator), #7 still works — there's **one MCP host per Claude
  instance already**, so N panes = N hosts = N daemons = N threads, and the per-thread registration
  + DO roster do the rest. If #6 lands as **Option C** (standalone background-Bash daemon), #7 is
  even cleaner (the visible task *is* the thread). **Either #6 outcome supports #7** — #7 does not
  block on Option C specifically; it benefits from the per-pane-process clarity #6 brings.

**Net:** sequence #6 first (it's smaller and de-risks the process model), then #7. But #7's core
(machine secret + DO roster + protocol `threadId`) can be built against today's one-MCP-host-per-pane
reality without waiting for #6 Option C.

---

## 10. Incremental implementation plan (vertical slices, each ships value)

Each slice is independently grabbable and leaves the system working.

1. **Slice 1 — Stable machine session (one URL/QR).** Add `session.json` +
   `loadOrCreateSession()` replacing `createDaemonInit()`'s per-activation secret. *No multi-thread
   yet* — but now re-running start in any pane shows the **same** QR, and a refreshed phone keeps the
   same URL. Ships the "one URL per machine" promise alone. (Touch: `config.ts`, `voice-daemon.ts`,
   start skill.)
2. **Slice 2 — `threadId` on the wire + DO routing for N daemons.** Extend `protocol.ts` with
   `threadId` envelopes + the registry events; rework the DO to hold a thread map, drop
   `evictRole("daemon")` for per-thread dedup, route browser→one-thread and tag daemon→browser.
   Daemon tags every event with its `threadId` and sends `thread_register`. *Phone can now receive
   from multiple panes* (even if the UI just merges them at first). (Touch: `src/shared/protocol.ts`,
   `worker/src/index.ts`, `voice-daemon.ts`.)
3. **Slice 3 — Thread roster + labels + per-thread presence.** DO maintains the roster +
   per-thread `lastSeenAt`; emits `thread_roster`/`thread_joined`/`thread_left`. Daemon computes its
   `label` (pane title / branch / cwd). *Phone has the data to list/switch threads.* (Touch: DO,
   daemon label logic, `protocol.ts`.)
4. **Slice 4 — Web thread switcher.** `App.tsx` → `messagesByThread`; switcher pill bar; per-thread
   hero/thread scope; unread badges; per-thread offline grading (reuse #10). *The full multi-thread
   UX.* (Touch: `web/src/App.tsx`, new `ThreadSwitcher.tsx`, `useBridge`/`usePlayback` keyed by
   thread.)
5. **Slice 5 — Spawn-a-thread (incl. voice).** `cmux.ts` `newSplitAndLaunch()`; `spawn_thread`
   browser→daemon event + UI `+` affordance + voice mapping. *Hands-free "open another session."*
   (Touch: `cmux.ts`, `protocol.ts`, `voice-daemon.ts`, `web`.)
6. **Slice 6 (security hardening) — rotation + revoke-on-exit + docs.** `/voice-control:rotate`;
   per-thread revoke-on-exit in the DO; reserve `threadToken?` for future per-thread sub-tokens;
   document the one-URL-controls-all trade-off. (Touch: skills, DO, `config.ts`, docs.)

Slices 1–3 are backend/protocol and ship incremental value (stable URL, then multi-receive). Slice 4
is the visible payoff. 5–6 are the power-user + safety layers.

---

## 11. Open questions

1. **cmux spawn ergonomics [verify live].** Exact command(s) to open a new pane *and* target a cwd
   and launch `claude`; how to resolve the new surface id deterministically; whether `new-split` is
   the right primitive vs a new window/workspace. (`cmux new-split --help`, `cmux --help`,
   `list-surfaces --json` before/after.)
2. **Pane title for labels [verify live].** Does `list-surfaces --json` expose a human title, and
   what's the field name? If not, fall back to branch + cwd.
3. **`threadId` identity.** Use `CMUX_SURFACE_ID` (stable, dedups a reconnecting pane) vs a per-
   process uuid (survives a surface-id change but loses dedup-on-reconnect). Recommend surface id
   with a uuid fallback; confirm surface-id stability across a workspace move (repo says stable).
4. **One token blast radius — acceptable?** Is "one URL controls all my Claude panes" acceptable for
   the single-user use case (yes, likely), or do we want per-thread sub-tokens from day one? Decide
   between §8 Option 1 vs 2 for v1.
5. **DO storage limits.** The roster + per-thread last-seen is tiny, but confirm we never store
   conversation content in the DO (keep the daemon ring as the only history) so the worker stays a
   dumb relay.
6. **Reconnect storms & iOS.** With N threads, a backgrounded iOS Safari still has **one** browser
   socket multiplexing all threads — good (no per-thread sockets on the phone). Confirm the single
   `sync` still backfills *all* threads' histories efficiently (the DO can fan out a per-thread
   history request to each daemon, or the browser requests history per active thread on first view to
   avoid pulling N rings at once on cellular).
7. **Cross-pane voice routing.** When the phone sends to "the active thread," and that pane is
   busy/offline, what's the fallback? (Surface an error scoped to that thread; don't silently
   reroute.)
8. **Interaction with #6 Option C orphan guard.** If a thread's daemon orphans (PID 1) after a pane
   closes without `/stop`, it would keep a stale thread registered. The DO's `thread_left` (on
   socket close) covers the *socket* dropping, but an orphaned-yet-still-connected daemon wouldn't
   drop — so the #6 self-reap guard (detect reparent → stop) is what removes a zombie thread. Tie
   the two designs together.

---

## Sources

This codebase (current-state authority):
- Singleton state + secret: `src/daemon/config.ts`, `src/daemon/voice-daemon.ts`
  (`createDaemonInit`), `src/daemon/mcp-server.ts` (`ACTIVE_FLAG`, reconcile poll).
- DO 2-role bridge + hash routing + presence: `worker/src/index.ts`,
  `src/shared/bridge-contract.ts`.
- Protocol (no thread dimension yet): `src/shared/protocol.ts` (re-exported by
  `web/src/lib/protocol.ts`).
- cmux wrapper conventions (global surface resolution, --socket, workspace-clear):
  `src/daemon/cmux.ts`.
- Web bridge/UI to extend: `web/src/hooks/useBridge.ts`, `web/src/App.tsx`,
  `web/src/lib/messages.ts`, `web/src/lib/status.ts` (per-thread offline grading reuse).
- History ring (per-thread, unchanged within a thread): `src/daemon/history-ring.ts`.

cmux (CLI / config):
- `cmux new-split`, `send`, `send-key`, `--surface`/`--workspace`/`--socket`, `list-surfaces --json`,
  `CMUX_SURFACE_ID`/`CMUX_WORKSPACE_ID`/`CMUX_SOCKET_PATH`: https://cmux.com/docs/api
- `socketControlMode` (`cmuxOnly` default): https://cmux.com/docs/configuration

Cross-doc:
- `docs/research/visible-background-process.md` (#6) — the per-thread visible/killable process model
  this design depends on.
- TODO.md items #2 (same URL/QR), #3 (thread switcher UI), #6 (visible process), #10 (session-offline
  grading, reused per thread).
