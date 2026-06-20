import { DurableObject } from "cloudflare:workers";
import {
  parseBridgeBrowserSessionPath,
  parseBridgeWebSocketPath,
  readBridgeAuthQuery
} from "../../src/shared/bridge-contract";
import type { BridgeEnvelope, RosterThread, ThreadId, ThreadInfo } from "../../src/shared/protocol";
import {
  buildRoster,
  EMPTY_SESSION_GRACE_MS,
  ROSTER_KEY_PREFIX,
  rosterKey,
  type StoredThread,
  storedFromInfo
} from "./registry";

export interface Env {
  VOICE_SESSIONS: DurableObjectNamespace<VoiceSessionDurableObject>;
  // Static-asset handler for the built Vite SPA (../web/dist). Serves the hashed
  // /assets/* files and the build manifest; the Worker owns /s/<id> and /ws/<id>.
  ASSETS: Fetcher;
  // Cloudflare native Rate Limiting binding (wrangler.toml [[ratelimits]]). Caps WS-connect
  // attempts per client IP — abuse/DoS insurance, NOT the capability gate (a wrong secret
  // already lands on a different, empty DO). Best-effort / per-edge / eventually-consistent.
  WS_CONNECT: RateLimit;
}

// Minimal shape of the rate-limit binding (workers-types may not ship it yet). `limit({ key })`
// returns `{ success }`: false once the per-key budget for the configured window is exhausted.
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Daemon sockets carry their threadId (the routing key); browser sockets carry only the role.
// A daemon attachment is dedup'd by threadId; a browser is not (phone + desktop may both watch).
type SocketAttachment = { role: "daemon"; threadId: ThreadId } | { role: "browser" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("voice-control bridge", { status: 200 });
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    const browserSecret = parseBridgeBrowserSessionPath(url.pathname);
    if (request.method === "GET" && browserSecret) {
      return renderSessionPage(env);
    }

    const webSocketSecret = parseBridgeWebSocketPath(url.pathname);
    if (request.method === "GET" && webSocketSecret) {
      // Rate-limit WS-connect attempts per client IP BEFORE spinning up a DO, so spraying
      // /ws/<random> can't burn DO instantiations / requests. Best-effort abuse-bounding only
      // (the secret hash is the real gate); we never rely on it for correctness.
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.WS_CONNECT.limit({ key: ip });
      if (!success) return new Response("Too Many Requests", { status: 429 });

      // Route by the secret's hash, never the raw secret: the Durable Object name is a
      // non-secret, one-way derivative, so reaching a session's DO already proves knowledge
      // of its secret (sha256 is preimage-resistant). That routing IS the capability gate —
      // a guessed path lands on a different, empty DO, never the victim's session.
      const id = env.VOICE_SESSIONS.idFromName(await sha256(webSocketSecret));
      return env.VOICE_SESSIONS.get(id).fetch(request);
    }

    // Everything else (the hashed /assets/* bundle + build manifest) is a static
    // asset of the built SPA. run_worker_first=true routes all requests here first.
    return env.ASSETS.fetch(request);
  }
};

