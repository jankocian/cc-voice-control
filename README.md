# Voice Remote for Claude Code

Voice-control your **real interactive Claude Code session** from your phone — no
turn-hijack, no API billing, on your normal subscription.

You speak on a push-to-talk web page; a local daemon transcribes it (OpenAI
speech-to-text) and **types it into your live Claude Code pane via the cmux CLI**,
so it lands as a genuine user message and composes with skills, subagents, and
hooks. When Claude finishes a turn, a plugin **`Stop` hook** sends the final reply
back to the daemon, which reads it aloud (OpenAI text-to-speech) on your phone.

The daemon runs **inside Claude Code's own process tree** — `/voice-control:start`
launches it as a **visible, killable background task** (the kind shown in `/tasks`),
which is what lets it drive the cmux pane: a detached background process loses cmux's
trust. Your OpenAI key never leaves your machine, and the browser loads no third-party SDK.

## Requirements

- Claude Code running inside [cmux](https://github.com/manaflow-ai/cmux) (injection
  uses cmux's `send` / `send-key` CLI).
- An OpenAI API key (see [docs/configuration.md](docs/configuration.md)).
- A reachable bridge URL — deploy the Worker, or run it locally for a desktop test.

## Install

```text
/plugin marketplace add jankocian/cc-voice-control
/plugin install voice-control@cc-voice-control
```

The daemon ships pre-built as a single self-contained `dist/daemon/standalone.js`
(dependencies inlined), so there's no build step on install. Add your OpenAI config
(see [docs/configuration.md](docs/configuration.md)), then run `/voice-control:start`.

## Usage

In your cmux Claude Code pane (the plugin must be loaded, e.g. `claude --plugin-dir .`):

```text
/voice-control:start    # activates the remote, prints a scannable QR code + phone URL
/voice-control:status
/voice-control:stop
```

`/voice-control:start` launches the voice daemon as a background task, prints the QR
code, and returns — your session stays fully interactive, and the task is visible and
killable in `/tasks`. Scan the printed QR code with your phone (or open the URL beneath it),
tap to speak, and your words appear as messages in this session with replies spoken back.

## How it works

```
phone (push-to-talk)                                   ← single self-contained web page
  │  audio
  ▼
Cloudflare Worker + Durable Object  ── "bridge": a token-authed relay, sees no secrets
  │  relayed WebSocket message
  ▼
background-task daemon (a child of Claude Code → keeps cmux trust)
  │  ① OpenAI STT → transcript
  │  ② cmux send + send-key → types it into your live pane
  ▼
Claude Code runs the turn normally (your subscription)
  │
  ▼  Stop hook reads the turn's final reply (skips tool-call narration via stop_reason)
daemon  ── ③ OpenAI TTS ──►  bridge ──►  phone speaks the reply
```

- **Activation** launches the daemon as a Claude Code background task (`run_in_background`),
  which keeps it inside cmux's process tree. It's visible and killable in `/tasks`, and
  `/voice-control:stop` (or stopping the task) tears it down.
- **Billing**: the daemon never spawns a model — Claude runs in your interactive
  session, so usage counts against your Claude plan, not the API.

## Security (what to check before you trust this)

This plugin is small on purpose so you can audit it. The trust boundaries:

- **The bridge (`worker/`) is a dumb relay.** It authenticates a session by a hashed
  token, relays WebSocket messages between the phone and the daemon, and stores
  nothing else. It never sees your OpenAI key or your transcripts in plaintext
  beyond passing the envelope through. See `worker/src/index.ts`.
- **The OpenAI key stays local.** Only the daemon reads the config file and calls
  `api.openai.com` (STT + TTS). The key is never sent to the bridge or the phone.
  See `src/daemon/openai.ts` — those are the only outbound calls the daemon makes
  besides the bridge WebSocket.
- **The phone page loads no third-party code.** Audio is captured with `MediaRecorder`,
  replies play from in-memory `blob:` URLs, and the page CSP is `'self'`-only with a
  per-request nonce (`default-src 'self'; connect-src 'self'; …`). See `worker/src/index.ts`.
- **Injection is plain cmux CLI** (`cmux send` / `send-key`) into the pane the daemon
  runs in. No system config is modified. See `src/daemon/cmux.ts`.

## Layout

- `.claude-plugin/plugin.json` — plugin manifest; skills and hooks are auto-discovered from `skills/` and `hooks/hooks.json`.
- `src/daemon/standalone.ts` — the daemon entry point: starts the session, traps SIGTERM/SIGINT for clean shutdown, and self-reaps if orphaned.
- `src/daemon/voice-daemon.ts` — the session: bridge client, STT/TTS, cmux injection.
- `src/daemon/{cmux,openai,config}.ts` — cmux CLI, OpenAI calls, config loading.
- `hooks/` — the `Stop` hook (returns each turn's final reply) and the `SessionStart` hook (resets thread history on `/clear` · `/compact`).
- `skills/` — `start` / `stop` / `status` / `spawn` (open a new voice-controlled session in another workspace).
- `src/shared/` — the wire protocol and bridge URL contract (shared by daemon + worker).
- `worker/` — the Cloudflare bridge and the phone page.

## Development

Tooling is [Bun](https://bun.sh) (package manager + bundler) and [Biome](https://biomejs.dev)
(lint + format).

```sh
bun install
bun run build       # bundles the daemon → dist/daemon/standalone.js (deps inlined)
bun run test
bun run typecheck
bun run lint        # Biome — the CI gate (read-only)
bun run format      # Biome — apply fixes
bun run dev:worker  # run the bridge locally on http://localhost:8787
```

The committed `dist/daemon/standalone.js` is the artifact Claude Code runs — there is no
install-time build. **CI is the source of truth for it**: `release.yml` rebuilds and commits
the bundle (with a pinned Bun, so output is reproducible) on every push to `main`, so you never
build it by hand. `ci.yml` runs the same gate on every PR. Versioning and tagging are
automated from `package.json` — see [RELEASING.md](RELEASING.md).

## Deploy the bridge

The phone page + relay live in `worker/` (a Cloudflare Worker + Durable Object). Wrangler
bundles it from source at deploy time:

```sh
bun run deploy:worker   # needs a Cloudflare login or CLOUDFLARE_API_TOKEN
```

It deploys automatically as part of a release: when a version bump lands on `main`,
`release.yml` calls `deploy-worker.yml` (set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
as repo secrets). You can also redeploy out-of-band any time from the Actions tab
(`deploy-worker` → Run workflow). See [RELEASING.md](RELEASING.md). Once it's live, point each
user's config `bridgeUrl` at the deployed URL.
