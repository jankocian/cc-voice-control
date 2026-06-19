import { DurableObject } from "cloudflare:workers";
import {
  parseBridgeBrowserSessionPath,
  parseBridgeWebSocketPath,
  readBridgeAuthQuery
} from "../../src/shared/bridge-contract";
import type { BridgeClientRole, BridgeEnvelope } from "../../src/shared/protocol";
import { renderBrowserClientModuleScript } from "./browser-client";

export interface Env {
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

    this.broadcastPresence();

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
  <meta name="theme-color" content="#0a0a0b" />
  <title>voice-command</title>
  <style nonce="${nonce}">
    /*
     * Clean, minimal, monochrome. One hairline border token (--border) is used
     * for every surface, divider and control so the whole UI shares the same edge.
     */
    :root {
      color-scheme: dark;
      --bg: #0a0a0b;
      --panel: #141416;
      --panel-2: #1c1c1f;
      --border: #26262a;
      --text: #ededed;
      --text-2: #9a9aa2;
      --text-3: #66666e;
      --green: #3fb950;
      --blue: #4493f8;
      --violet: #a371f7;
      --red: #e5484d;
      --radius: 10px;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif;
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }

    body {
      margin: 0;
      min-height: 100dvh;
      color: var(--text);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    ::selection { background: rgba(255, 255, 255, .16); }

    main {
      width: min(100%, 440px);
      min-height: 100dvh;
      margin: 0 auto;
      padding:
        max(22px, env(safe-area-inset-top))
        max(18px, env(safe-area-inset-right))
        max(22px, env(safe-area-inset-bottom))
        max(18px, env(safe-area-inset-left));
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    /* Header */
    .app-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 2px 2px 6px;
    }

    .app-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -.01em; }

    .session-id {
      font-size: 12px;
      color: var(--text-3);
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 55%;
      text-align: right;
    }