export class VoiceSessionDurableObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { role, threadId: daemonThreadId } = readBridgeAuthQuery(url.searchParams);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    // Browsers must connect from the bridge's own origin; the daemon (Node `ws`) sends
    // no Origin header. WebSockets bypass CORS, so this is the only thing stopping a
    // malicious page from opening the socket if the session URL ever leaks.
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) {
      return new Response("Forbidden origin", { status: 403 });
    }

    if (!role) {
      return new Response("Invalid role", { status: 400 });
    }

    // No token/credential check here: this DO is only reachable via /ws/<secret> routed
    // through idFromName(sha256(secret)), so arriving at this object already proves the
    // caller knows the session secret. The secret is the whole capability.

    const threadId = role === "daemon" ? daemonThreadId : undefined;
    if (role === "daemon" && !threadId) {
      return new Response("Missing threadId", { status: 400 });
    }

    // Per-thread dedup (replaces the old single-daemon evictRole): a reconnecting pane (or a
    // zombie from a moved/re-quit pane) shares its threadId, so evict ONLY that thread's stale
    // socket — sibling threads are untouched. "Newer connection wins," scoped to one thread.
    if (role === "daemon" && threadId) this.evictThread(threadId);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: SocketAttachment = role === "daemon" && threadId ? { role, threadId } : { role: "browser" };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);

    // A daemon connecting (re)claims the session: cancel any pending revoke-on-exit alarm.
    if (role === "daemon") await this.ctx.storage.deleteAlarm();

    if (role === "browser") {
      // A fresh phone needs the full roster to render/grade every thread (reuse #10 per-thread),
      // even threads whose daemon is currently offline (their stored lastSeenAt drives grading).
      await this.sendRoster(server);
    }

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    const envelope = safeJson<BridgeEnvelope>(message);
    if (!envelope) return;

    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (!attachment) return;

    // ---- daemon → DO / browser --------------------------------------------------------
    if (attachment.role === "daemon") {
      // The daemon ends its thread on shutdown so a leaked URL can't reconnect to a dead
      // session. Removing the last thread expires the whole session (deleteAll); otherwise it
      // just drops that thread from the roster.
      if (envelope.channel === "control" && envelope.event.type === "terminate") {
        await this.removeThread(attachment.threadId, ws);
        return;
      }
      // Register/refresh this thread's label + state in the roster, then broadcast the delta.
      if (envelope.channel === "registry" && envelope.event.type === "thread_register") {
        await this.upsertThread(attachment.threadId, envelope.event.info);
        return;
      }
      // Content (transcript/reply/tts/history/status/error) → all browsers, re-tagged with the
      // daemon's own threadId from its attachment (the DO trusts the attachment, not the wire).
      if (envelope.channel === "browser") {
        this.broadcastToBrowsers({ ...envelope, threadId: attachment.threadId });
      }
      return;
    }

    // ---- browser → ONE thread's daemon ------------------------------------------------
    if (attachment.role === "browser" && envelope.channel === "daemon") {
      const target = this.daemonSocket(envelope.threadId);
      if (target) {
        send(target, envelope);
      } else {
        // Never silently reroute to another thread: tell the phone the addressed thread is gone.
        send(ws, {
          channel: "browser",
          threadId: envelope.threadId,
          event: { type: "error", message: "That thread is offline." }
        });
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  // A daemon socket dropping marks its thread offline (stamp lastSeenAt, broadcast thread_left)
  // and, if it was the last thread, arms the revoke-on-exit grace alarm. A browser leaving is
  // irrelevant to session liveness, so it's a no-op here.
  private async onSocketGone(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (attachment?.role !== "daemon") return;

    const lastSeenAt = Date.now();
    const stored = await this.getThread(attachment.threadId);
    if (stored) await this.putThread(attachment.threadId, { ...stored, lastSeenAt });
    this.broadcastToBrowsers({
      channel: "roster",
      event: { type: "thread_left", threadId: attachment.threadId, lastSeenAt }
    });

    // If no daemon socket remains, start the revoke-on-exit grace timer. A reconnecting daemon
    // cancels it (deleteAlarm in fetch); if none does, alarm() expires the session.
    if (!this.hasAnyDaemon(ws)) await this.ctx.storage.setAlarm(Date.now() + EMPTY_SESSION_GRACE_MS);
  }

  // Revoke-on-exit: fires EMPTY_SESSION_GRACE_MS after the roster went empty. Only expire if it
  // is STILL empty (a daemon may have reconnected and cancelled — belt-and-braces re-check), so
  // a flapping daemon never loses a live session.
  async alarm(): Promise<void> {
    if (this.hasAnyDaemon()) return;
    await this.expireSession();
  }

  // ---- roster mutation -------------------------------------------------------

  // Register or refresh a thread, then broadcast a `thread_joined` upsert (the browser keys the
  // roster by threadId and replaces, so one event covers both first-seen and label/state
  // refresh). Reconnecting / refreshing a known thread clears its lastSeenAt — it's live again.
  private async upsertThread(threadId: ThreadId, info: ThreadInfo): Promise<void> {
    const stored = storedFromInfo(info);
    await this.putThread(threadId, stored);
    const thread: RosterThread = { threadId, ...stored, connected: true };
    this.broadcastToBrowsers({ channel: "roster", event: { type: "thread_joined", thread } });
  }

  // Remove a thread from the roster on a clean terminate (the daemon shutting down). Dropping
  // the LAST thread expires the whole session immediately (the user ran /stop in the only pane);
  // a non-last terminate just drops that thread. `terminatingSocket` is the daemon socket that
  // sent terminate — it is still listed by getWebSockets() here, so exclude it from the
  // "any daemon left?" check (and evictThread closes it regardless).
  private async removeThread(threadId: ThreadId, terminatingSocket: WebSocket): Promise<void> {
    await this.ctx.storage.delete(rosterKey(threadId));
    this.evictThread(threadId);
    this.broadcastToBrowsers({
      channel: "roster",
      event: { type: "thread_left", threadId, lastSeenAt: Date.now() }
    });
    if (!this.hasAnyDaemon(terminatingSocket)) await this.expireSession();
  }

  // ---- presence / routing helpers --------------------------------------------

  // The live daemon socket for `threadId`, if one is attached right now.
  private daemonSocket(threadId: ThreadId): WebSocket | undefined {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      if (attachment?.role === "daemon" && attachment.threadId === threadId) return socket;
    }
    return undefined;
  }

  // Close any attached daemon socket for `threadId` (1012 = non-terminal, so a still-live peer
  // would just reconnect; a zombie is simply dropped). Used by per-thread dedup + removeThread.
  private evictThread(threadId: ThreadId): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      if (attachment?.role !== "daemon" || attachment.threadId !== threadId) continue;
      try {
        socket.close(1012, "replaced by a newer connection");
      } catch {
        // already closing; ignore
      }
    }
  }

  // True if any daemon socket is still attached (optionally excluding one that is closing — its
  // close handler runs while it is still listed by getWebSockets()).
  private hasAnyDaemon(exclude?: WebSocket): boolean {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      if (attachment?.role === "daemon") return true;
    }
    return false;
  }

  // Send the full roster to one browser: every stored thread, with `connected` computed live
  // from the attached daemon sockets and its stored `lastSeenAt` for #10 offline grading.
  private async sendRoster(target: WebSocket): Promise<void> {
    const stored = await this.ctx.storage.list<StoredThread>({ prefix: ROSTER_KEY_PREFIX });
    const threads = buildRoster(stored, (threadId) => this.daemonSocket(threadId) !== undefined);
    send(target, { channel: "roster", event: { type: "thread_roster", threads } });
  }

  private getThread(threadId: ThreadId): Promise<StoredThread | undefined> {
    return this.ctx.storage.get<StoredThread>(rosterKey(threadId));
  }

  private putThread(threadId: ThreadId, thread: StoredThread): Promise<void> {
    return this.ctx.storage.put(rosterKey(threadId), thread);
  }

  private broadcastToBrowsers(envelope: BridgeEnvelope): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      if (attachment?.role === "browser") send(socket, envelope);
    }
  }

  // Tear the whole session down: close every socket (1008 terminal — the daemon treats it as
  // "do not reconnect") and wipe storage so a leaked URL reaching a revoked session sees nothing.
  private async expireSession(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(1008, "session ended");
    }
    await this.ctx.storage.deleteAll();
  }
}

