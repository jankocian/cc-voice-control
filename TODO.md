# voice-control — TODO

Roadmap for the voice remote. The **phone is the primary surface** — every UI decision
is mobile-first, minimal, and beautiful. Implementation constraint: never edit system
config; the plugin must work unmodified.

---

## 1. Switch TTS + STT to OpenAI

Replace ElevenLabs with OpenAI for both directions — it's significantly cheaper.

- [ ] Daemon-side **speech-to-text** via OpenAI (transcribe the recorded clip the browser uploads).
- [ ] Daemon-side **text-to-speech** via OpenAI (synthesize Claude's reply, stream back to the browser).
- [ ] **Voice selection** — let the user choose which voice speaks.
  - [ ] Research the available OpenAI TTS voices + models (and any per-voice/instruction options).
  - [ ] Add the chosen voice to config (`~/.config/voice-remote/config.json`).
  - [ ] **Surface voice choice in the web UI** (a picker), so it can change per-session.
- [ ] Remove the now-unused ElevenLabs SDK assets, CSP origins (jsdelivr / livekit / elevenlabs), and config.
- [ ] Update docs (`docs/`) + the local-run notes to reflect the new provider + keys.

**Research notes (fill in):** OpenAI TTS model(s), voice IDs, audio formats, streaming support, STT model + pricing vs ElevenLabs.

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

## 3. Web UI/UX overhaul (mobile-first)

Current UI is functional but rudimentary. Make it genuinely beautiful, minimal, and
phone-native. Research references, write a short design MD to lock the visual language,
and use the UI/UX skills.

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

## 4. Keep the screen awake

Main use case is a phone left open during a session.

- [ ] Acquire a **Screen Wake Lock** (`navigator.wakeLock.request("screen")`) while a session is active.
- [ ] Re-acquire on `visibilitychange` (the lock drops when the tab is backgrounded).
- [ ] Release it cleanly when the session ends / page unloads.
- [ ] Graceful fallback when the API is unavailable (older browsers / unsupported).

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

## 8. Migrate the web app to a modern stack (Preact/React + Tailwind + shadcn/ui)

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

## 9. Rename plugin "voice-command" → "voice-control" (repo stays cc-voice-control)

The plugin drifted to **"voice-command"** — that name was never wanted. Canonical names:
**plugin = `voice-control`**, **repo = `cc-voice-control`** (`CC` = Claude Code prefix).
Rename every `voice-command` / `voice_command` occurrence to `voice-control`.

Scope (grounded — files that currently contain `voice-command`):
- [ ] `.claude-plugin/plugin.json` — plugin name (this drives the skill namespace → `/voice-control:*`).
- [ ] `skills/*` — invocation becomes `/voice-control:start|stop|status`; fix in-text references.
- [ ] `src/daemon/mcp-server.ts` — MCP `serverInfo.name` `"voice-command"` → `"voice-control"`.
- [ ] `worker/src/index.ts` — `<title>` + any UI copy.
- [ ] `worker/src/browser-client.ts`, `.mcp.json`, `.claude/settings.local.json`, `README.md`, `docs/configuration.md`.
- [ ] Repo dir is already `cc-voice-control` — keep it.

**Separate decision — `voice-remote` (a different term):** used for the config dir
`~/.config/voice-remote/config.json`, `VOICE_REMOTE_CONFIG`, the `voice-remote-bridge`
worker, and runtime paths. Not part of "voice-command" — handle deliberately:
- [ ] Decide whether `voice-remote` also renames. If yes, **keep back-compat** — still read the legacy `~/.config/voice-remote/config.json` (config.ts already has a legacy fallback) so existing setups don't break, and **never edit the user's system config**.
- [ ] Renaming the Cloudflare worker (`voice-remote-bridge`) / `bridgeUrl` changes the deployed URL — that's a deliberate infra change, not a blind find-replace.

**Acceptance:** `grep -ri "voice-command"` returns nothing in source; skills invoke as `/voice-control:*`; existing configs still load.
