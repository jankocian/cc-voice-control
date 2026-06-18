# Voice Remote for Claude Code

Voice-control an active Claude Code session from your phone. A Claude Code plugin
exposes a local MCP daemon that bridges, via a Cloudflare Durable Object, to a
push-to-talk web page: you tap to record, the daemon transcribes your speech
(ElevenLabs speech-to-text) and forwards it to Claude Code, and Claude's reply is
read back aloud (ElevenLabs text-to-speech). The browser loads no third-party SDK
and the ElevenLabs API key never leaves your machine.

## User Command

After installing the plugin in Claude Code, start a session with:

```text
/voice-command:start
```

Other commands:

```text
/voice-command:status
/voice-command:stop
```

## Components

- Claude Code plugin skills in `skills/`
- MCP daemon in `src/daemon/`
- Shared event protocol in `src/shared/`
- Cloudflare Worker and Durable Object bridge in `worker/`
- ElevenLabs speech-to-text / text-to-speech setup in `docs/elevenlabs-agent.md`

## Development

```sh
npm install
npm run build
npm test
```

Run the Worker locally:

```sh
npm run dev:worker
```

Deploy the bridge:

```sh
npm run deploy:worker
```

Build before using the plugin, because `.mcp.json` runs the compiled daemon:

```sh
npm run build
```

## Configuration

See `docs/configuration.md`.

The config file lives at `~/.config/voice-remote/config.json` and must be `0600`.

## Validated API Assumptions

- Claude Code plugins can bundle skills and `.mcp.json`; plugin skills are namespaced, so the start command is `/voice-command:start`.
- Claude Code MCP stdio servers are appropriate for the local daemon and require no inbound ports.
- ElevenLabs speech-to-text (`POST /v1/speech-to-text`) and text-to-speech (`POST /v1/text-to-speech/{voiceId}`) run server-side in the daemon, so the API key stays local.
- The browser captures audio with `MediaRecorder` and plays replies from `blob:` URLs — no third-party SDK, so the page CSP is `'self'`-only.
- Cloudflare Durable Objects support hibernation-friendly WebSockets with `ctx.acceptWebSocket`.
