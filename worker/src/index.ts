import { DurableObject } from "cloudflare:workers";
import {
  parseBridgeBrowserSessionPath,
  parseBridgeWebSocketPath,
  readBridgeAuthQuery
} from "../../src/shared/bridge-contract";
import type { BridgeClientRole, BridgeEnvelope, SessionState } from "../../src/shared/protocol";
import { renderBrowserClientModuleScript } from "./browser-client";

export interface Env {
  ASSETS: Fetcher;
  VOICE_SESSIONS: DurableObjectNamespace<VoiceSessionDurableObject>;
}

type SocketAttachment = {
  role: BridgeClientRole;
};

type StoredAuth = {
  tokenHash: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
};

const FALLBACK_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("voice-command bridge", { status: 200 });
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    if (url.pathname.startsWith("/assets/")) {
      return env.ASSETS.fetch(request);
    }

    const browserSessionId = parseBridgeBrowserSessionPath(url.pathname);
    if (request.method === "GET" && browserSessionId) {
      return renderSessionPage(browserSessionId, readBridgeAuthQuery(url.searchParams).token);
    }

    const webSocketSessionId = parseBridgeWebSocketPath(url.pathname);
    if (request.method === "GET" && webSocketSessionId) {
      const id = env.VOICE_SESSIONS.idFromName(webSocketSessionId);
      return env.VOICE_SESSIONS.get(id).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};

