# Security model: device pairing + end-to-end encryption

This documents the two security properties the bridge provides and how they're implemented, so the
trust boundaries can be audited. Code: `src/shared/e2e.ts`, `worker/src/claim.ts`,
`worker/src/voice-session-do.ts`, `src/daemon/voice-daemon.ts`, `web/src/hooks/useBridge.ts`.

## Threat model

The phone ↔ Cloudflare Worker (relay + Durable Object) ↔ local daemon talk over WebSockets. The two
goals:

1. **A leaked session URL/QR must not grant standing access.** Screenshots, browser history, or a
   glance at the screen leak the URL; that must not let someone join the session later.
2. **The relay operator must not be able to read message content** — even if the worker is compromised.

Explicitly out of scope: forward secrecy, and defending against a *fully malicious relay* that actively
replays or reorders ciphertext (the worker is trusted for availability/routing, not for confidentiality).

## What the worker can and cannot see

The session secret (128-bit) lives in `session.json` on the machine and rides to the phone in the URL
**fragment** (`/s#<secret>`). Browsers never send the fragment to a server, so the worker never sees the
secret. The worker routes by `routingId = sha256(secret)` (hex), a one-way derivative that reveals
nothing about the secret. The worker sees: routing ids, channel, threadId, message types, timestamps,
sizes, online/offline — **never** prompts, replies, transcripts, repo/branch/cwd labels, or audio.

## (1) End-to-end encryption — `src/shared/e2e.ts`

- Both ends derive the same key with `HKDF-SHA256(secret)` → AES-256-GCM (WebCrypto, in Node and the
  browser; no dependency). The worker, lacking the secret, can't derive it.
- Conversational events (the `browser` and `daemon` channels) are sealed **whole** into an `enc` blob;
  the worker relays `{channel, threadId, enc}` and never sees the event. The thread **label**
  (repo/branch/cwd) is sealed too — the DO stores and re-broadcasts it as an opaque `EncBlob`. Routing
  metadata (channel, threadId, type, state, presence) stays plaintext so the worker can route.
- AES-GCM with a fresh random 96-bit IV per message (never reused under a key). AAD = `channel:threadId`
  binds a ciphertext to its routing context, so the relay can't move it to another thread/channel
  without the auth tag failing. Both ends build the AAD with the one shared `aad()` helper.

## (2) Device pairing — `worker/src/claim.ts`

The URL is a short-lived *pairing code*, not a standing credential; the standing browser credential is a
per-device `HttpOnly` cookie that lives nowhere in the URL, history, or transcript.

- The daemon opens a **pairing window** (`CLAIM_WINDOW_MS` = 90s) by a control message to its DO, on the
  first connect of a user-run `/voice-control:start` and on `/voice-control:pair`. **Not** on plain
  reconnects, and **not** for a spawned pane (it joins an already-paired session) — so routine
  multi-pane use never silently re-opens pairing.
- The phone `POST`s `/claim/<routingId>` before connecting: within an open window it mints a random
  256-bit token, stores the token's **hash** in the DO, and sets `vrt_<routingId[:16]>=<token>;
  HttpOnly; SameSite=Strict; Path=/; Max-Age=30d` (`Secure` except on local http dev). Outside a window
  with no valid cookie → `403`; the phone shows "run /voice-control:pair". An already-paired device is
  re-allowed and its cookie lifetime refreshed (rolling expiry).
- The browser WebSocket upgrade **requires** a valid device cookie (`401` otherwise). The phone retries a
  few times on an initial `403` to absorb the brief start-up race before the window is live.
- **The daemon role is authenticated separately**, by `daemonKey` — a second secret in `session.json`,
  never in any URL, sent as a connect header. The DO pins it on the first daemon connect
  (trust-on-first-use) and requires it thereafter. This is what stops a leaked-URL holder (who has
  `secret`/`routingId` but not `daemonKey`) from connecting as a daemon to re-open the pairing window,
  terminate the session, or forge roster entries.
- `expireSession()` (revoke-on-exit, ~3 min after the last daemon leaves) wipes device tokens, the
  pairing window, and the daemon-key pin along with the roster, so each fresh session re-pairs and
  re-pins from the same `session.json`.

## How they compose

| Attacker has… | Result |
|---|---|
| The chat history (relayed messages) | No credential is in it (cookie is `HttpOnly`, never relayed) → safe |
| A screenshot of the URL/QR (incl. `#secret`), window closed | `/claim` → 403; can't open a window (no `daemonKey`) → no cookie → locked out |
| A compromised worker | Sees only ciphertext + routing metadata → can't read content |
| `routingId` but not the cookie / `daemonKey` | Browser upgrade → 401; daemon upgrade → 401 |

## Known limitations

- **Daemon auth is trust-on-first-use.** If an attacker who already holds the URL connects as a daemon
  *before* the legitimate daemon's first connect, they pin their own `daemonKey` and lock the real
  daemon out (a visible, recoverable DoS — `/voice-control:start` plainly fails — not content
  disclosure). The realistic leak is of a *live* session's URL, by which point the real daemon has
  already pinned, so this window is narrow.
- **Not forward-secret / not replay-proof against a malicious relay** — out of scope (see threat model).
- **Audio is sealed as base64-in-JSON**, so a large TTS clip is base64-encoded twice and sealed on the
  main thread; correct but not optimal. A future improvement is binary WS frames for audio. The
  per-message seal/open are serialized per direction to preserve ordering.
