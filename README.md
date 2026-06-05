# Voice Remote for Claude Code

V1 implementation scaffold for a Claude Code plugin, local MCP daemon, Cloudflare Durable Object bridge, and ElevenLabs Agents browser voice layer.

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
- ElevenLabs agent setup notes in `docs/elevenlabs-agent.md`

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
- ElevenLabs signed URLs are generated server-side and expire after 15 minutes; the browser uses the signed URL directly.
- ElevenLabs browser SDK supports `clientTools` in `Conversation.startSession`.
- Cloudflare Durable Objects support hibernation-friendly WebSockets with `ctx.acceptWebSocket`.