export class VoiceSessionDurableObject extends DurableObject<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env
  ) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = parseBridgeWebSocketPath(url.pathname) ?? "";
    const authQuery = readBridgeAuthQuery(url.searchParams);
    const role = authQuery.role;
    const token = authQuery.token;
    const requestedExpiresAt = authQuery.expiresAt;

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    if (!role) {
      return new Response("Invalid role", { status: 400 });
    }

    if (!token || !(await this.authorize(sessionId, token, requestedExpiresAt))) {
      return new Response("Unauthorized", { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ role } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);

    await this.updatePresence();
    this.broadcastStatus();

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    if (!(await this.isSessionActive())) {
      await this.expireSession();
      return;
    }

    const envelope = safeJson<BridgeEnvelope>(message);
    if (!envelope) return;

    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (!attachment) return;

    if (attachment.role === "daemon" && envelope.channel === "browser") {
      this.broadcastTo("browser", envelope);
      await this.updatePresence();
      return;
    }

    if (attachment.role === "browser" && envelope.channel === "daemon") {
      this.broadcastTo("daemon", envelope);
      await this.updatePresence();
    }
  }

  async webSocketClose(): Promise<void> {
    await this.updatePresence();
    this.broadcastStatus();
  }

  async webSocketError(): Promise<void> {
    await this.updatePresence();
    this.broadcastStatus();
  }

  private async authorize(sessionId: string, token: string, requestedExpiresAt?: number): Promise<boolean> {
    const tokenHash = await sha256(token);
    const stored = await this.ctx.storage.get<StoredAuth>("auth");
    const now = Date.now();

    if (!stored) {
      if (requestedExpiresAt !== undefined && requestedExpiresAt <= now) {
        return false;
      }
      await this.ctx.storage.put("auth", {
        tokenHash,
        sessionId,
        createdAt: now,
        expiresAt: requestedExpiresAt ?? now + FALLBACK_SESSION_TTL_MS
      } satisfies StoredAuth);
      return true;
    }

    if (stored.expiresAt <= now) {
      await this.ctx.storage.deleteAll();
      return false;
    }

    return stored.sessionId === sessionId && stored.tokenHash === tokenHash;
  }

  private async isSessionActive(): Promise<boolean> {
    const stored = await this.ctx.storage.get<StoredAuth>("auth");
    return Boolean(stored && stored.expiresAt > Date.now());
  }

  private async expireSession(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(1008, "session expired");
    }
    await this.ctx.storage.deleteAll();
  }

  private async updatePresence(): Promise<void> {
    const stored = await this.ctx.storage.get<StoredAuth>("auth");
    if (!stored) return;

    const daemonConnected = this.hasRole("daemon");
    const browserConnected = this.hasRole("browser");
    const state: SessionState = {
      sessionId: stored.sessionId,
      daemonConnected,
      browserConnected,
      state: daemonConnected && browserConnected ? "voice_connected" : "voice_suspended",
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt
    };
    await this.ctx.storage.put("state", state);
  }

  private async getState(): Promise<SessionState | undefined> {
    return this.ctx.storage.get<SessionState>("state");
  }

  private hasRole(role: BridgeClientRole): boolean {
    return this.ctx.getWebSockets().some((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      return attachment?.role === role;
    });
  }

  private broadcastTo(role: BridgeClientRole, envelope: BridgeEnvelope): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | undefined;
      if (attachment?.role === role) {
        socket.send(JSON.stringify(envelope));
      }
    }
  }

  private broadcastStatus(): void {
    this.getState()
      .then((state) => {
        if (!state) return;
        this.broadcastTo("browser", {
          channel: "browser",
          event: {
            type: "session_status",
            state,
            memory: {
              steeringNotes: []
            }
          }
        });
      })
      .catch(() => undefined);
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

function renderSessionPage(sessionId: string, token: string): Response {
  if (!token) {
    return new Response("Missing session token", { status: 401 });
  }

  const nonce = crypto.randomUUID();

  const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="referrer" content="no-referrer" />
  <title>voice-command</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light;
      --ink: #181611;
      --muted: #6b6254;
      --paper: #f4f0e8;
      --panel: #fffaf0;
      --line: #d9cfbd;
      --accent: #0f766e;
      --accent-ink: #ecfffb;
      --warn: #b42318;
      --blue: #1d4ed8;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100dvh;
      background:
        linear-gradient(90deg, rgba(24, 22, 17, 0.04) 1px, transparent 1px) 0 0 / 22px 22px,
        var(--paper);
      color: var(--ink);
    }

    main {
      width: min(100%, 760px);
      min-height: 100dvh;
      margin: 0 auto;
      padding: max(18px, env(safe-area-inset-top)) 16px max(18px, env(safe-area-inset-bottom));
      display: grid;
      grid-template-rows: auto auto auto minmax(180px, 1fr);
      gap: 16px;
    }

    header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 14px;
      padding-bottom: 12px;
      border-bottom: 2px solid var(--ink);
    }

    h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1;
      letter-spacing: 0;
    }

    .session {
      color: var(--muted);
      font-size: 12px;
      word-break: break-all;
      text-align: right;
    }

    .status-strip {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 12px;
      border: 1px solid var(--line);
      background: var(--panel);
      padding: 14px;
    }

    .state {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .lamp {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      background: var(--warn);
      flex: 0 0 auto;
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 16%, transparent);
    }

    .lamp.connected { background: var(--accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 16%, transparent); }
    .lamp.working { background: var(--blue); box-shadow: 0 0 0 4px color-mix(in srgb, var(--blue) 16%, transparent); }

    .state strong {
      display: block;
      font-size: 16px;
      line-height: 1.2;
    }

    .state span, .elapsed {
      color: var(--muted);
      font-size: 13px;
    }

    .controls {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    button {
      font: inherit;
      border-radius: 0;
    }

    button {
      min-height: 52px;
      border: 1px solid var(--ink);
      background: var(--panel);
      color: var(--ink);
      font-weight: 720;
      padding: 12px 10px;
      touch-action: manipulation;
    }

    button.primary {
      background: var(--accent);
      color: var(--accent-ink);
      border-color: var(--accent);
    }

    button.danger {
      color: var(--warn);
      border-color: var(--warn);
    }

    button:disabled {
      opacity: .55;
    }

    .log {
      min-height: 180px;
      overflow: auto;
      border: 1px solid var(--line);
      background: rgba(255, 250, 240, .72);
      padding: 4px 0;
    }

    .entry {
      display: grid;
      gap: 3px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }

    .entry:last-child { border-bottom: 0; }
    .entry time { color: var(--muted); font-size: 12px; }
    .entry p { margin: 0; line-height: 1.35; }

    @media (max-width: 430px) {
      main { padding-inline: 12px; }
      .controls { grid-template-columns: 1fr; }
      header { align-items: start; flex-direction: column; }
      .session { text-align: left; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>voice-command</h1>
      <div class="session">session ${escapeHtml(sessionId)}</div>
    </header>

    <section class="status-strip" aria-live="polite">
      <div class="state">
        <span id="lamp" class="lamp"></span>
        <div>
          <strong id="stateLabel">Connecting</strong>
          <span id="detailLabel">Waiting for Claude Code</span>
        </div>
      </div>
      <div id="elapsed" class="elapsed">0m 00s</div>
    </section>

    <section class="controls">
      <button id="voiceButton" class="primary">Reconnect Voice</button>
      <button id="summaryButton">Repeat Last Summary</button>
      <button id="statusButton">Request Status</button>
      <button id="stopButton" class="danger">Stop Task</button>
    </section>

    <section id="log" class="log" aria-label="Session events"></section>
  </main>

  <script src="/assets/elevenlabs-client.iife.js"></script>
  <script type="module" nonce="${nonce}">
${renderBrowserClientModuleScript({ sessionId, token })}
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html;charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' blob:`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io https://*.elevenlabs.io wss://*.elevenlabs.io https://*.livekit.cloud wss://*.livekit.cloud",
        "worker-src 'self' blob:",
        "media-src 'self' blob:",
        "base-uri 'none'",
        "frame-ancestors 'none'"
      ].join("; ")
    }
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char] ?? char;
  });
}
