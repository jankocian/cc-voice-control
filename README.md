# Voice Remote for Claude Code

Voice-control your **real interactive Claude Code session** from your phone — no
turn-hijack, no API billing, on your normal subscription.

You speak on a push-to-talk web page; a local daemon transcribes it (ElevenLabs
speech-to-text) and **types it into your live Claude Code pane via the cmux CLI**,
so it lands as a genuine user message and composes with skills, subagents, and
hooks. When Claude finishes a turn, a plugin **`Stop` hook** sends the final reply
back to the daemon, which reads it aloud (ElevenLabs text-to-speech) on your phone.

The daemon runs **inside Claude Code's own process tree** (it's the plugin's MCP
server), which is what lets it drive the cmux pane — a detached background process
loses cmux's trust. Your ElevenLabs key never leaves your machine, and the browser
loads no third-party SDK.

## Requirements

- Claude Code running inside [cmux](https://github.com/manaflow-ai/cmux) (injection
  uses cmux's `send` / `send-key` CLI).
- An ElevenLabs API key and a `voiceId` (see [docs/configuration.md](docs/configuration.md)).
- A reachable bridge URL — deploy the Worker, or run it locally for a desktop test.

## Usage

In your cmux Claude Code pane (the plugin must be loaded, e.g. `claude --plugin-dir .`):

```text
/voice-command:start    # activates the remote, prints the phone URL
/voice-command:status
/voice-command:stop
```

`/voice-command:start` just flips the remote on and returns — your session stays
fully interactive. Open the printed URL on your phone, tap to speak, and your words
appear as messages in this session with replies spoken back.

## How it works

```
phone (push-to-talk)                                   ← single self-contained web page
  │  audio
  ▼
Cloudflare Worker + Durable Object  ── "bridge": a token-authed relay, sees no secrets
  │  relayed WebSocket message
  ▼
MCP server daemon (a child of Claude Code → keeps cmux trust)
  │  ① ElevenLabs STT → transcript
  │  ② cmux send + send-key → types it into your live pane
  ▼
Claude Code runs the turn normally (your subscription)
  │
  ▼  Stop hook reads the turn's final reply (skips tool-call narration via stop_reason)
daemon  ── ③ ElevenLabs TTS ──►  bridge ──►  phone speaks the reply
```

- **Activation** is a flag file in the plugin's data dir (`$CLAUDE_PLUGIN_DATA`);
  the MCP server watches it. No tool calls, so Claude never shows "Generating".
- **Billing**: the daemon never spawns a model — Claude runs in your interactive
  session, so usage counts against your Claude plan, not the API.

## Security (what to check before you trust this)

This plugin is small on purpose so you can audit it. The trust boundaries:

- **The bridge (`worker/`) is a dumb relay.** It authenticates a session by a hashed
  token, relays WebSocket messages between the phone and the daemon, and stores
  nothing else. It never sees your ElevenLabs key or your transcripts in plaintext
  beyond passing the envelope through. See `worker/src/index.ts`.
- **The ElevenLabs key stays local.** Only the daemon reads the config file and calls
  `api.elevenlabs.io` (STT + TTS). The key is never sent to the bridge or the phone.
  See `src/daemon/elevenlabs.ts` — those are the only outbound calls the daemon makes
  besides the bridge WebSocket.
- **The phone page loads no third-party code.** Audio is captured with `MediaRecorder`,
  replies play from in-memory `blob:` URLs, and the page CSP is `'self'`-only with a
  per-request nonce (`default-src 'self'; connect-src 'self'; …`). See `worker/src/index.ts`.
- **Injection is plain cmux CLI** (`cmux send` / `send-key`) into the pane the daemon
  runs in. No system config is modified. See `src/daemon/cmux.ts`.

## Layout

- `.mcp.json` — registers the daemon as the plugin's MCP server (the single entry point).
- `src/daemon/mcp-server.ts` — MCP host + flag-file activation.
- `src/daemon/voice-daemon.ts` — the session: bridge client, STT/TTS, cmux injection.
- `src/daemon/{cmux,elevenlabs,config}.ts` — cmux CLI, ElevenLabs calls, config loading.
- `hooks/` — the `Stop` hook that returns each turn's final reply.
- `skills/` — `start` / `stop` / `status`.
- `src/shared/` — the wire protocol and bridge URL contract (shared by daemon + worker).
- `worker/` — the Cloudflare bridge and the phone page.

## Development

```sh
npm install
npm run build      # produces dist/ (the plugin loads dist/daemon/mcp-server.js)
npm test
npm run typecheck
npm run dev:worker # run the bridge locally on http://localhost:8787
```