    /* Shared surface — every panel uses the same hairline border */
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }

    /* Status — the primary feedback surface: a solid color fill per state */
    .status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 16px;
      position: relative;
      overflow: hidden;
      transition: background .35s ease, border-color .35s ease;
    }

    .status[data-state="ready"] { background: color-mix(in srgb, var(--green) 14%, var(--panel)); border-color: color-mix(in srgb, var(--green) 42%, var(--border)); }
    .status[data-state="recording"] { background: color-mix(in srgb, var(--red) 17%, var(--panel)); border-color: color-mix(in srgb, var(--red) 48%, var(--border)); }
    .status[data-state="sending"] { background: color-mix(in srgb, var(--blue) 15%, var(--panel)); border-color: color-mix(in srgb, var(--blue) 42%, var(--border)); }
    .status[data-state="working"] { background: color-mix(in srgb, var(--blue) 17%, var(--panel)); border-color: color-mix(in srgb, var(--blue) 48%, var(--border)); }
    .status[data-state="speaking"] { background: color-mix(in srgb, var(--violet) 17%, var(--panel)); border-color: color-mix(in srgb, var(--violet) 48%, var(--border)); }

    /* Subtle sweep while Claude is working */
    .status[data-state="working"]::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      background: linear-gradient(100deg, transparent 28%, color-mix(in srgb, var(--blue) 26%, transparent) 50%, transparent 72%);
      transform: translateX(-100%);
      animation: status-sweep 1.8s ease-in-out infinite;
    }

    @keyframes status-sweep { 0% { transform: translateX(-100%); } 65%, 100% { transform: translateX(100%); } }

    .status-main { display: flex; align-items: center; gap: 11px; min-width: 0; position: relative; z-index: 1; }

    .lamp {
      --c: var(--text-3);
      width: 8px; height: 8px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: var(--c);
    }

    .lamp.connected { --c: var(--green); }
    .lamp.working { --c: var(--blue); }
    .lamp.speaking { --c: var(--violet); }
    .lamp.recording { --c: var(--red); animation: dot-pulse 1.3s ease-in-out infinite; }

    @keyframes dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }

    .status-text { min-width: 0; }
    .status-text strong { display: block; font-size: 14px; font-weight: 560; letter-spacing: -.005em; line-height: 1.3; }
    .status-text span {
      display: block;
      margin-top: 1px;
      font-size: 12.5px;
      color: var(--text-3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status-meta { display: flex; flex-direction: column; align-items: flex-end; flex: 0 0 auto; }
    .meta-label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); }
    .elapsed { font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--text-2); margin-top: 2px; }

    /* Controls */
    .controls { display: flex; flex-direction: column; gap: 10px; }
    .controls-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }

    .btn {
      -webkit-appearance: none;
      appearance: none;
      cursor: pointer;
      font: inherit;
      color: var(--text);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 52px;
      padding: 0 16px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--panel);
      font-size: 14px;
      font-weight: 540;
      letter-spacing: -.005em;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      transition: background .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease, transform .1s ease;
    }

    .btn svg { width: 18px; height: 18px; flex: 0 0 auto; }
    .btn:active { transform: scale(.99); }
    .btn:disabled { opacity: .4; pointer-events: none; }
    .btn:focus-visible { outline: 2px solid var(--text-2); outline-offset: 2px; }

    @media (hover: hover) {
      .btn:hover { background: var(--panel-2); border-color: #34343a; }
    }

    /* Primary — the one deliberate emphasis: a solid, inverted fill */
    .btn.primary {
      min-height: 56px;
      background: var(--text);
      border-color: var(--text);
      color: #0a0a0b;
      font-weight: 580;
    }

    .btn.primary.recording { background: var(--red); border-color: var(--red); color: #fff; }

    @media (hover: hover) {
      .btn.primary:hover { background: #fff; border-color: #fff; }
      .btn.primary.recording:hover { background: #ef5e62; border-color: #ef5e62; }
    }

    /* Secondary — quiet ghost buttons, same hairline border */
    .btn.ghost { background: transparent; color: var(--text-2); font-size: 13px; min-height: 46px; }
    .btn.ghost.danger { color: var(--red); }

    @media (hover: hover) {
      .btn.ghost:hover { background: var(--panel); color: var(--text); border-color: #34343a; }
      .btn.ghost.danger:hover { color: #ef5e62; }
    }

    /* Activity */
    .log-panel { flex: 1; min-height: 180px; display: flex; flex-direction: column; overflow: hidden; }

    .panel-head {
      padding: 12px 16px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .07em;
      text-transform: uppercase;
      color: var(--text-3);
      border-bottom: 1px solid var(--border);
    }

    .log { flex: 1; min-height: 120px; overflow-y: auto; }
    .log:empty::after { content: "No activity yet"; display: block; padding: 18px 16px; color: var(--text-3); font-size: 13px; }
    .log::-webkit-scrollbar { width: 8px; }
    .log::-webkit-scrollbar-thumb { background: var(--border); border-radius: 99px; }

    .entry { padding: 11px 16px; border-top: 1px solid var(--border); }
    .entry:first-child { border-top: 0; }
    .entry time { display: block; font-size: 11px; color: var(--text-3); letter-spacing: .01em; font-variant-numeric: tabular-nums; margin-bottom: 3px; }
    .entry p { margin: 0; font-size: 13.5px; line-height: 1.45; color: var(--text-2); overflow-wrap: anywhere; }
    .entry[data-kind="you"] p { color: var(--text); }
    .entry[data-kind="claude"] p { color: var(--text); }
    .entry[data-kind="error"] p { color: var(--red); }
    .entry[data-kind="error"] time { color: var(--red); opacity: .75; }
    .entry[data-kind="you"] time::after { content: " · ✓ sent"; color: var(--green); font-weight: 600; }

    /* Listening visualizer — audio-reactive bars driven by the mic AnalyserNode */
    .visualizer { display: none; align-items: center; justify-content: center; height: 78px; padding: 8px 16px; }
    .visualizer.active { display: flex; }
    #waveform { width: 100%; height: 100%; display: block; }

    /* Header playback-speed pill (top-right) */
    .speed-pill {
      -webkit-appearance: none; appearance: none; cursor: pointer; flex: 0 0 auto;
      height: 30px; padding: 0 12px; border-radius: 99px;
      border: 1px solid var(--border); background: var(--panel); color: var(--text-2);
      font: inherit; font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums;
      -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: color .15s ease, border-color .15s ease, background .15s ease;
    }
    @media (hover: hover) { .speed-pill:hover { color: var(--text); border-color: #34343a; } }

    /* Tappable message playback — tap a reply to play/pause, or use the replay button */
    .entry.playable { cursor: pointer; transition: background .15s ease; }
    @media (hover: hover) { .entry.playable:hover { background: var(--panel-2); } }
    .entry .entry-controls { float: right; display: inline-flex; align-items: center; gap: 4px; margin: -1px 0 6px 12px; }
    .entry .ec-btn {
      -webkit-appearance: none; appearance: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; border-radius: 50%; border: 0; background: transparent;
      color: var(--text-3); -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      transition: color .15s ease, background .15s ease;
    }
    .entry .ec-btn svg { width: 15px; height: 15px; display: block; }
    @media (hover: hover) { .entry .ec-btn:hover { color: var(--text); background: var(--panel); } }
    .entry .entry-icon { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; color: var(--text-3); }
    .entry .entry-icon svg { width: 16px; height: 16px; display: block; }
    .entry .entry-icon .ic-pause { display: none; }
    .entry.playing { background: var(--panel-2); box-shadow: inset 2px 0 0 var(--violet); }
    .entry.playing p { color: var(--text); }
    .entry.playing .entry-icon { color: var(--violet); }
    .entry.playing .ec-btn { color: var(--text-2); }
    .entry.playing .entry-icon .ic-play { display: none; }
    .entry.playing .entry-icon .ic-pause { display: block; }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
    }
  </style>
</head>
<body>
  <main>
    <header class="app-header">
      <h1 class="app-title">voice command</h1>
      <button id="speedButton" class="speed-pill" type="button" aria-label="Playback speed">1×</button>
    </header>

    <section id="statusPanel" class="panel status" data-state="offline" aria-live="polite">
      <div class="status-main">
        <span id="lamp" class="lamp" aria-hidden="true"></span>
        <div class="status-text">
          <strong id="stateLabel">Connecting</strong>
          <span id="detailLabel">Reaching the bridge</span>
        </div>
      </div>
    </section>

    <section class="controls">
      <button id="voiceButton" class="btn primary" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <line x1="12" y1="18" x2="12" y2="21.5" />
        </svg>
        <span id="voiceLabel">Tap to Speak</span>
      </button>
      <div id="visualizer" class="visualizer panel" aria-hidden="true"><canvas id="waveform"></canvas></div>
      <div class="controls-row">
        <button id="summaryButton" class="btn ghost" type="button">Get summary</button>
        <button id="statusButton" class="btn ghost" type="button">Get status</button>
        <button id="stopButton" class="btn ghost danger" type="button">Stop Claude</button>
      </div>
    </section>

    <section class="panel log-panel">
      <div class="panel-head">Activity</div>
      <div id="log" class="log" aria-label="Session events"></div>
    </section>
  </main>

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
        // Push-to-talk runs no third-party SDK in the browser: mic capture is
        // MediaRecorder, the only network target is the same-origin bridge socket,
        // and TTS replies are played from in-memory blob: URLs.
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "media-src 'self' blob:",
        "base-uri 'none'",
        "frame-ancestors 'none'"
      ].join("; ")
    }
  });
}
