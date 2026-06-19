import { DurableObject } from "cloudflare:workers";
import {
  parseBridgeBrowserSessionPath,
  parseBridgeWebSocketPath,
  readBridgeAuthQuery
} from "../../src/shared/bridge-contract";
import type { BridgeClientRole, BridgeEnvelope } from "../../src/shared/protocol";

export interface Env {
  VOICE_SESSIONS: DurableObjectNamespace<VoiceSessionDurableObject>;
  // Static-asset handler for the built Vite SPA (../web/dist). Serves the hashed
  // /assets/* files and the build manifest; the Worker owns /s/<id> and /ws/<id>.
  ASSETS: Fetcher;
}

type SocketAttachment = {
  role: BridgeClientRole;
};

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
    const { role } = readBridgeAuthQuery(url.searchParams);

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
    // caller knows the session secret. The secret is the whole capability; the session
    // lives until the daemon terminates it (no wall-clock expiry).

    // A session has exactly one daemon. If a previous daemon socket is still attached
    // (a zombie from a killed/moved pane, or a reconnect that raced the old close),
    // evict it now so the freshly-connecting daemon is authoritative and the browser's
    // presence lamp can never reflect a dead daemon. Browsers are not unique (phone +
    // desktop tab may both watch), so only the daemon role is deduplicated.
    if (role === "daemon") this.evictRole("daemon");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ role } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);

    this.broadcastPresence();

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

    // The daemon ends the session on shutdown so a leaked URL can't reconnect to a
    // daemon-less session. Only the daemon may terminate; never relayed to browsers.
    if (attachment.role === "daemon" && envelope.channel === "control" && envelope.event.type === "terminate") {
      await this.expireSession();
      return;
    }

    if (attachment.role === "daemon" && envelope.channel === "browser") {
      this.broadcastTo("browser", envelope);
      return;
    }

    if (attachment.role === "browser" && envelope.channel === "daemon") {
      this.broadcastTo("daemon", envelope);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  private async expireSession(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(1008, "session ended");
    }
    await this.ctx.storage.deleteAll();
  }

  // Close every currently-attached socket of a role (used to evict a stale daemon
  // when a new one connects). 1012 ("service restart") is non-terminal, so a still-
  // live peer would simply reconnect; a zombie is just dropped.
  private evictRole(role: BridgeClientRole): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      if (attachment?.role !== role) continue;
      try {
        socket.close(1012, "replaced by a newer connection");
      } catch {
        // already closing; ignore
      }
    }
  }

  private liveRoles(exclude?: WebSocket): { daemon: boolean; browser: boolean } {
    let daemon = false;
    let browser = false;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      if (attachment?.role === "daemon") daemon = true;
      else if (attachment?.role === "browser") browser = true;
    }
    return { daemon, browser };
  }

  private broadcastTo(role: BridgeClientRole, envelope: BridgeEnvelope): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      if (attachment?.role === role) {
        try {
          socket.send(JSON.stringify(envelope));
        } catch {
          // socket is closing; ignore
        }
      }
    }
  }

  // Presence is a separate signal from the daemon's rich session_status so it
  // never overwrites the daemon's runtime state or memory in the browser.
  private broadcastPresence(exclude?: WebSocket): void {
    const { daemon, browser } = this.liveRoles(exclude);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      if (attachment?.role !== "browser") continue;
      try {
        socket.send(
          JSON.stringify({
            channel: "browser",
            event: { type: "bridge_presence", daemonConnected: daemon, browserConnected: browser }
          } satisfies BridgeEnvelope)
        );
      } catch {
        // socket is closing; ignore
      }
    }
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
        // from 'self' (no inline styles), so style-src 'self' passes.
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "media-src 'self' blob:",
        "base-uri 'none'",
        "frame-ancestors 'none'"
      ].join("; ")
    }
  });
}
