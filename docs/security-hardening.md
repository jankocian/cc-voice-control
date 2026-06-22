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

The phone URL is `/s/<sessionId>#<secret>`. The 128-bit `secret` lives in `session.json` on the machine
and rides to the phone in the URL **fragment**, which browsers never send to a server — so the worker
never sees it. The worker routes by `sessionId = sha256(secret)` truncated to 8 base64url chars: a
short, non-secret, one-way derivative — it's the visible handle in the path, distinguishes one machine's
session from another's, and on its own leads nowhere (reaching the DO is gated; without the secret there
is no key and no cookie). 48 bits is ample against accidental collision (it only ever routes to a gated
DO, so it needs to be collision-resistant, not unguessable). The worker sees: session ids, channel,
threadId, message types, timestamps, sizes, online/offline — **never** prompts, replies, transcripts,
repo/branch/cwd labels, or audio.

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

- **The bridge decides when a window opens, not the daemon.** When a daemon connects, the DO checks
  whether any device is paired; if none, it opens a **pairing window** (`CLAIM_WINDOW_MS` = 90s)
  synchronously, right then — so an unpaired session (a first `/voice-control:start`) gets a window, but
  a session that already has a paired device opens **none** (a restart, an extra pane, or a morning
  reconnect just works). `/voice-control:pair` is the only daemon-initiated open: an explicit "add
  another device" even when one is paired. Because the window is set the instant the daemon connects —
  before the phone can claim — there's no race and no "expired" flicker. The DO tells the daemon whether
  a window is open (a `session`-channel signal) so `/start` and `/status` show the right message.
- `/voice-control:start` **always shows the link/QR**: it's how any device returns to the session. An
  already-paired device opens it and reconnects via its cookie; a new device pairs only while a window
  is open. The skill's wording adapts on the daemon's `pairing` flag.
- The phone `POST`s `/claim/<sessionId>` before connecting: within an open window it mints a random
  256-bit token, stores the token's **hash** (with a `createdAt`) in the DO, and sets
  `vrt_<sessionId>=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=3d` (`Secure` except on local
  http dev). Outside a window with no valid cookie → `403`; the phone shows "run /voice-control:pair". An
  already-paired device is re-allowed and **both** its cookie `Max-Age` and the server-side token
  `createdAt` are refreshed — a **rolling 3-day** expiry, so daily use never lapses but a device untouched
  for 3 days must re-pair (and a stale stolen cookie can't be used beyond that).
- **The link is single-use.** The first successful claim closes the window (the DO deletes the window
  key, atomically since it serializes requests), so a second device racing the same link — even within
  the 90s — gets `403`. The window still also expires on its own if never used. Pairing another device
  needs a fresh `/voice-control:pair`. (Trade-off: if a claim's `200` is lost in transit the window is
  spent, so that device must re-pair — rare and recoverable.)
- The browser WebSocket upgrade **requires** a valid device cookie (`401` otherwise). The phone retries a
  few times on an initial `403` to absorb the brief start-up race before the window is live.
- **The daemon role is authenticated separately**, by `daemonKey` — a second secret in `session.json`,
  never in any URL, sent as a connect header. The DO pins it on the first daemon connect
  (trust-on-first-use) and requires it thereafter. This is what stops a leaked-URL holder (who has
  `secret`/`sessionId` but not `daemonKey`) from connecting as a daemon to re-open the pairing window,
  terminate the session, or forge roster entries.
- `expireSession()` (revoke-on-exit, ~3 min after the last daemon leaves) wipes the roster and pairing
  window — but **keeps paired device tokens** (subject to their rolling 3-day TTL) **and the daemon-key
  pin**. So a phone reconnecting after an idle session (e.g. a morning refresh after the laptop slept)
  isn't forced to re-pair, while a leaked URL still can't join (no window, and the browser still needs a
  cookie it never had). Keeping the pin is essential: if it were dropped, an idled session would fall
  back to trust-on-first-use and a leaked-URL holder could become the daemon and re-open pairing. A
  genuine reset (deleting `session.json`) mints a new secret → a new `sessionId` → a different DO, so the
  stale pin never blocks it.

## How they compose

| Attacker has… | Result |
|---|---|
| The chat history (relayed messages) | No credential is in it (cookie is `HttpOnly`, never relayed) → safe |
| A screenshot of the URL/QR (incl. `#secret`), window closed or already used | `/claim` → 403; can't open a window (no `daemonKey`) → no cookie → locked out |
| The live URL while a window is open, racing the real device | single-use: whoever's first closes the window; the loser gets 403 |
| A compromised worker | Sees only ciphertext + routing metadata → can't read content |
| `sessionId` but not the cookie / `daemonKey` | Browser upgrade → 401; daemon upgrade → 401 |

## Known limitations

- **Daemon auth is trust-on-first-use**, but the pin now persists for the life of the `sessionId` (it
  survives revoke-on-exit), so TOFU is exposed only at the **very first** daemon connect for a session —
  which happens before the daemon has even generated the URL, so there's no practical window for a
  leaked-URL holder to squat it.
- **Not forward-secret / not replay-proof against a malicious relay** — out of scope (see threat model).
- **`/claim` proves only the (non-secret) `sessionId`, not the secret.** Someone who learns a `sessionId`
  (e.g. from a CDN access log) could, while a window is open, consume the single-use claim or mint a
  cookie — but with no secret they can't read content, and they can't *open* a window (that needs the
  daemonKey). At worst a transient pairing nuisance; not disclosure.
- **The daemon's `pairing` runtime flag can read stale-`true`** if a window is opened and then expires
  unused (nothing signals the close). Not user-visible today — `/status` uses a generic message and
  `/start` reads the flag fresh right after connecting — but worth knowing if another reader is added.
- **Audio is sealed as base64-in-JSON**, so a large TTS clip is base64-encoded twice and sealed on the
  main thread; correct but not optimal. A future improvement is binary WS frames for audio. The
  per-message seal/open are serialized per direction to preserve ordering.
