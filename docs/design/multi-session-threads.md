# Design: Multiple Claude Code sessions per machine — one URL, N switchable threads

**Status:** Authoritative architecture — research + design only, **no implementation**, no app-code
changes in this pass. (TODO.md #7.)
**Supersedes:** the prior first-pass design of the same name. Git keeps the old revision; this is the
decision-grade rewrite. The world changed since the first pass: **#6 shipped** — the daemon is now a
standalone `dist/daemon/standalone.js` background task (one per pane, **no MCP host**, orphan
self-reap on `ppid === 1`). That removes the biggest blocker the first pass hedged on, so several of
its open questions are now closed.
**Date:** 2026-06-20.
**Author env (for the live-probe list, §11):** Claude Code 2.1.183, cmux.app, `socketControlMode:
cmuxOnly` (per `no-mcp-background-daemon.md`).

Evidence tags: **[REPO]** this codebase (authoritative on current state), **[DOC]** official docs
(Cloudflare / Claude Code), **[CMUX]** cmux docs (note: two cmux doc sites disagree — see §11),
**[INFER]** reasoned but unconfirmed → has a probe in §11.

---

## 0. TL;DR — the recommended architecture

**Identity.** `threadId = CMUX_SURFACE_ID`. It is stable for the life of a pane, already used as the
`--surface` target everywhere in `cmux.ts`, and makes every edge case in §7 "just work" (a re-quit pane
re-registers to the *same* slot). One **machine-level secret** (one URL/QR) lives in
`stateDir()/session.json`, minted once and shared by every pane's daemon — replacing the
per-activation `randomBytes(16)` in `createDaemonInit()`.

**Bridge.** Drop the DO's "exactly one daemon" rule (`evictRole("daemon")`). The DO becomes a small
**thread registry**: a map of `threadId → {socket, label, lastSeenAt}` plus the browser set. Every
envelope grows a `threadId`. Browser→daemon routes to the one matching daemon socket; daemon→browser
is tagged with its `threadId`. The worker stays a **dumb relay** apart from the registry + the two
security bits (§6).

**Labels.** Each daemon, on register, computes a human label from **git repo + branch** (`git -C
<cwd> rev-parse`), the **cwd basename**, and — if the live CLI exposes it — the **cmux pane title**
(via `cmux tree --json`, matched on its own `CMUX_SURFACE_ID`). The pane-title field is the one
genuinely unconfirmed cmux fact (§11-A); the label degrades gracefully to `repo · branch` without it.

**Switcher UX.** Reuse the existing header **white pill** as the switcher anchor: tap → **dropdown**
of threads (label + per-thread status dot + unread badge) → jump. Also **swipe left/right** between
threads using **CSS scroll-snap** (no ponytail / no swipe lib). Per-`threadId` state in `App.tsx`
(`Map<ThreadId, …>`); hero + thread scope to the active thread; reuse #10's offline grading
per-thread.

**Spawn by voice (v1).** A `spawn_thread { cwd?, direction? }` browser→daemon event → the receiving
daemon runs `cmux new-pane --cwd <cwd> --command 'claude'` (the `--cwd`/`--command` flags are
**confirmed** in the upstream CLI ref), then types `/voice-control:start`. The new daemon reads the
same `session.json` → joins the same DO as a new thread → **same QR**. Two sharp edges remain
(resolving the new surface id, and timing the `/voice-control:start` keystroke), both with probes in
§11. v1 is justified **if §11-B/§11-C pass**; the design ships without spawn (slices 1–4) regardless.

**Security (decided — §6).** Ship **one stable machine secret + revoke-on-exit + a worker
rate-limit**, *not* rotating sub-tokens. Rationale: a wrong secret already lands on an empty DO
(sha256 preimage-resistance is the real gate), so the only real risk is a **leaked URL that never
dies** — which revoke-on-exit kills directly. The native Cloudflare **Rate Limiting binding** caps
guessing cheaply. Rotation happens **only when the session is empty** (zero daemons), so an active
user **never re-scans**. Sub-tokens are designed-for (a reserved field) but deferred.

Build as **6 vertical slices** (§10), each shippable. Slices 1–4 are buildable **immediately** (no
cmux unknowns); slice 5 (spawn) and the pane-title half of slice 3 are **gated on live probes** (§11).

---

## 0.6 Live probe results — all gates CLEARED (2026-06-20, run in a real cmux pane)

Ran the §11 probes in a live cmux Claude pane. Every external gate resolved favorably; two
corrections folded in below.

- **A (labels) — PASS, better than hoped.** `cmux tree --all --json --id-format both` exposes a
  per-surface **`title`**, and it is the **live Claude task description**
  (e.g. `"⠂ Review to-dos and plan next implementation"`). The daemon maps its own surface via
  `cmux identify` (→ caller `surface_ref`), then reads `title`. There is **no `cwd`** field
  (confirmed) → cwd from the daemon's `process.cwd()`, repo·branch from `git rev-parse`. **Thread
  chips = task-title · repo · branch.** (Strip the leading spinner glyph from the title.)
- **B (spawn ref) — PASS-fast.** `new-workspace …` prints **`OK workspace:<N>`** on stdout —
  deterministic, no tree-diff needed; `close-workspace --workspace <ref>` cleans up.
- **Spawn-primitive CORRECTION:** on this cmux build `new-pane` has **no `--cwd`/`--command`** (only
  `--type/--direction/--url/--focus`). The spawn primitive is **`new-workspace --cwd <path>
  --command "<cmd>" --focus false`** (a workspace per spawned session is also the natural "open
  another project" UX). §9 is corrected accordingly.
- **C (activation) — UNRESOLVED → spawn deferred from v1.** Empirical testing turned up two
  blockers the probe missed, so **spawn-by-voice is deferred from v1** (slice 5 is not in the
  multi-thread PR):
  1. **Plugin load.** The plugin is loaded via `--plugin-dir` (data dir `voice-control-inline`),
     which is scoped to the cmux pane that launched it. A freshly-spawned `claude` in another
     cwd/pane does **not** have the voice-control plugin, so `/voice-control:start` is an unknown
     command and never runs — the new pane never joins the session.
  2. **Auto-submit unverified.** Whether `claude` with a positional **`prompt`** arg
     (`claude "/voice-control:start"`) auto-*submits* a slash command is still unconfirmed.
  **Fix path (slice-5 follow-up):** make the spawned `claude` carry the plugin — pass
  `--plugin-dir ${CLAUDE_PLUGIN_ROOT}` to the spawned command, or require a global plugin install
  — then confirm the positional prompt actually auto-submits the activation (else fall back to
  `--command "claude"` + `send`/`send-key` after polling `read-screen`). The spawn primitive
  itself (probe B) is sound; activation is what needs nailing.
- **E (trust) — PASS.** `read-screen --surface $CMUX_SURFACE_ID` → OK.

Net: **labels (slice 3, with the task-title) are unblocked. Spawn-by-voice (slice 5) is deferred
from v1** (see C above) — the CORE multi-thread (open a 2nd pane yourself + `/voice-control:start`)
is unaffected and ships.

---

## 1. Current state (confirmed in code, post-#6)

1. **Standalone daemon, one per pane.** `/voice-control:start` launches `node
   dist/daemon/standalone.js` as a `run_in_background` Bash task. `standalone.ts` IS the daemon: it
   `resolveConfig()` → `createDaemonInit()` → `new VoiceDaemon(...)` → `daemon.start()`, traps
   SIGTERM/SIGINT → `stop()`, and self-reaps when `shouldReap(process.ppid)` (i.e. `ppid === 1`).
   **There is no MCP host and no `active` flag.** [REPO: `standalone.ts`, `skills/start/SKILL.md`]
   ⇒ **N panes already = N independent daemon processes.** The hard part the first pass worried about
   (running N daemons under one host) is *already true*. #7 is now "make the bridge and UI plural,"
   not "make the process model plural."

2. **Fresh secret per activation.** `createDaemonInit()` (`voice-daemon.ts:48-58`): `randomBytes(16)`
   → new `secret` → new `sessionId` → new URL **every** start. Two panes ⇒ two URLs. [REPO]

3. **Singleton state files.** `config.ts`: one `runtime.json` (`runtimePath()`) and one `qr.txt`
   (`qrPath()`) under `stateDir()` (`$CLAUDE_PLUGIN_DATA`, per-plugin not per-pane). Two daemons both
   write `runtime.json` → they **clobber**. `/voice-control:stop` reads `pid` from `runtime.json` and
   kills *that* pid — so today it can only target one daemon. [REPO: `config.ts`, `voice-daemon.ts`,
   `skills/stop/SKILL.md`]

4. **DO is a strict 2-role bridge.** `worker/src/index.ts`: keyed by `idFromName(sha256(secret))`;
   roles are exactly `{daemon, browser}`; a 2nd daemon **evicts** the first (`evictRole("daemon")`).
   One `daemonLastSeenAt` for the whole session. Presence is `bridge_presence{daemonConnected,
   browserConnected, daemonLastSeenAt}`. [REPO]

5. **Protocol has no thread dimension.** `BridgeEnvelope` is `{channel, event}` (+ `control`); no
   `threadId`. `SessionState` carries one `sessionId`. The history ring (`history-ring.ts`) is already
   **per-daemon** (per process), so it is *already* per-thread — no change needed inside a thread.
   [REPO: `protocol.ts`, `history-ring.ts`]

⇒ In practice **one session per machine**. The process model is plural; **identity, bridge, and UI are
singular**. #7 makes those three plural.

---

## 2. Identity: `threadId = CMUX_SURFACE_ID`, one machine secret

### 2.1 Why `CMUX_SURFACE_ID` is the thread identity (and why it makes edge cases trivial)
- **Stable for the pane's life**, and stable across a workspace move (the whole reason `cmux.ts`
  clears `CMUX_WORKSPACE_ID` to resolve `--surface` globally). [REPO]
- **Already the injection target** — `cmuxTarget(surface)` passes `["--surface", CMUX_SURFACE_ID]`
  and it works for `send`/`send-key`/`read-screen`. So the daemon already *has* a stable per-pane id
  in hand at `start()` (`init.surface`). No new lookup needed for identity. [REPO]
- **Dedup-on-reconnect for free** (§7): a mis-quit-then-restart in the SAME pane gets the SAME
  `CMUX_SURFACE_ID` → re-registers to the SAME thread slot.
- **Fallback:** if `CMUX_SURFACE_ID` is unset (daemon launched outside cmux), fall back to a
  per-process `randomUUID()`. It loses dedup-on-reconnect (a restart makes a *new* thread) but never
  collides. This is a rare degraded path, not the norm.

`ThreadId` is a non-secret string. It is **safe to put on the wire and in the DO** (it is the cmux
surface UUID, not the session secret).

### 2.2 One machine secret in `session.json` (replaces the per-activation secret)
Write **once**, shared by every pane:

```jsonc
// $CLAUDE_PLUGIN_DATA/session.json   (mode 0600, like config.json)
{ "secret": "<base64url 128-bit>", "sessionId": "<sha256(secret)[:12]>", "createdAt": <ms> }
```

- New `config.ts` helper `loadOrCreateSession(): { secret; sessionId }`:
  - read `session.json`; if present and well-formed, return it;
  - else mint (`randomBytes(16)`), write atomically (temp + `rename`, like other state writes), 0600,
    return it.
  - Mint-on-absence is **idempotent under a race** (two panes starting at once): both attempt a
    write; `rename` makes the last writer win, and the secret is unguessable either way — but to be
    safe, after writing, **re-read** and return the file's contents so both panes converge on the
    *same* secret. (A lost-update here would only mean two panes briefly on two URLs until one
    restarts; the re-read closes even that.)
- `createDaemonInit(config)` changes: instead of `randomBytes(16)`, call `loadOrCreateSession()` and
  use its `secret`/`sessionId`. `surface = process.env.CMUX_SURFACE_ID` is **also** captured as the
  daemon's `threadId` (it already captures `surface`). `browserUrl` is derived from the shared secret
  → **every pane derives the same URL → same QR**. [REPO: `createDaemonInit`]

This alone delivers TODO #2 ("same URL/QR reused") — it is **Slice 1**, shippable with no multi-thread.

### 2.3 `qr.txt` / `runtime.json` stop clobbering meaningfully
Once the URL is a pure function of the shared secret, every pane writes the **same** `qr.txt` bytes —
clobbering is a no-op. `runtime.json` still carries per-pane `port`/`pid`/`surface`, so it **does**
clobber between panes. Fix minimally:
- Keep a single shared `qr.txt` (machine-level; identical bytes).
- Make `runtime.json` **per-thread**: write `runtime/<surfaceId>.json` (a directory of small files),
  so the start skill in pane B doesn't overwrite pane A's port/pid. The start skill reads back the
  file it just caused to be written (it already polls by the daemon it launched). `/voice-control:stop`
  becomes "kill the daemon in THIS pane" — read `runtime/<CMUX_SURFACE_ID>.json` for the pid. (A
  global "stop all" variant can iterate the dir.)
- The **DO roster is the live truth** for who's connected; files are only the local launch handshake.

---

## 3. Protocol changes (`src/shared/protocol.ts`)

Add a thread dimension **without breaking any existing event shape**. The single source of truth is
`src/shared/protocol.ts`; `web/src/lib/protocol.ts` re-exports it, so the web side picks all of this
up for free. [REPO]

```ts
// Non-secret, stable per pane. The cmux surface UUID (CMUX_SURFACE_ID), or a per-process uuid.
export type ThreadId = string;

// What a daemon registers with; what the DO relays to browsers.
export type ThreadLabel = {
  // Best human name, precomputed by the daemon (see §4). e.g. "voice-control · main".
  title: string;
  repo?: string;       // git repo dir basename
  branch?: string;     // git rev-parse --abbrev-ref HEAD
  cwd?: string;        // process.cwd()
  paneTitle?: string;  // cmux pane title IF the live CLI exposes it (§11-A); else omitted
};

export type ThreadInfo = {
  threadId: ThreadId;
  label: ThreadLabel;
  state: SessionRuntimeState;   // "idle" | "working"  (already exists)
  listening: boolean;           // cmux pane reachable (already computed by the daemon)
};

// Daemon → DO (registry channel)
export type ThreadRegister = { type: "thread_register"; info: ThreadInfo };
export type ThreadUpdate   = { type: "thread_update"; threadId: ThreadId; patch: Partial<ThreadInfo> };

// DO → browser (registry channel)
export type ThreadRoster = { type: "thread_roster"; threads: RosterThread[] };
export type ThreadJoined = { type: "thread_joined"; thread: RosterThread };
export type ThreadLeft   = { type: "thread_left"; threadId: ThreadId; lastSeenAt: number };

// A roster entry the DO sends includes per-thread presence (so the phone grades offline per thread,
// reusing #10). `connected` = a live daemon socket for this threadId right now.
export type RosterThread = ThreadInfo & { connected: boolean; lastSeenAt: number | null };
```

**Envelope — the core routing change.** Add `threadId` and two new channels:

```ts
export type BridgeEnvelope =
  | { channel: "daemon";  threadId: ThreadId; event: BrowserToDaemonEvent }   // browser → ONE thread
  | { channel: "browser"; threadId: ThreadId; event: DaemonToBrowserEvent }   // a thread → browser(s)
  | { channel: "control"; event: BridgeControlEvent }                          // unchanged (terminate)
  | { channel: "registry"; threadId?: ThreadId; event: ThreadRegister | ThreadUpdate }   // daemon → DO
  | { channel: "roster"; event: ThreadRoster | ThreadJoined | ThreadLeft };               // DO → browser
```

- **Browser → daemon** sets `threadId` = the selected thread; the DO forwards to the one matching
  daemon socket (never broadcast).
- **Daemon → browser** tags **every** outbound event with its own `threadId`. Every existing
  `DaemonToBrowserEvent` keeps its exact shape; only the envelope grows a tag. So `transcript` /
  `claude_reply` / `tts_audio` / `history` / `error` / `session_status` are unchanged — the browser
  just files them under `threadId`. **History/get_audio are per-thread automatically** (they ride the
  daemon channel under one `threadId`; the per-daemon ring already exists).
- **Reserve `threadToken?` on the daemon channel** now (unused in v1) so per-thread sub-tokens (§6
  Option 2) can be added later without a wire break.

Back-compat note: this is pre-release (project memory: "no back-compat code pre-release"), so we
**require** `threadId` once multi-thread ships rather than supporting a missing-threadId broadcast.

---

## 4. Thread labels (§2's `ThreadLabel`, computed by the daemon)

The user wants threads distinguishable by **git repo + branch**, **cwd**, and the **cmux pane title**.
The daemon computes its label once at `start()` (and on change) and sends it in `thread_register` /
`thread_update`.

Priority for `title` (the single string shown on the chip), most specific first:
1. **`paneTitle`** if the live cmux CLI exposes a per-surface title (see §11-A). cmux's pane title
   often describes what the thread is doing — the highest-value label. **[INFER — exact field +
   availability unconfirmed; probe §11-A.]**
2. **`repo · branch`** — cheap and reliable: `git -C <cwd> rev-parse --abbrev-ref HEAD` for the
   branch, `basename(git -C <cwd> rev-parse --show-toplevel)` for the repo. e.g. `"voice-control ·
   main"`. **This is the guaranteed-available label** and the default.
3. **`basename(cwd)`** if not a git repo. `cwd = process.cwd()`.

Implementation notes:
- New `src/daemon/labels.ts` (pure-ish, mirrors how `history-ring.ts`/`shouldReap` isolate logic):
  `computeLabel(cwd, surfaceId): Promise<ThreadLabel>`. Runs `git -C` (reuse the `runCmux`
  spawn-with-timeout ethos) and, **if §11-A passes**, one `cmux tree --json` filtered to this
  daemon's `CMUX_SURFACE_ID` to pull `paneTitle`. Each piece is best-effort; any failure just omits
  that field and falls through the priority list. Never blocks `start()` (compute async, send a
  `thread_update` when ready, exactly like the cmux-health monitor pattern).
- **cwd is NOT exposed by cmux** (confirmed: no surface-cwd getter in the CLI; issue #2761). So cwd
  comes from `process.cwd()` of the daemon, which is the pane's cwd at launch — correct and free.
- **Refresh:** recompute on a branch change. Cheapest reliable trigger: fold a `git rev-parse` into
  the existing 5s `cmuxHealth` tick (it already runs) and emit a `thread_update` only on change
  (same "emit on change" discipline as `emitStatus`). Don't add a second timer.

`state` / `listening` already exist in `emitStatus()`; the daemon now **also** folds them into
`thread_update`s (or the DO derives `state`/`listening` for the roster from the last `session_status`
it relayed for that thread — simpler: let the daemon include them in `thread_update`, keep the DO
dumb).

---

## 5. Durable Object: 2-role bridge → N-daemon thread registry (`worker/src/index.ts`)

Today the DO is a near-stateless relay with one `daemonLastSeenAt`. Extend it to a small registry.
**Keep it content-agnostic** — it never stores conversation content (that stays in each daemon's
ring); it stores only a tiny roster (labels + per-thread last-seen).

Changes:

1. **Attachment gains `threadId`** for daemon sockets:
   `serializeAttachment({ role: "daemon", threadId })`. Browser sockets stay `{ role: "browser" }`.
2. **Drop `evictRole("daemon")`.** Replace with **per-thread dedup**: on a daemon connect, if a
   socket with the **same `threadId`** is already attached (a zombie from a moved/re-quit pane, or a
   reconnect racing the old close), evict **only that** socket (1012). Sibling threads are untouched.
   This preserves "newer connection wins," scoped to one thread.
3. **Routing in `webSocketMessage`:**
   - `channel: "daemon"` from a **browser** (carries `threadId`) → `send` to the **one** daemon
     socket whose attachment `threadId` matches. If none match → reply a `browser`-channel `error`
     (tagged with that `threadId`): "That thread is offline." (per §7; never silently reroute).
   - `channel: "browser"` from a **daemon** → broadcast to all browser sockets, **with the daemon's
     `threadId`** stamped onto the envelope by the DO (the DO knows it from the attachment, so the
     daemon doesn't even have to set it — but daemon sets it too; DO trusts the attachment).
   - `channel: "registry"` (`thread_register` / `thread_update`) from a **daemon** → update
     `ctx.storage` roster, then broadcast a `roster`-channel `thread_joined` (new) or `thread_update`
     fold (existing) to browsers.
   - `channel: "control"` `terminate` from a daemon → **per-thread** now (see §6): remove that
     thread; only tear the whole session down when it was the **last** thread.
4. **Per-thread presence.** Replace the single `DAEMON_LAST_SEEN_KEY` with a roster map in storage:
   `threadId → { label, lastSeenAt }`. On a daemon socket **close/error**, stamp that thread's
   `lastSeenAt = Date.now()` and broadcast `thread_left`. On a **browser** connect, send the full
   `thread_roster` (every thread with `connected` computed live from `getWebSockets()` + its stored
   `lastSeenAt`), so a fresh phone renders "Thread A · last active 3h ago" per thread (generalizes the
   current single-session `sync`→`history` + `bridge_presence` reconnect path to N threads).
5. **`bridge_presence` stays** for the browser's own socket health, but its `daemon*` fields are
   superseded per-thread by the roster. Simplest: keep `bridge_presence` carrying only
   `browserConnected` (the phone's own liveness); move all daemon presence into the roster.

Storage size is trivial (a handful of small JSON entries); confirm we never write conversation
content (we don't — the ring is daemon-side).

---

## 6. Security — DECIDED

The user said "forget tokens for now, you research it" and asked us to **weigh stable-secret +
revoke-on-exit + rate-limit (simpler) vs rotating sub-tokens** and **pick**. We pick the first.

### 6.1 The honest threat model (what actually changes vs today)
- **Brute-forcing the secret is a non-threat, quantified.** The URL carries a 128-bit secret; the
  worker routes via `idFromName(sha256(secret))`. A wrong guess lands on a **different, empty DO** —
  never the victim's session (sha256 is preimage-resistant; reaching the right DO already *is* proof
  of knowing the secret). To hit the live session by guessing you must invert sha256 / find a 128-bit
  preimage: ~2^127 expected tries. At even 10^6 guesses/sec that is ~10^25 years. **Guessing is not
  the risk.** [REPO: `worker/index.ts` routing; DOC: idFromName]
- **The real risk is a *leaked* URL that never dies.** Today's per-activation secret dies with the
  daemon (tiny blast radius). #7's stable secret authorizes typing into **every** Claude pane on the
  machine and, crucially, would otherwise **outlive every session** — a screenshot/QR shared once
  could reconnect tomorrow. **This is the thing to fix**, and it is fixed by revoke-on-exit, not by
  tokens.

### 6.2 The decision: stable secret + revoke-on-exit + rate-limit (NOT rotating sub-tokens)
1. **One stable machine secret** (§2.2) — one URL/QR, zero re-scanning for an active user.
2. **Revoke-on-exit (the core safety property).** The session secret is only *live* while at least
   one daemon is connected. Concretely, in the DO:
   - When the **last** thread leaves (daemon socket closes/terminates and the roster becomes empty),
     start a **grace timer** (e.g. 2–5 min via `ctx.storage.setAlarm()`); if no daemon reconnects
     before it fires, **`expireSession()`** (close any sockets 1008 + `deleteAll()`). A grace window
     covers laptop-sleep / Wi-Fi flap without nuking the session.
   - A leaked URL opened **after** the session went empty hits a DO whose storage is wiped → it can
     observe nothing and address no pane. The URL is **dead** until the user starts a daemon again.
   - This makes "one URL forever" false in the dangerous sense: the URL is only useful while *you*
     have a live pane. Exactly the user's requirement.
   - Note the **secret string itself doesn't change** (so no re-scan), but its *session* is gone; a
     fresh `/voice-control:start` re-creates the session under the same secret. To kill a leak while
     panes are live, `/voice-control:stop` them — the session dies with the last daemon.
3. **Worker rate-limit gateway (anti-guessing + anti-DoS).** Add Cloudflare's native **Rate Limiting
   binding** in `wrangler.toml`:

   ```toml
   [[ratelimits]]
   name = "WS_CONNECT"
   namespace_id = "1001"
   simple = { limit = 60, period = 60 }   # period must be 10 or 60
   ```

   In the **top-level Worker `fetch`** (not the DO — the binding is documented for the Worker fetch
   handler, and we want to reject *before* spawning/billing a DO), before
   `env.VOICE_SESSIONS.get(...)`:

   ```ts
   const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
   const { success } = await env.WS_CONNECT.limit({ key: ip });
   if (!success) return new Response("Too Many Requests", { status: 429 });
   ```

   **What this actually buys (framed honestly):** since a wrong secret already lands on an empty DO,
   rate-limiting does **not** protect the session (it can't be reached by guessing anyway). It
   protects the **worker/DO platform**: it caps an attacker spraying `/ws/<random>` to spin up DOs /
   burn requests, and bounds connection-attempt cost. It is cheap insurance against abuse/billing,
   not the capability gate. The binding is **best-effort / per-edge-location / eventually consistent**
   [DOC] — fine for abuse-bounding, and we explicitly do **not** rely on it for correctness. Turnstile
   is rejected: it needs an interactive challenge and would break the WS handshake + the daemon's
   non-browser `ws` client. Cloudflare WAF **Rate Limiting Rules** (dashboard) are an alternative but
   the binding keeps the limit in code/review with the rest of the worker.

### 6.3 Why NOT rotating sub-tokens (in v1)
A stable QR-secret + a rotating short-lived WS sub-token (daemon mints, browser presents) is the
defense-in-depth option. We **defer** it because:
- It adds a token-issuance + refresh dance (daemon→browser handoff, expiry, clock) to a **single-user
  remote** whose real risk (leaked URL) is already closed by revoke-on-exit.
- It buys "kick one thread without rotating the session" — a niche need we don't have evidence for
  yet.
- We **don't burn the bridge to it**: `threadToken?` is reserved on the daemon-channel envelope (§3),
  so v2 can add per-thread sub-tokens with no wire break.

### 6.4 Rotation — DROPPED (revoke-on-exit + `/stop` is enough)
Earlier drafts shipped a `/voice-control:rotate` skill to mint a new secret on demand. **Dropped per
user feedback** — nobody hand-rotates a hash, and it's redundant: revoke-on-exit already kills a
leaked URL the moment the last pane disconnects, and `/voice-control:stop` triggers that on demand.
So "kill a leak" = stop your panes; there is no dedicated rotate command. (`threadToken?` stays
reserved on the wire — §6.3 — for a future per-thread sub-token if one is ever needed.)

### 6.5 Keep today's hard protections (unchanged)
- Hash-routed DO (`idFromName(sha256(secret))`) — a leaked/guessed URL only ever reaches *this*
  machine's DO. [REPO]
- **Origin check** on browser sockets (only the bridge origin may open a browser WS); the daemon
  (Node `ws`) sends no Origin. [REPO]
- Secret never on the wire as a value — URL path only; the daemon hashes it. [REPO]
- `session.json` is **0600** like `config.json` (config.ts already enforces 0600 on config). Document
  the trade-off plainly: "this one URL drives every Claude pane on the machine; it goes dead when no
  pane is connected; /stop your panes to kill a live leak."

---

## 7. Edge cases — handled reliably but simply (via `threadId = CMUX_SURFACE_ID`)

| Case | Behavior | Mechanism |
|---|---|---|
| **Pane closed / Claude quit** | Thread shows offline, then is removed after a grace. | Daemon socket drops → DO stamps `lastSeenAt`, broadcasts `thread_left`; orphan self-reap (`ppid===1`, #6) also stops a zombie daemon so it can't linger registered. UI greys the chip (reuse #10 grading), removes after grace. |
| **Mis-quit then restart in the SAME pane** | Re-registers to the **same** thread slot; the chip never duplicates. | Same `CMUX_SURFACE_ID` → same `threadId` → DO per-thread dedup evicts the (already-dead) old socket and the new one takes the slot. |
| **History after a restart** | Fresh ring (empty), reconciled cleanly. | The ring lives in the **daemon process**; a new process = a new empty ring. On reconnect the phone's `sync` for that thread returns the (empty) history; the phone's existing reconcile-by-seq keeps prior on-screen messages but no audio is fetchable (the old ring is gone). This is acceptable and matches today's single-session restart behavior. |
| **`/clear` or `/compact` → new topic, SAME pane** | The thread's voice history resets so it doesn't show the old topic. | See §7.1. |

### 7.1 `/clear` and `/compact`: reset the ring via the `SessionStart` hook
A `/clear` (or `/compact`) starts a brand-new topic in the **same** pane (same `CMUX_SURFACE_ID`,
same daemon process), so the daemon's ring would otherwise still show the old conversation.

**Recommendation: use the Claude Code `SessionStart` hook with `source: "clear" | "compact"` to reset
the daemon's ring.** [DOC — confirmed: `SessionStart` fires with `source` ∈ `startup | resume | clear
| compact`; payload has `session_id`, `source`, `cwd`, `hook_event_name`.]

Concretely:
- Add a tiny `hooks/session-reset.mjs` registered for `SessionStart`. When `source` is `clear` or
  `compact`, POST to the daemon's local hook listener (the same `127.0.0.1:<port>` the Stop hook
  already uses, port read from this pane's `runtime/<surfaceId>.json`) at a **new** route, e.g.
  `POST /reset`.
- The daemon handles `/reset` by clearing its `HistoryRing` (add a `ring.clear()` method) and
  emitting a `thread_update` / a small `history` (now empty) so the phone drops the old thread view.
- This reuses the **exact** transport the reply path already uses (hook → HTTP POST → daemon), so it's
  a few lines, no new infra. [REPO: `hooks/stop-notify.mjs`, `voice-daemon.ts#startHookListener`]

**Weighed against doing nothing:** doing nothing leaves stale topic history on the phone after a
`/clear`, which is confusing precisely when the user wanted a clean slate. The hook is the clean,
documented signal and is cheap. **Don't overcomplicate it** — only `clear`/`compact` reset; `resume`
keeps history; `startup` is a fresh process anyway. (We do **not** try to diff transcripts or detect
topic changes heuristically — the hook is the reliable signal.)

---

## 8. Web UI — the thread switcher (reuse the white pill; CSS swipe)

The app is `App.tsx` (one `messages: Message[]`) + `Hero` + `MessageThread` + `MiniControls` +
`TopBar` (with the `FEATURES.threadTitle` **white pill** scaffolded). `useBridge`/`usePlayback`/
`useRecorder` are the hooks; `deriveStatus` (#10) grades offline by elapsed time. [REPO]

### 8.1 State: per-`threadId`
- `App.tsx` holds `threads: RosterThread[]` (+ `activeThreadId`) and a per-thread store:
  `messagesByThread: Map<ThreadId, Message[]>`, `unreadByThread: Map<ThreadId, number>`. A small
  reducer (or a `useThreads` hook) keyed by `threadId` is cleaner than N parallel `useState`s.
- `useBridge` becomes **thread-aware**: it routes inbound events to `onEvent(threadId, event)` (from
  the envelope tag), exposes the **roster** (`thread_roster`/`thread_joined`/`thread_left`), and
  `sendDaemon(threadId, command)` stamps the envelope `threadId`. It still multiplexes **one** browser
  socket for all threads (good for iOS — see §8.4).
- The **active thread** drives the hero (`state`/`listening`/`currentTask`) and the `MessageThread`
  (its `messagesByThread.get(activeThreadId)`). `deriveStatus` runs **per active thread** using that
  thread's roster `connected` + `lastSeenAt` — #10 reused verbatim, just fed per-thread inputs.
- `usePlayback` keys playback by `threadId` (or is instantiated per active thread) so switching
  threads doesn't bleed audio.

### 8.2 The switcher (white pill → dropdown)
- Turn on `FEATURES.threadTitle`: the **white pill** in `TopBar` shows the active thread's `label.title`
  + a status dot (idle/working/offline, from the active thread's `deriveStatus`) + the existing
  `ChevronDown`.
- Tapping the pill opens a **dropdown sheet** (shadcn/ui `DropdownMenu` or a simple popover) listing
  every roster thread: label, per-thread status dot, **unread badge** (count from `unreadByThread`).
  Tapping a row sets `activeThreadId` and (for swipe coherence) scrolls the pager to it.
- **Empty/one-thread state:** with a single thread, show the label in the pill but no dropdown affordance
  (or a disabled chevron) — identical to today's single-screen UX. The switcher appears only when a
  2nd thread joins (**progressive disclosure**; reuse the `FEATURES` gating so it's off until earned).

### 8.3 Swipe left/right (CSS scroll-snap, no library)
- Wrap the per-thread panes in a horizontal **scroll-snap** pager:
  `overflow-x-auto snap-x snap-mandatory` with each thread pane `snap-start w-full shrink-0`. Swiping
  pages between threads natively (momentum + snap), zero JS gesture code, zero ponytail. [Native CSS;
  prefer over a swipe lib per the brief.]
- Sync the active thread both ways: a scroll-snap settle updates `activeThreadId` (via an
  `IntersectionObserver` per pane, the same primitive `App.tsx` already uses for the condensed-bar
  sentinel); tapping a dropdown row scrolls the pager to that pane (`scrollIntoView({ inline })`).
- **Caveat to verify in-app:** the existing vertical scroll (message thread) lives *inside* each
  horizontal page, so we need `touch-action`/overscroll tuning so vertical reading doesn't trigger a
  horizontal page flip and vice-versa. This is a CSS-tuning task, not an architecture risk; flagged
  for live UI verification (§11-F).

### 8.4 Unread, presence, and iOS
- A reply on a **background** thread increments its `unreadByThread` badge (+ optional subtle flash
  "Claude · api-server replied", reusing `useFlash`). Switching to it clears the badge.
- **Offline threads** (roster `connected:false` / stale `lastSeenAt`) grey their chip and disable
  their mic, reusing #10 per-thread.
- **iOS:** still **one** browser WebSocket multiplexing all threads (no per-thread sockets), so the
  reconnect-storm behavior is unchanged from today. On reconnect, request the **roster** first, then
  `sync` **only the active thread's** history (lazy-load other threads' history on first view) to
  avoid pulling N rings at once on cellular.

### 8.5 Spawn affordance
- A `+` action (in the dropdown footer, and/or the scaffolded `BottomTabBar` "New" tab) → optional cwd
  input → `sendSpawn({ cwd })` (§9). By voice it's hands-free (§9.2). With a single connected daemon,
  the spawn event routes to it; with several, route to the **active** thread's daemon (it's the one
  the user is "in").

---

## 9. Spawn a thread by voice (follow-up)

> **Status: deferred from v1.** Empirical testing surfaced two blockers (§0.6-C): the plugin is
> `--plugin-dir`-loaded (data dir `voice-control-inline`), so a freshly-spawned `claude` in another
> pane lacks the voice-control plugin and `/voice-control:start` never runs; and the positional-prompt
> auto-submit is unverified. Per "no fallbacks / it must actually work," slice 5 is cut from v1. The
> CORE multi-thread (open a 2nd pane yourself + `/voice-control:start`) is unaffected and ships. The
> body below is the **follow-up plan**: the spawn primitive is sound; the fix is to make the spawned
> `claude` carry the plugin (`--plugin-dir ${CLAUDE_PLUGIN_ROOT}` or a global install) and confirm the
> activation auto-submits.

Goal: from the phone (by voice) or the `+` affordance, open a **new** cmux pane, launch Claude there
running `/voice-control:start`, so it joins the **same** session as a new thread — **same QR**.

### 9.1 The cmux mechanism (CLI only — never touch config)
The upstream CLI ref **confirms** the flags we need: **`new-pane --cwd <dir> --command "<cmd>"`** and
**`new-workspace --cwd --command`**, where `--command` "auto-appends `\n`" (runs the command after the
shell is ready, avoiding the type-into-a-cold-shell race). `--surface`/short-refs target specific
surfaces; `read-screen` reads a surface. [CMUX: manaflow CLI ref]

Recommended sequence (new helper in `cmux.ts`, e.g. `spawnPane({ cwd, direction })`):

```ts
// 1) Create a new WORKSPACE with the cwd set and Claude launched in it. (On this cmux build
//    `new-pane` has NO --cwd/--command; `new-workspace` does — verified live, §0.6.) The
//    command prints "OK workspace:<N>" on stdout, so the new ref is deterministic — no tree diff.
const out = await runCmux(["new-workspace", "--cwd", cwd, "--command", "claude /voice-control:start",
                           "--focus", "false"]);            // out === "OK workspace:22"
const workspaceRef = out.trim().split(/\s+/).pop();          // "workspace:22"
// 2) If `claude "<prompt>"` does NOT auto-submit the slash command (confirm in slice 5), fall back
//    to launching plain `claude` and typing the activation once its prompt is ready:
//      await runCmux(["new-workspace", "--cwd", cwd, "--command", "claude", "--focus", "false"]);
//      // resolve the workspace's surface (list-pane-surfaces --workspace <ref>), poll read-screen,
//      await runCmux(["send", "--surface", surfaceRef, "--", "/voice-control:start"]);
//      await runCmux(["send-key", "--surface", surfaceRef, "enter"]);
// The new daemon reads the same session.json → same secret/URL → joins the same DO as a new thread.
```

- **Why not `--command "claude && /voice-control:start"`?** `/voice-control:start` is a **Claude Code
  slash command typed into Claude's TUI**, not a shell command — it can't be chained after `claude` in
  the shell. So step 3 must type it into the running Claude *after* its prompt appears. (Confirm in
  §11-C whether a `claude` launch flag can auto-run a slash command / initial prompt — if so, we skip
  the keystroke timing entirely.)
- **Timing step 3:** poll `read-screen --surface <new>` for Claude's prompt (a few retries, mirroring
  the daemon's optimistic/retry ethos), then type. This is a UX-reliability detail, not a blocker.
- **The new daemon reads the same `session.json`** → same secret/URL → joins the same DO as a new
  thread. **QR never changes.** Re-show it for confirmation.

### 9.2 The `spawn_thread` event + voice mapping
- Add to `BrowserToDaemonEvent`: `{ type: "spawn_thread"; cwd?: string; direction?: "right"|"down" }`.
- **Which daemon executes it?** The browser sends it to the **active** thread's daemon (it's trusted
  in-tree and can run cmux CLI for *its* pane's cmux instance). That daemon runs `spawnPane(...)`. If
  no thread is active/connected, the phone surfaces "Start voice in a pane first" (you need at least
  one live daemon to spawn from).
- **Voice phrasing** maps in the daemon's existing transcript path — but spawning is an *action*, not
  a prompt to inject. Simplest reliable v1: the `+` affordance / a dedicated voice intent. If we want
  pure-voice ("open a new session in ~/api"), the phone can detect a small command grammar
  client-side and emit `spawn_thread { cwd }` instead of `submit_audio`. Keep the grammar tiny and
  explicit; do **not** try to LLM-parse arbitrary speech into shell in v1.

### 9.3 v1 justification + the sharp edges
Spawn is **justified for v1 IF §11-B and §11-C pass** — the `--cwd`/`--command` ergonomics are
confirmed, leaving two unknowns: (B) deterministically resolving the new surface id, and (C) whether
Claude can auto-run the slash command (or we time the keystroke). Neither blocks slices 1–4. If B/C
reveal a sharp edge (e.g. no reliable new-ref resolution), ship spawn as a **fast-follow** (slice 5)
rather than dropping it — the protocol/UI affordance is cheap; only the cmux choreography is gated.

---

## 10. Incremental slices (each ships value; gating noted)

| Slice | Ships | Touches | Gated on a live probe? |
|---|---|---|---|
| **1. Stable machine session (one URL/QR)** | Re-running start in any pane shows the **same** QR; a refreshed phone keeps the same URL. No multi-thread yet. | `config.ts` (`loadOrCreateSession`, `session.json`, per-thread `runtime/<id>.json`), `voice-daemon.ts` (`createDaemonInit`), start/stop skills. | **No** — buildable now. |
| **2. `threadId` on the wire + DO N-daemon routing** | Phone receives from multiple panes (UI may merge at first). Drop `evictRole("daemon")`; per-thread dedup; route browser→one-thread, tag daemon→browser. | `protocol.ts`, `worker/src/index.ts`, `voice-daemon.ts` (tag events, send `thread_register`). | **No** — buildable now. |
| **3. Roster + labels + per-thread presence** | Phone has data to list/switch threads; per-thread offline grading. Daemon computes label (repo·branch·cwd; paneTitle if available). | DO roster + `thread_left`/`thread_roster`, `src/daemon/labels.ts`, `protocol.ts`. | **Half** — repo·branch·cwd: no. **paneTitle: gated on §11-A.** Ship label without paneTitle if A fails. |
| **4. Web thread switcher** | Full multi-thread UX: white-pill dropdown + CSS swipe, per-thread state, unread badges, per-thread #10 grading. | `App.tsx` (`messagesByThread`), `useBridge`/`usePlayback` keyed by thread, `TopBar` pill (`FEATURES.threadTitle`), new `ThreadSwitcher`/pager, reuse `BottomTabBar`. | **No** (arch) — buildable now; swipe CSS tuning verified live (§11-F). |
| **5. Spawn-a-thread (incl. voice)** — **DEFERRED from v1 (not in this PR)** | Hands-free "open another session." `spawn_thread` event + `cmux.ts` `spawnPane`, `+` affordance, voice grammar. | `cmux.ts`, `protocol.ts`, `voice-daemon.ts`, `web`. | **Deferred** — empirical testing found the spawned `claude` lacks the `--plugin-dir`-loaded plugin so `/voice-control:start` never runs, and positional-prompt auto-submit is unverified (§0.6-C). Returns as a focused follow-up. |
| **6. Security hardening** | Revoke-on-exit (DO alarm grace), worker rate-limit binding, `/voice-control:rotate` (idle-only auto + explicit), reserve `threadToken?`, docs of the one-URL trade-off. | `worker/index.ts` (alarm, ratelimit), `wrangler.toml`, skills, `config.ts`, `docs/configuration.md`. | **No** — buildable now (rate-limit binding is a config + 3-line check). |

Slices 1–4 deliver the full visible product without any cmux unknown, and 6 is the safety layer that
lands in parallel — together they are v1. Slice 5 (spawn) is the power-user layer; it is **deferred
from v1** because the spawned `claude` lacks the `--plugin-dir`-loaded plugin and the activation
auto-submit is unverified (§0.6-C / §9). It returns once plugin-load + activation are nailed.
**Recommended order:** 1 → 2 → 3 → 4 (the payoff), then 6 — and 5 as a focused follow-up.

---

## 11. Open questions / live-verification list (each with a copy-pasteable probe)

These are facts I could **not** confirm from docs (the two cmux doc sites disagree, and titles/cwd are
the subject of open cmux issues). Run each in the **user's real cmux Claude pane** with the
voice-control plugin loaded. Use `env -u CMUX_WORKSPACE_ID` and `--socket "$CMUX_SOCKET_PATH"` exactly
as `cmux.ts` does (global surface resolution).

**A. Does the cmux CLI expose a per-surface TITLE, and what is the field? (labels — slice 3)**
Two sources conflict: one shows `tree --json` surfaces having a `title` field; cmux issue #2761 says
titles aren't exposed via CLI. Confirm which is true on the user's build.
```sh
env -u CMUX_WORKSPACE_ID cmux --socket "$CMUX_SOCKET_PATH" tree --all --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);console.log(JSON.stringify(t,null,2))})' \
  | grep -iE "\"(title|ref|cwd|tty|focused|surface)\"" | head -40
echo "--- my surface id: $CMUX_SURFACE_ID ---"
# Does any surface entry's ref/uuid map to $CMUX_SURFACE_ID, and does it carry a non-empty title?
```
PASS = a surface entry correlates to `$CMUX_SURFACE_ID` **and** has a usable `title`. If FAIL, ship
labels as `repo · branch` only.

**B. After creating a pane, how do we learn the NEW surface id deterministically? (spawn — slice 5)**
```sh
before=$(env -u CMUX_WORKSPACE_ID cmux --socket "$CMUX_SOCKET_PATH" tree --all --json)
out=$(env -u CMUX_WORKSPACE_ID cmux --socket "$CMUX_SOCKET_PATH" new-pane --direction right --cwd "$HOME" --command "echo spawned"); echo "new-pane stdout: <<<$out>>>"
after=$(env -u CMUX_WORKSPACE_ID cmux --socket "$CMUX_SOCKET_PATH" tree --all --json)
echo "--- diff before/after to find the new surface ref ---"
diff <(echo "$before") <(echo "$after")
```
PASS-fast = `new-pane` prints the new surface ref on stdout (use it directly). PASS-fallback = the
`tree --json` diff yields exactly one new surface ref (use the diff). FAIL = neither is deterministic
→ spawn needs a different primitive; keep spawn out of v1.

**C. Can `claude` auto-run a slash command / initial prompt on launch? (spawn — slice 5)**
Avoids timing the `/voice-control:start` keystroke.
```sh
claude --help 2>&1 | grep -iE "prompt|command|--append|initial|/|slash" | head -30
```
PASS = a flag launches Claude already running an initial prompt or slash command → use
`new-pane --command "claude <that-flag> /voice-control:start"`. FAIL = type the slash command into the
new surface after polling `read-screen` for the prompt (still works; just less clean).

**D. Confirm `new-pane --cwd` actually sets the pane's working directory.** (We rely on the daemon's
`process.cwd()` for the cwd label; verify the spawned pane lands in `--cwd`.)
```sh
env -u CMUX_WORKSPACE_ID cmux --socket "$CMUX_SOCKET_PATH" new-pane --direction down --cwd /tmp --command "pwd"
# read the new surface and confirm it printed /tmp
```

**E. Confirm `CMUX_SURFACE_ID` is a valid global `--surface` ref for `send`/`read-screen`.** (We
already rely on this in `cmux.ts`; reconfirm under the multi-pane scenario that two panes' surface ids
both resolve globally with `CMUX_WORKSPACE_ID` cleared.)
```sh
env -u CMUX_WORKSPACE_ID cmux --socket "$CMUX_SOCKET_PATH" read-screen --surface "$CMUX_SURFACE_ID" --lines 1 && echo OK
```

**F. (In-app, not cmux) Swipe vs. vertical-scroll interaction.** Verify CSS scroll-snap horizontal
paging doesn't fight the vertical message-thread scroll on iOS Safari (touch-action / overscroll
tuning). Verify on a real device once slice 4 has two threads.

**G. (Optional) DO `setAlarm` for revoke-on-exit grace.** Confirm the current `new_sqlite_classes` DO
supports `ctx.storage.setAlarm()` for the grace timer (it does on SQLite-backed DOs); otherwise use a
`lastEmptyAt` timestamp checked on the next connect.

---

## 12. What stays unchanged (scope discipline)

- **The daemon's core** (`VoiceDaemon` injection/queue/reply/speak), the **history ring**, **openai**
  STT/TTS, **qr**, the **Stop-hook reply path**, and the **cmux trust model** are untouched. #7 makes
  identity/bridge/UI plural; it does not re-architect a working daemon.
- The **worker stays a dumb relay** apart from the thread registry + the two security bits
  (revoke-on-exit alarm, rate-limit). It **never** stores conversation content.
- **No system-config changes** (cmux config, `~/.config`): spawn is CLI-only; everything in
  `$CLAUDE_PLUGIN_DATA`. (Project memory: the plugin must work unmodified.)

---

## Sources

This codebase (current-state authority): `src/daemon/standalone.ts` (the shipped #6 daemon +
`shouldReap`), `src/daemon/voice-daemon.ts` (`createDaemonInit`, `emitStatus`, history wiring),
`src/daemon/config.ts` (`stateDir`, `runtimePath`, `qrPath`, 0600 enforcement),
`src/daemon/history-ring.ts` (per-daemon ring), `src/daemon/cmux.ts` (`--surface` global resolution,
`CMUX_WORKSPACE_ID` clear, `read-screen`), `src/shared/protocol.ts` + `src/shared/bridge-contract.ts`
(wire + URL/secret), `worker/src/index.ts` (DO 2-role, `idFromName(sha256(secret))`,
`evictRole("daemon")`, `daemonLastSeenAt`, origin check), `worker/wrangler.toml`,
`web/src/App.tsx`, `web/src/hooks/useBridge.ts`, `web/src/lib/status.ts` (#10 grading),
`web/src/lib/features.ts` (`threadTitle`/`threadNav` flags), `web/src/components/TopBar.tsx` (white
pill), `web/src/components/BottomTabBar.tsx`, `skills/start/SKILL.md`, `skills/stop/SKILL.md`.

Cross-doc: `docs/research/no-mcp-background-daemon.md` (#6 — the standalone daemon this builds on),
`docs/research/visible-background-process.md`.

cmux (CLI — note the two doc sites disagree; the manaflow/mintlify ref is the upstream repo's and is
treated as primary; §11 probes resolve the conflicts):
- Upstream CLI ref (`new-pane --cwd --command`, `new-workspace --cwd --command`, `new-split <dir>`,
  `new-surface`, `send --surface`, `send-key --surface`, `read-screen --surface/--lines/--scrollback`,
  `tree`/`identify`, `--id-format refs|uuids|both`, short refs): https://manaflow-ai-cmux.mintlify.app/automation/cli-reference
- Alternate ref (`list-surfaces`, `new-split`, `CMUX_SURFACE_ID`/`CMUX_SOCKET_PATH`/`CMUX_WORKSPACE_ID`,
  `socketControlMode`): https://cmux.com/docs/api , https://cmux.com/docs/configuration
- `--command` flag for new-split/new-surface/new-pane (issue #2538): https://github.com/manaflow-ai/cmux/issues/2538
- Surface/tab names not exposed via CLI (issue #2761): https://github.com/manaflow-ai/cmux/issues/2761
- Workspace name as Claude session title (issue #5141): https://github.com/manaflow-ai/cmux/issues/5141

Claude Code:
- `SessionStart` hook with `source` ∈ `startup | resume | clear | compact`, payload `session_id` /
  `source` / `cwd` / `hook_event_name`: https://code.claude.com/docs/en/hooks

Cloudflare:
- Rate Limiting binding (`[[ratelimits]]` `namespace_id`, `simple.limit`/`period` ∈ {10,60},
  `env.X.limit({ key })` → `{ success }`; best-effort/per-location/eventually-consistent):
  https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Durable Objects (Hibernatable WebSockets, `serializeAttachment`, `setAlarm`, storage):
  https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ,
  https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
</content>
</invoke>
