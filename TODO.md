# voice-control — TODO

Roadmap for the voice remote. The **phone is the primary surface** — every UI decision
is mobile-first, minimal, and beautiful. Implementation constraint: never edit system
config; the plugin must work unmodified.

---

## Status snapshot (reconciled 2026-06-20)

**Shipped in `main`:** **#1** OpenAI STT/TTS swap (`01f9ab6`), **#2** QR, **#4** wake lock,
**#8** React/Tailwind/shadcn/Vite stack (Worker serves the built SPA via the ASSETS binding +
`'self'` CSP), **#9** rename, **#10** session-offline UX (`29be351`, PR #13), **#11** durable
replayable history (`a3846e1`, PR #14), **#12** long-reply TTS chunking (`05f8229`, PR #12).
**#3** UI overhaul is ~90% done via PRs #4–#8 (hero status visual, contextual red stop, iMessage
bubbles, inline playback + scrubber, condensed sticky bar) — the remaining gaps are the **design
MD (#3e)** and a *fully* sticky hero (today only the condensed bar sticks).

**Open — roughly in priority order:**
- **#3e** design MD + **#3f** fully-sticky hero (the only #3 remainders).
- **#1** web voice picker (the one sub-task of the OpenAI swap still open — daemon `voiceOverride` plumbing exists; UI + a `set_voice` event remain).
- **#5** `/btw` side questions (small, verification-gated), **#6** visible/killable bg process (research), **#7** multi-session threads (deep research + design doc first).

---

## 1. Switch TTS + STT to OpenAI ✅

Replace ElevenLabs with OpenAI for both directions — it's significantly cheaper. **Done** in
`01f9ab6` (PR #9). STT = `gpt-4o-mini-transcribe`, TTS = `gpt-4o-mini-tts` (mp3), voice `marin`,
all overridable in config; ElevenLabs code + CSP origins removed; `src/daemon/openai.ts` (+tests).

- [x] Daemon-side **speech-to-text** via OpenAI (transcribe the recorded clip the browser uploads).
- [x] Daemon-side **text-to-speech** via OpenAI (synthesize Claude's reply, stream back to the browser).
- [x] **Voice selection** — config-level (`openaiVoice`); `synthesizeSpeech` already accepts a per-call `voiceOverride`.
  - [x] Research the available OpenAI TTS voices + models — see `docs/research/openai-tts-stt.md`.
  - [x] Add the chosen voice to config (`$CLAUDE_PLUGIN_DATA/config.json`).
  - [ ] **Surface voice choice in the web UI** (a picker), so it can change per-session — the daemon
        plumbing (`voiceOverride`) exists; the UI picker + a `set_voice` event are still TODO.
- [x] Remove the now-unused ElevenLabs SDK assets, CSP origins (jsdelivr / livekit / elevenlabs), and config.
- [ ] Update docs (`docs/`) + the local-run notes to reflect the new provider + keys.

**Research notes:** Full write-up in [`docs/research/openai-tts-stt.md`](docs/research/openai-tts-stt.md)
(verified vs live OpenAI docs, 2026-06-19). Recommend **TTS `gpt-4o-mini-tts`** (steerable via an
`instructions` param; 13 voices, default **`marin`**, fallback `alloy`) returning **`mp3`/`audio/mpeg`**
— a byte-identical contract to today, so no browser/CSP change. **STT `gpt-4o-mini-transcribe`**
(`POST /v1/audio/transcriptions`, accepts our `webm`/`mp4` uploads). Both functions mirror
`elevenlabs.ts` (`transcribeAudio`, `synthesizeSpeech`) → new `src/daemon/openai.ts`; config swaps
`elevenlabsApiKey`/`voiceId` for `openaiApiKey`/`voice`. **Cost ≈ 6–15× cheaper end-to-end** (TTS
driven), e.g. ~$10/mo vs ~$60–180/mo at 1k turns. Voice picker: persisted config default + per-session
`set_voice` over the bridge.

---

## 2. QR code to open the remote ✅

Scanning beats copy-pasting a link to a phone.

- [x] The Claude Code chat (`/voice-control:start`) returns a **scannable QR code** encoding the session URL.
- [x] Render it so it's visible directly in the Claude Code terminal/chat (ASCII/Unicode QR).
- [x] Keep the plain URL as a fallback (for desktop / copy-paste).

**Implemented:** the daemon pre-renders a half-block Unicode QR of the phone URL to
`$CLAUDE_PLUGIN_DATA/qr.txt` (next to `runtime.json`); the start/status skills print it into the
chat inside a fenced code block, with the `sessionUrl` beneath it as a fallback. Encoder is
`qrcode-generator` (ECC L for the smallest, least-wrap-prone code, bundled into the daemon by
`bun build`); rendering uses foreground-only glyphs so it's theme-agnostic. `src/daemon/qr.ts` +
tests (`qr.test.ts`) include a `jsqr` round-trip that proves the rendered code decodes back to
the URL.

---

## 3. Web UI/UX overhaul (mobile-first) — ~90% done

Current UI is functional but rudimentary. Make it genuinely beautiful, minimal, and
phone-native. Research references, write a short design MD to lock the visual language,
and use the UI/UX skills.

**Status (PRs #4–#8):** built on the new React stack. **Done:** 3a hero status visual
(`StatusVisual.tsx`), 3b contextual red stop (`Controls.tsx`/`MiniControls.tsx`), 3c iMessage
bubbles (`MessageBubble.tsx`/`MessageThread.tsx`), 3d inline playback + draggable scrubber
(`InlineAudioPlayer.tsx`/`usePlayback.ts`). **Remaining:** the **design MD (3e)** is not written,
and the hero is only *condensed-bar* sticky, not fully sticky (3f).

### 3a. Status monitor (the hero)

- [ ] Big, centered, **huge typography** for state (Ready / Listening / Transcribing / Working / Speaking).
- [ ] **Square** area (width = height).
- [ ] **Full-bleed saturated background** that fills the whole area — not an outlined card.
- [ ] Background + motion change per state (calm when idle, alive when active).
- [ ] Use the **Claude Code brand color** and the **Claude star/sunburst logo**, animated (e.g. pulsing) so it reads as "something is happening".
- [ ] Distinct, beautiful animation for **audio ingest** (while recording the user's voice).
- [ ] Distinct, beautiful animation for **Claude working**.

### 3b. Stop button (contextual)

- [ ] Show a **Stop** button (stop icon, red) **only while Claude is working**.
- [ ] Place it in a corner of the monitor (upper- or lower-right).
- [ ] Remove the standalone "Stop" ghost button (it only makes sense while Claude works).

### 3c. Messages → iOS-style chat

- [ ] Remove the "Activity" heading (meaningless).
- [ ] Restructure messages as a natural **chat (iMessage / WhatsApp style)**:
  - [ ] **My messages right-aligned**, **Claude's left-aligned**, as speech bubbles.
  - [ ] Make them genuinely beautiful, not rudimentary rows.

### 3d. TTS playback controls (per Claude message)

- [ ] While playing back Claude's reply, show a **playback progress indicator** — e.g. the bubble's bottom border fills as it plays.
- [ ] Add a **draggable knob/scrubber** the user can touch to seek / fast-forward / skip to the end.

### 3e. General polish

- [ ] Clean, minimal, cohesive — one consistent type + motion language throughout.
- [ ] Optimized for small phone screens (touch targets, safe-area, one-hand reach).
- [ ] Write a short **design MD** documenting tokens, states, and motion so it stays coherent.

### 3f. Sticky hero + controls

- [ ] The hero recording area **and** the main controls stay **pinned/sticky at the top**.
- [ ] Only the **chat/messages** scroll beneath them — the mic + primary actions remain reachable at all times.

---

## 4. Keep the screen awake ✅

Main use case is a phone left open during a session. **Done** in `browser-client.ts`.

- [x] Acquire a **Screen Wake Lock** (`navigator.wakeLock.request("screen")`) while a session is active.
- [x] Re-acquire on `visibilitychange` (the lock drops when the tab is backgrounded).
- [x] Release it cleanly when the session ends / page unloads.
- [x] Graceful fallback when the API is unavailable (older browsers / unsupported).

---

## 5. Independent status/summary while Claude is busy (Claude Code `/btw`)

Use Claude Code's **native `/btw` side-question command** for **Get Summary** and **Get
Status** when a task is already running. `/btw` is available while Claude is working: it
runs **independently, does not interrupt the main turn**, and answers from the current
session context in an ephemeral overlay (out of conversation history). It **cannot run
tools** — it answers from what's already in context, which is exactly right for a quick
status/summary. (Ref: Claude Code interactive-mode docs → "Side questions with /btw".)

- [ ] When a task is **already running**, send **Get Summary** / **Get Status** as `/btw <question>` into the live pane (via the existing send path) so it's processed **independently** and returns a **brief status** without interrupting or queuing behind the running task.
- [ ] When **no task is running**, use the normal send path (a regular prompt).
- [ ] **Open question to resolve:** the `/btw` answer renders in a dismissible overlay, _not_ in conversation history — confirm how the daemon captures that answer to speak it back over the voice channel (the normal reply path is an MCP tool Claude calls; `/btw` may bypass it). Verify before building.
- [ ] NOTE: this is a **Claude Code native command**, not cmux — no cmux `btw` exists.

---

## 6. Make the voice session a visible, killable background process

Right now starting voice mode gives **no indication** it's active and **nothing to kill** — it just runs silently. Make it transparent.

**Why it's invisible today (researched in-code):** the daemon is hosted _inside_ the
plugin's **MCP server**. Claude Code spawns MCP servers as **children of the Claude
process**, so the daemon stays in cmux's process tree and keeps the **socket trust**
needed to `cmux send` into the pane (`mcp-server.ts:9-15`, `voice-daemon.ts:43-45`). A
detached `nohup &` process gets reparented to launchd and cmux rejects its keystrokes.
So `/voice-control:start` just flips a flag file the MCP server polls every 1s — no
session-visible process. Replies come back via the **plugin Stop hook → HTTP POST**, not
MCP tools, so **MCP isn't actually needed for replies**.

**Goal:** run the session as a **visible Claude Code background process** (the kind shown
in `/bashes`, killable) so it's obvious voice is active and the user can kill it to end
the session.

- [ ] Research: does a Claude Code **background Bash task** (started by Claude) stay a **child of the Claude process** and thus **retain cmux socket trust** (unlike `nohup`)? If yes, this is the clean path.
- [ ] If viable, have `/voice-control:start` launch the daemon as a **managed background task** instead of (or in addition to) the MCP host — visible in `/bashes`, killable.
- [ ] Killing the background process should **cleanly tear down** the session (SIGTERM → close WS + local HTTP server, remove runtime/flag files).
- [ ] Keep the existing **Stop-hook → HTTP POST** reply path (it doesn't depend on MCP) — likely lets us drop the MCP host entirely.
- [ ] Give a clear **"voice mode active"** indication at start (the visible process itself + printed URL/QR).
- [ ] Verify trust + teardown end-to-end before removing the MCP host.

---

## 7. Multiple Claude Code sessions per computer — one URL, multiple threads

**Vision:** **one phone app / one URL + QR per machine** that multiplexes **multiple
Claude Code instances** as switchable **threads**. Spin up another cmux pane (optionally
**by voice**) → it joins the **same** session as a new thread (same QR), so you can
interact with instance B while instance A is still working. High-value; must be flawless
— do **deep research + a written design doc before coding**.

**Current state (researched in-code):**

- State lives in `$CLAUDE_PLUGIN_DATA` as **single files** — one `active` flag and one `runtime.json` (`config.ts:32-38`) — shared across all Claude Code instances on the machine.
- Each daemon activation mints a **fresh random `sessionId` + `token` → a new URL** (`voice-daemon.ts:26-34`).
- Bridge Durable Object is keyed by `sessionId` with exactly two roles `{daemon, browser}` (worker `index.ts`).
- ⇒ **One session per machine** in practice; two panes collide on the shared flag/runtime files and produce separate, clobbering URLs. Confirms the single-connection limitation.

**Target architecture (design + deeply research each):**

- [ ] **Machine-level session identity** — reuse one stable `sessionId`/`token` (one URL/QR) across all panes, stored once in `stateDir` and shared; work out token expiry/rotation/revocation.
- [ ] **Multi-thread bridge** — one session/DO holds **N daemon connections** (one per instance) + browser(s); every envelope carries a **`threadId`**; browser→daemon routes to the selected thread; daemon→browser is tagged so the browser attributes it.
- [ ] **Thread registry + labels** — each daemon registers as a thread with a human label (cmux surface/pane title, cwd, git branch) + per-thread status (idle/working/…); lifecycle + presence events so the UI can list and switch.
- [ ] **Replace singleton state** — per-thread registration instead of one shared `active` / `runtime.json` (no clobbering); clean removal when a pane dies.
- [ ] **Spawn-a-thread (incl. by voice)** — research cmux's API to open a new pane + launch Claude there running `/voice-control:start`, joining the same session (re-show same QR). Stay within "never touch system config" — cmux CLI only.
- [ ] **Web UI** — a **thread switcher** (chat-list / tabs), per-thread status + unread badges; hero monitor + chat scoped to the active thread. Depends on **#3**.
- [ ] **Security** — one token now reaches multiple instances; evaluate per-thread tokens vs one session token, blast radius, expiry, revoke-on-exit.
- [ ] Cross-refs: **#2** (same URL/QR reused), **#3** (thread switcher UI), **#6** (each thread = a visible background process).

---

## 8. Migrate the web app to a modern stack (Preact/React + Tailwind + shadcn/ui) ✅

**Done** (PR #4 + follow-ups). Shipped as **React 19 + Tailwind v4 + shadcn/ui (Base UI) + Vite**
in `web/`; the Worker serves the built SPA from `web/dist` via the **ASSETS binding** (hashed
`/assets/*` resolved from the Vite manifest) and keeps owning `/s/<secret>` + `/ws/<secret>`. CSP
moved from nonce'd inline to `script-src 'self'` / `style-src 'self'`. State lives in hooks
(`useBridge`/`usePlayback`/`useRecorder`/…). Note: the wire protocol is a re-export — `web/src/lib/
protocol.ts` re-exports `src/shared/protocol.ts`, so there is ONE source of truth (no fork).

**Do this first — it's the foundation for the UI/UX overhaul (#3).** Today the web UI is
**server-rendered vanilla JS**: the Worker inlines an HTML page with a nonce'd `<style>`
block and a hand-rolled JS module string (`worker/src/index.ts`, `browser-client.ts`).
Hand-managing WebSocket/session state this way is cumbersome and gets worse with the chat
redesign (#3) and multi-thread (#7).

**Goal:** the regular modern stack — a component framework + Tailwind + shadcn/ui — for
sane state and beautiful prebuilt **chat/conversation components**.

- [ ] Pick framework: **Preact + `preact/compat`** (≈4 KB, ideal for a phone) vs React — shadcn/ui + Tailwind work with either; lean Preact for bundle size unless something needs full React.
- [ ] Add a **build pipeline** (Vite) emitting a small SPA bundle, served from the Worker (static assets via wrangler `[assets]` / ASSETS binding — currently unused); the Worker keeps owning the `/s/<sessionId>` route + the WebSocket DO.
- [ ] **Tailwind** (v4) + **shadcn/ui**; use its chat/message components for the iMessage-style thread (feeds #3c).
- [ ] Proper **state management** (hooks + reducer / small store) for the WS connection, session, playback, and per-thread state (#7).
- [ ] Read `sessionId` / `token` / `expiresAt` from the URL (already in path + query) — likely no server-side injection needed.
- [ ] **Update the CSP** for the new asset model: built JS/CSS from `'self'` (or hashed) instead of the current `'nonce-…'`-only `script-src`/`style-src`; verify Tailwind's stylesheet passes CSP.
- [ ] Preserve behavior parity during the swap (push-to-talk record/upload, TTS playback, status states, reconnect); migrate `browser-client.ts` logic into hooks/components.
- [ ] Keep the bundle lean — it loads on a phone, possibly over cellular.

**Ordering:** **#8 → #3** (build the overhaul on the new stack); #8 also makes **#7**'s multi-thread state much easier.

---

## 9. Rename plugin "voice-command" → "voice-control" (repo stays cc-voice-control) ✅

The plugin had drifted to **"voice-command"** — never wanted. Canonical names:
**plugin = `voice-control`**, **repo = `cc-voice-control`** (`CC` = Claude Code prefix).
**Done** — no `voice-command` left anywhere in source.

Scope (all `voice-command` → `voice-control`, completed):
- [x] `.claude-plugin/plugin.json` — plugin name (drives the skill namespace → `/voice-control:*`).
- [x] `skills/*` — invocation is `/voice-control:start|stop|status`.
- [x] `src/daemon/mcp-server.ts` — MCP `serverInfo.name` → `"voice-control"`.
- [x] `worker/src/index.ts` — `<title>` + UI copy.
- [x] `worker/src/browser-client.ts`, `README.md`, `docs/configuration.md` (`.mcp.json` was folded into `plugin.json`).
- [x] Repo dir is `cc-voice-control`.

**Decision on `voice-remote` (a different term):** the `VOICE_REMOTE_CONFIG` env var and the
`voice-remote-bridge` worker keep their names to avoid breaking the deployed URL. Config lives
only in the plugin's managed data dir (`$CLAUDE_PLUGIN_DATA/config.json`) or an explicit
`$VOICE_REMOTE_CONFIG` path — never `~/.config`.

**Acceptance (met):** `grep -ri "voice-command"` returns nothing in source; skills invoke as `/voice-control:*`.

---

## 10. Connection staleness → honest "Session offline" UX ✅

**✅ Shipped** in `29be351` (PR #13): the worker DO persists `daemonLastSeenAt` (stamped on a daemon
socket close), rides it on `bridge_presence`, and the browser grades the not-connected state by elapsed
time — waiting (never seen) / reconnecting (<90s) / "Session offline — last active X ago" (≥90s), with a
clock that ticks only while disconnected. Messaging only (no spawn action); mic stays disabled offline.

**Problem (observed live):** open the phone page from a session that ended overnight (laptop off)
and it still reads **"Waiting for Claude Code"** — the same optimistic copy you'd see during a 2-second
reconnect. It implies the daemon is about to appear when it almost certainly won't.

**Root cause:** presence is a **pure boolean with no time dimension.** The DO broadcasts
`bridge_presence { daemonConnected }` (`src/shared/protocol.ts:36`) and the browser maps
`!daemonConnected` → the single "waiting" state (`web/src/lib/status.ts:57-60`). Nothing records
*when* the daemon was last seen, so "reconnecting" and "dead since last night" are indistinguishable.

**Fix — add a last-seen timestamp and grade the state by elapsed time:**

- [ ] **DO persists `daemonLastSeenAt`** in `ctx.storage` (survives the laptop being off — DO storage
      lives on Cloudflare, persists indefinitely until deleted). Stamp it whenever a **daemon** socket
      closes (`webSocketClose`/`webSocketError` in `worker/src/index.ts`, guarded to role `daemon`).
      Note: a clean `/stop` still `deleteAll()`s via `expireSession`, so a terminated session has no
      stale timestamp; only an *ungraceful* drop (laptop sleep/off) leaves one — exactly what we want.
- [ ] **Presence carries it** — add `daemonLastSeenAt: number | null` to `bridge_presence` (absolute
      epoch ms; phone↔CF clock skew is NTP-negligible for a minutes/hours judgment, so the phone can
      tick a live "last active 3h ago" with no re-poll). Mirror into `web/src/lib/protocol.ts` (re-export).
- [ ] **Browser grades the "waiting" branch** in `status.ts` + `useBridge.ts`:
  - never connected (`null`) → keep today's "Waiting for Claude Code / Start the daemon in your terminal".
  - dropped recently (< ~60–90s) → **"Reconnecting…"** (don't alarm — the laptop may just be napping).
  - gone a long time → a new **"Session offline"** state: *"Last active 14h ago. Wake your laptop to
    resume, or start a new session."*
- [ ] Disable the mic/controls in the "Session offline" state (no daemon to receive a turn).

**Scope guard:** the phone **cannot spawn a new session** when nothing is running on the laptop, and
re-running `/voice-control:start` today mints a *fresh* secret → a different URL the old tab can't adopt.
So #10 is **messaging only** — true resume/restart-from-phone needs a persistent listener (#6) + a
stable per-machine URL (#7). Keep this item honest and small; don't build a fake "start" button.

**Files:** `worker/src/index.ts` (DO storage + presence), `src/shared/protocol.ts`, `web/src/lib/status.ts`,
`web/src/hooks/useBridge.ts`. The DO stores ONE timestamp, never content — minimal posture change, no
encryption needed.

---

## 11. Durable, replayable conversation history (daemon ring + reconciliation) ✅

**✅ Shipped** in `a3846e1` (PR #14): the daemon keeps a ring of the last `HISTORY_REPLIES = 7` Claude
replies (text + mp3 audio) plus their parent user messages, each with a monotonic `seq` + `timestamp`
(ring bounded by a total-entry ceiling). On reconnect it answers `sync` with a text-only `history` event;
reply audio is fetched per row on demand (`get_audio` → tap-to-play, graceful miss). The browser
reconciles history + live events by `seq` (dedup by `requestId`). No worker changes; no localStorage;
the old single-`lastReply`/`lastSeenReplyId` path was removed. Live-session only by design (a dead
session is #10's "Session offline").


**Problem (observed live):** (a) refreshing the phone, or opening it on a **second device/browser**,
loses the whole thread — history lives **only in browser React state** (`web/src/App.tsx` `messages`,
capped `MAX_LOG = 60`) and is wiped on reload; (b) the main use case is **re-listening to replies**
while walking/driving, but cached reply audio is **JS-heap only** (`usePlayback.ts` `audioByRequest`
Map) and also dies on refresh; (c) the daemon currently retains just the **single** latest reply
(`voice-daemon.ts` `lastReply` / `selectMissedReply`), so even reconnect only catches up one message.

**Approach (chosen — no new infrastructure; daemon + web only, the Cloudflare bridge stays a dumb
relay):** the **daemon keeps a small ring of recent turns** and the phone **reconciles** against it
on (re)connect.

- [ ] **Daemon ring** — replace the single `lastReply` with a ring of the last **`HISTORY_REPLIES = 7`**
      Claude replies **plus their parent user messages** (tunable constant). Replies keep **text + audio
      (mp3)** in daemon process RAM; user messages keep **text only**. (7 × even a long reply ≈ tens of MB
      in-process — trivial for a laptop; see #12 re: how long replies inflate this.)
- [ ] **Sequence + timestamp** — the daemon assigns a **monotonic `seq` + `timestamp`** to every
      message (user and reply) at creation, so ordering and dedup are deterministic even when messages
      arrive interleaved or out of order.
- [ ] **Reconnect = text now, audio on demand** — on `sync`, the daemon sends the last-N turns as
      **TEXT** (each with `seq` + `timestamp` + `requestId`) via a new **`history`** event. It does **not**
      push audio (iOS Safari drops the socket on every backgrounding → constant reconnects; re-pushing
      ~tens of MB each time would be brutal on cellular). Generalizes today's `lastSeenReplyId` path.
- [ ] **Audio on demand** — new **`get_audio { requestId }`** (browser→daemon); the daemon replies with
      `tts_audio` (replay-flagged) **only when the user taps play** and only if the clip is still in the
      ring. Keeps the existing rule: a *freshly-arrived live* reply still auto-plays; history/replayed
      ones are tap-to-play.
- [ ] **Browser reconciliation** — merge incoming `history` + live events by `seq`, dedup by
      `requestId`, render ordered by `seq`/`timestamp` (`web/src/App.tsx`, `web/src/lib/messages.ts`,
      `web/src/hooks/useBridge.ts`, `web/src/hooks/usePlayback.ts`). This **replaces** today's
      ephemeral-only state and **obviates localStorage** (the daemon ring *is* the persistence).
- [ ] **Tests** — ring eviction (keeps exactly N reply-turns + parents), seq ordering, reconnect
      reconciliation/dedup, `get_audio` hit/miss (evicted clip → graceful "no longer available").

**Conscious tradeoff:** the daemon dies with the Claude Code session, so this covers **live-session**
history only (refresh / second device *while the session is alive* — the real car scenario). A
**dead** session (laptop off) is correctly handled by **#10's** "Session offline", not here. This line
is deliberate: it's why we **don't** need an always-on R2/Durable-Object store, client-side encryption,
or any worker change. (Researched alternatives — laptop file, DO storage, localStorage, R2 for audio —
all rejected for this; the daemon ring is the minimal correct design.)

**Open question to fold in:** the exact **multi-browser** glitch the user saw (duplicate messages? one
browser stealing the session? blank history on the 2nd?) — confirm the symptom and make sure the
reconciliation + presence model covers it (the worker dedups only the *daemon* role; two browsers are
both allowed and both get the `history` backfill, which should fix "2nd browser has no history").

**Files:** `src/shared/protocol.ts` (+`web/src/lib/protocol.ts` re-export) for `seq`/`timestamp` +
`history` + `get_audio`; `src/daemon/voice-daemon.ts` (ring, seq counter, sync→history, get_audio,
store user text on `transcript`); `web/src/hooks/useBridge.ts`, `web/src/App.tsx`,
`web/src/lib/messages.ts`, `web/src/hooks/usePlayback.ts`.

---

## 12. Long-reply TTS: bump the speech cap + sentence-chunk past the OpenAI per-call limit ✅

**✅ Shipped** in `05f8229` (PR #12): `synthesizeSpeech` is transparently chunked — ≤4096 chars → one
call; longer → split on sentence boundaries into ≤4096-char chunks (surrogate-safe hard-split fallback),
synthesize each, `Buffer.concat` the mp3s. Truncation retired (`MAX_SPEECH_CHARS` is now a 40k safety
ceiling). A late chunk failure speaks the partial audio rather than dropping the whole reply.
⚠️ One manual on-device check pending: confirm concatenated mp3s play seam-click-free on iOS Safari.


**Problem:** replies are hard-truncated at **`MAX_SPEECH_CHARS = 2500`** (`voice-daemon.ts:24`,
`capForSpeech`), ~2.5–3 min of speech. This is a **coding agent** — long replies are real, and
silently dropping the tail of a spoken answer is bad. OpenAI `/audio/speech` accepts **≤ 4096 chars
per call** (`src/daemon/openai.ts`), so the cap can't simply be removed.

- [ ] **Bump the cap** `2500 → 4096` for the single-call fast path (one call, ~4–5 min).
- [ ] **Chunk for longer replies** — split the text on **sentence boundaries** into ≤4096-char chunks,
      `synthesizeSpeech` each, and **concatenate the mp3 buffers** (mp3 frames concatenate cleanly →
      one continuous clip). Return the combined base64. Keep it small + elegant (a few lines in
      `openai.ts`); **no reply ever gets truncated again.**
- [ ] **Tests** in `openai.test.ts` — chunk splitting (boundary cases, a single >4096-char sentence),
      and that concatenated output is well-formed.

**Relation to #11:** longer replies = bigger audio blobs held in the #11 ring, so build #12 aware of
the ring's memory footprint (and vice-versa). They pair naturally but are independently grabbable.