function send(socket: WebSocket, envelope: BridgeEnvelope): void {
  try {
    socket.send(JSON.stringify(envelope));
  } catch {
    // socket is closing; ignore
  }
}

function safeJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The built SPA's entry files (resolved once per isolate from the Vite manifest).
type SpaAssets = { script: string; styles: string[] };
let spaAssetsCache: Promise<SpaAssets> | undefined;

type ViteManifestChunk = { file: string; isEntry?: boolean; css?: string[] };

// Read the Vite build manifest (../web/dist/.vite/manifest.json) through the ASSETS
// binding to map the SPA entry to its hashed JS + CSS. Memoized per isolate — the
// asset bundle is immutable for a given deploy.
function loadSpaAssets(env: Env): Promise<SpaAssets> {
  if (!spaAssetsCache) {
    spaAssetsCache = (async () => {
      const res = await env.ASSETS.fetch(new Request("https://assets.local/.vite/manifest.json"));
      if (!res.ok) throw new Error(`manifest unavailable (${res.status})`);
      const manifest = (await res.json()) as Record<string, ViteManifestChunk>;
      const entry = Object.values(manifest).find((chunk) => chunk.isEntry) ?? manifest["src/main.tsx"];
      if (!entry) throw new Error("no entry chunk in manifest");
      return {
        script: `/${entry.file}`,
        styles: (entry.css ?? []).map((href) => `/${href}`)
      };
    })().catch((err) => {
      spaAssetsCache = undefined; // allow a retry on the next request
      throw err;
    });
  }
  return spaAssetsCache;
}

// The phone shell is a built static SPA served from this origin; the single capability
// secret lives in the URL path (/s/<secret>) and the client reads it from there. Nothing
// is injected server-side, so reaching a valid /s/<secret> route is enough to serve the
// shell — the WS handshake (idFromName(sha256(secret))) is where the secret is enforced.
async function renderSessionPage(env: Env): Promise<Response> {
  let assets: SpaAssets;
  try {
    assets = await loadSpaAssets(env);
  } catch {
    return new Response("Application bundle unavailable", { status: 503 });
  }

  const styleLinks = assets.styles.map((href) => `  <link rel="stylesheet" href="${href}" />`).join("\n");

  // Minimal shell: the Worker owns this HTML + the CSP, but the SPA is a built
  // static bundle served from 'self'. The client reads the single capability secret
  // straight from the URL path (/s/<secret>) — nothing is injected here.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="referrer" content="no-referrer" />
  <meta name="theme-color" content="#faf6f1" />
  <title>voice-control</title>
${styleLinks}
</head>
<body>
  <div id="app"></div>
  <script type="module" src="${assets.script}"></script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html;charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": [
        // The phone SPA is a built static bundle served from this same origin.
        // Mic capture is MediaRecorder, the only network target is the same-origin
        // bridge WebSocket (covered by connect-src 'self'), and TTS replies play
        // from in-memory blob: URLs. The Tailwind stylesheet is an external file
        // from 'self' (no inline styles), so style-src 'self' passes. `data:` is in
        // media-src for the silent-WAV that unlocks iOS autoplay on first tap.
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "media-src 'self' blob: data:",
        "base-uri 'none'",
        "frame-ancestors 'none'"
      ].join("; ")
    }
  });
}
