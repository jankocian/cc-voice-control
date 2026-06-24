import { DurableObject } from "cloudflare:workers";
import {
  BRIDGE_DAEMON_KEY_HEADER,
  parseBridgeClaimPath,
  parseBridgeWebSocketPath,
  readBridgeAuthQuery
} from "../../src/shared/bridge-contract";
import type { BridgeEnvelope, ThreadId, WireRosterThread, WireThreadInfo } from "../../src/shared/protocol";
import {
  buildSetCookie,
  CLAIM_WINDOW_KEY,
  CLAIM_WINDOW_MS,
  claimDecision,
  DAEMON_AUTH_KEY,
  DEVICE_STORAGE_PREFIX,
  deviceCookieName,
  deviceFresh,
  deviceStorageKey,
  hashToken,
  mintDeviceToken,
  readCookie,
  windowOpen
} from "./claim";
import {
  buildRoster,
  EMPTY_SESSION_GRACE_MS,
  isGhostThread,
  isLastDaemon,
  ROSTER_KEY_PREFIX,
  rosterKey,
  type StoredThread,
  storedFromInfo,
  threadIdFromKey
} from "./registry";

export interface Env {
  VOICE_SESSIONS: DurableObjectNamespace<VoiceSessionDurableObject>;
  // Static-asset handler for the built Vite SPA (../web/dist). Serves /assets/* + the build manifest;
  // the Worker owns /s/<id> and /ws/<id>.
  ASSETS: Fetcher;
  // Cloudflare native Rate Limiting (wrangler.toml). Caps WS-connect attempts per IP — abuse insurance,
  // NOT the capability gate (a wrong secret already lands on a different, empty DO). Best-effort.
  WS_CONNECT: RateLimit;
}

// Daemon sockets carry their threadId (the routing key); browser sockets carry only the role. A daemon
// attachment is dedup'd by threadId; a browser is not (phone + desktop may both watch).
export type SocketAttachment = { role: "daemon"; threadId: ThreadId } | { role: "browser" };

export class VoiceSessionDurableObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Device-pairing claim (POST /claim/<sessionId>): mint/refresh this phone's device cookie if a
    // pairing window is open. Handled before the WebSocket path since it is a plain HTTP request.
    const claimSessionId = parseBridgeClaimPath(url.pathname);
    if (claimSessionId) return this.handleClaim(request, claimSessionId);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const sessionId = parseBridgeWebSocketPath(url.pathname);
    const { role, threadId: daemonThreadId } = readBridgeAuthQuery(url.searchParams);

    // Browsers must connect from the bridge's own origin; the daemon (Node `ws`) sends no Origin
    // header. WebSockets bypass CORS, so this is a defence against a malicious page opening the socket.
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) {
      return new Response("Forbidden origin", { status: 403 });
    }

    if (!role || !sessionId) {
      return new Response("Invalid role", { status: 400 });
    }

    // Reaching this DO only proves knowledge of the sessionId (= sha256(secret) truncated), which a leaked phone URL
    // also yields — so each role is gated separately:
    //  - a browser must present a paired device cookie (minted via /claim during a pairing window), so a
    //    leaked URL opened after the window, with no cookie, is rejected here;
    //  - a daemon must present the machine-local daemonKey (never in any URL), so a leaked-URL holder
    //    can't impersonate a daemon to re-open a pairing window or terminate the session.
    if (role === "browser" && !(await this.hasPairedDevice(request, sessionId))) {
      return new Response("Unpaired device", { status: 401 });
    }
    if (role === "daemon" && !(await this.authenticateDaemon(request))) {
      return new Response("Unauthorized daemon", { status: 401 });
    }

    const threadId = role === "daemon" ? daemonThreadId : undefined;
    if (role === "daemon" && !threadId) {
      return new Response("Missing threadId", { status: 400 });
    }

    // Per-thread dedup: a reconnecting/zombie pane shares its threadId, so evict ONLY that thread's
    // stale socket — siblings are untouched. "Newer connection wins," scoped to one thread.
    if (role === "daemon" && threadId) this.evictThread(threadId);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: SocketAttachment = role === "daemon" && threadId ? { role, threadId } : { role: "browser" };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);

    // A daemon connecting (re)claims the session: cancel any pending revoke-on-exit alarm, then decide
    // pairing. THE BRIDGE owns this (not the daemon): if no device is paired yet, open a pairing window
    // now — synchronously, before the phone can claim, so there's no race/flicker. A session that
    // already has a paired device opens NO window (a restart, an extra pane, a morning reconnect just
    // works). Either way tell the daemon whether a window is open, so /voice-control:start shows the
    // right message.
    if (role === "daemon") {
      await this.ctx.storage.deleteAlarm();
      const paired = await this.anyDevicePaired();
      if (paired) {
        this.signalDaemon(server, false);
      } else {
        await this.openClaimWindow(); // signals all daemons (incl. this one) that a window is open
      }
    }

    // A fresh phone needs the full roster to render/grade every thread, even threads whose daemon is
    // currently offline (their stored lastSeenAt drives grading).
    if (role === "browser") await this.sendRoster(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    const envelope = safeJson<BridgeEnvelope>(message);
    if (!envelope) return;

    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (!attachment) return;

    // ---- daemon → DO / browser --------------------------------------------------------
    if (attachment.role === "daemon") {
      // The daemon ends its thread on shutdown so a leaked URL can't reconnect to a dead session.
      // Removing the last thread expires the whole session; otherwise it just drops that thread.
      // (`event` is required by the type but this is untrusted wire data, so guard it.)
      if (envelope.channel === "control" && envelope.event?.type === "terminate") {
        await this.removeThread(attachment.threadId, ws);
        return;
      }
      // Explicit /voice-control:pair — open a pairing window to add another device even though one is
      // already paired (an unpaired session already got its window automatically on connect).
      if (envelope.channel === "control" && envelope.event?.type === "open_claim_window") {
        await this.openClaimWindow();
        return;
      }
      // Register/refresh this thread's label + state in the roster, then broadcast the delta.
      if (envelope.channel === "registry" && envelope.event?.type === "thread_register") {
        await this.upsertThread(attachment.threadId, envelope.event.info);
        return;
      }
      // Content → all browsers, re-tagged with the daemon's own threadId from its attachment (the DO
      // trusts the attachment, not the wire).
      if (envelope.channel === "browser") {
        this.broadcastToBrowsers({ ...envelope, threadId: attachment.threadId });
      }
      return;
    }

    // ---- browser → ONE thread's daemon ------------------------------------------------
    if (attachment.role === "browser" && envelope.channel === "daemon") {
      // Route the sealed envelope to the addressed thread's daemon. If it's offline, drop it: the DO
      // can't synthesize a reply (it can't read or write sealed content), and the browser already
      // learns the thread is gone from the roster `thread_left` it broadcast when the daemon dropped.
      const target = this.daemonSocket(envelope.threadId);
      if (target) send(target, envelope);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  // A daemon socket dropping marks its thread offline (stamp lastSeenAt, broadcast thread_left) and, if
  // it was the last thread, arms the revoke-on-exit grace alarm. A browser leaving is a no-op.
  private async onSocketGone(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | undefined;
    if (attachment?.role !== "daemon") return;

    const stored = await this.getThread(attachment.threadId);
    // Already gone — a clean terminate removed it (maybe expiring the session). Without this guard the
    // trailing close after expireSession() would re-arm a spurious alarm on an already-empty DO.
    if (!stored) return;

    const lastSeenAt = Date.now();
    await this.putThread(attachment.threadId, { ...stored, lastSeenAt });
    this.broadcastToBrowsers({
      channel: "roster",
      event: { type: "thread_left", threadId: attachment.threadId, lastSeenAt }
    });

    // Last daemon gone → start the revoke-on-exit grace timer (a reconnecting daemon cancels it).
    if (this.noDaemonRemains(ws)) await this.ctx.storage.setAlarm(Date.now() + EMPTY_SESSION_GRACE_MS);
  }

  // Revoke-on-exit: fires EMPTY_SESSION_GRACE_MS after the roster went empty. Re-check it is STILL
  // empty (a daemon may have reconnected and cancelled), so a flapping daemon never loses a live session.
  async alarm(): Promise<void> {
    if (!this.noDaemonRemains()) return;
    await this.expireSession();
  }

  // ---- roster mutation -------------------------------------------------------

  // Register or refresh a thread, then broadcast a `thread_joined` upsert (the browser keys the roster
  // by threadId and replaces, so one event covers first-seen AND label/state refresh).
  private async upsertThread(threadId: ThreadId, info: WireThreadInfo): Promise<void> {
    const stored = storedFromInfo(info);
    await this.putThread(threadId, stored);
    // `spawnId` rides only on this live delta (a one-shot follow signal), never into storage — so a
    // later full-roster snapshot can't re-fire the follow.
    const thread: WireRosterThread = { threadId, ...stored, connected: true, spawnId: info.spawnId };
    this.broadcastToBrowsers({ channel: "roster", event: { type: "thread_joined", thread } });
  }

  // Remove a thread on a clean terminate. Dropping the LAST thread expires the whole session (the user
  // ran /stop in the only pane). `terminatingSocket` is still listed by getWebSockets() here, so
  // exclude it from the "any daemon left?" check.
  private async removeThread(threadId: ThreadId, terminatingSocket: WebSocket): Promise<void> {
    await this.ctx.storage.delete(rosterKey(threadId));
    this.evictThread(threadId);
    this.broadcastToBrowsers({
      channel: "roster",
      event: { type: "thread_left", threadId, lastSeenAt: Date.now() }
    });
    if (this.noDaemonRemains(terminatingSocket)) await this.expireSession();
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

  // Close any attached daemon socket for `threadId` (1012 = non-terminal, so a still-live peer would
  // reconnect; a zombie is dropped). Used by per-thread dedup + removeThread.
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

  // Is no daemon left, so revoke-on-exit should fire? Excludes a closing socket that getWebSockets()
  // still lists during its own handler. The decision lives in registry.isLastDaemon.
  private noDaemonRemains(exclude?: WebSocket): boolean {
    return isLastDaemon(this.ctx.getWebSockets(), roleOf, exclude);
  }

  // Send the full roster to one browser: every stored thread, `connected` computed live from attached
  // daemon sockets, with stored `lastSeenAt` for offline grading.
  private async sendRoster(target: WebSocket): Promise<void> {
    const stored = await this.ctx.storage.list<StoredThread>({ prefix: ROSTER_KEY_PREFIX });
    const now = Date.now();
    const connected = (threadId: ThreadId) => this.daemonSocket(threadId) !== undefined;
    // Prune long-offline ghosts from storage so they can't accumulate (buildRoster also excludes them).
    // Awaited as one batch — unawaited DO storage writes can silently drop.
    const ghosts = [...stored]
      .filter(([key, v]) => isGhostThread(v, connected(threadIdFromKey(key)), now))
      .map(([key]) => key);
    if (ghosts.length > 0) await this.ctx.storage.delete(ghosts);
    send(target, { channel: "roster", event: { type: "thread_roster", threads: buildRoster(stored, connected, now) } });
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

  // ---- device pairing --------------------------------------------------------

  // POST /claim/<sessionId>: the phone calls this before opening its socket. Mints an httpOnly device
  // cookie if a pairing window is open (or refreshes an already-paired device); otherwise 403 so the
  // phone shows "link expired — run /voice-control:pair". The token's HASH is stored, never the token.
  private async handleClaim(request: Request, sessionId: string): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const cookieName = deviceCookieName(sessionId);
    const presented = readCookie(request.headers.get("Cookie"), cookieName);
    const hasValidCookie = presented ? await this.deviceKnown(presented) : false;
    const open = windowOpen(await this.ctx.storage.get<number>(CLAIM_WINDOW_KEY), Date.now());

    const decision = claimDecision(hasValidCookie, open);
    if (decision === "reject") {
      // Distinguish "you were paired but your session lapsed" (a cookie is present but no longer
      // recognised — e.g. revoke-on-exit wiped it) from "this is a fresh/used link" (no cookie), so the
      // phone can show the right message. Both need a new /voice-control:pair.
      return jsonResponse({ reason: presented ? "stale" : "expired" }, 403);
    }
    // Mint a fresh token, or re-use the already-valid one. Either way store it with a fresh `createdAt`
    // and (re)set the cookie, so an in-use device's lifetime rolls forward (claim runs on every
    // reconnect) on BOTH the server (DEVICE_TTL_MS) and the browser (Max-Age) and never expires mid-use.
    // Drop `Secure` only for local http dev (wrangler dev), where the browser would refuse to store it.
    const token = decision === "mint" ? mintDeviceToken() : (presented as string);
    await this.ctx.storage.put(deviceStorageKey(await hashToken(token)), { createdAt: Date.now() });
    if (decision === "mint") {
      // Single-use: the first device to pair closes the window, so a leaked URL can't be claimed by a
      // racing second device even within the 90s. The DO serializes requests, so this is atomic — a
      // simultaneous second claim finds the window already gone. (The window still also expires on its
      // own after CLAIM_WINDOW_MS if never used.) Re-pairing another device needs a fresh /pair. Tell the
      // daemons the session is now paired so /status reflects it.
      await this.ctx.storage.delete(CLAIM_WINDOW_KEY);
      this.signalDaemons(false);
    }
    const secure = new URL(request.url).protocol === "https:";
    return jsonResponse({ ok: true }, 200, { "set-cookie": buildSetCookie(cookieName, token, secure) });
  }

  // Does the request carry a cookie whose token is in this session's device set?
  private async hasPairedDevice(request: Request, sessionId: string): Promise<boolean> {
    const presented = readCookie(request.headers.get("Cookie"), deviceCookieName(sessionId));
    return presented ? this.deviceKnown(presented) : false;
  }

  // Is any device currently paired (a fresh device token exists)? Decides whether a connecting daemon's
  // session needs a pairing window opened.
  private async anyDevicePaired(): Promise<boolean> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<{ createdAt: number }>({ prefix: DEVICE_STORAGE_PREFIX });
    // Sweep abandoned tokens (a phone that paired once and never came back) while we already hold the list.
    // They can never authenticate — both this and deviceKnown gate on deviceFresh — but nothing else GCs
    // them, so iterate fully (no early return) and batch-delete the stale, mirroring sendRoster's ghost-prune.
    let paired = false;
    const stale: string[] = [];
    for (const [key, entry] of entries) {
      if (deviceFresh(entry.createdAt, now)) paired = true;
      else stale.push(key);
    }
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    return paired;
  }

  // Open a pairing window and tell the daemons it's open (so the start/status skills say "scan to pair").
  private async openClaimWindow(): Promise<void> {
    await this.ctx.storage.put(CLAIM_WINDOW_KEY, Date.now() + CLAIM_WINDOW_MS);
    this.signalDaemons(true);
  }

  // Tell every attached daemon whether a pairing window is currently open.
  private signalDaemons(open: boolean): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (roleOf(socket) === "daemon") this.signalDaemon(socket, open);
    }
  }

  private signalDaemon(socket: WebSocket, open: boolean): void {
    send(socket, { channel: "session", event: { type: "pairing", open } });
  }

  // A device is known if its token hash is stored AND was last used within the rolling TTL. A stale
  // entry is pruned on sight (so device tokens don't accumulate forever after a phone stops coming back).
  private async deviceKnown(token: string): Promise<boolean> {
    const key = deviceStorageKey(await hashToken(token));
    const entry = await this.ctx.storage.get<{ createdAt: number }>(key);
    if (!entry) return false;
    if (!deviceFresh(entry.createdAt, Date.now())) {
      await this.ctx.storage.delete(key);
      return false;
    }
    return true;
  }

  // Authenticate a daemon-role socket by its daemonKey header (session.json, never in any URL). Pinned
  // on the very first daemon connect (trust-on-first-use) and required to match thereafter — so a leaked
  // URL (which yields only the sessionId, not daemonKey) cannot connect as a daemon. The pin SURVIVES
  // expireSession (revoke-on-exit), so an idled-then-resumed session can't fall back to TOFU and be
  // squatted by a leaked-URL holder. TOFU is therefore exposed only at the very first connect for a
  // sessionId — before the daemon has even generated the URL — so there is no real squat window.
  private async authenticateDaemon(request: Request): Promise<boolean> {
    const presented = request.headers.get(BRIDGE_DAEMON_KEY_HEADER);
    if (!presented) return false;
    const hash = await hashToken(presented);
    const pinned = await this.ctx.storage.get<string>(DAEMON_AUTH_KEY);
    if (pinned === undefined) {
      await this.ctx.storage.put(DAEMON_AUTH_KEY, hash);
      return true;
    }
    return pinned === hash;
  }

  // Tear the session down: close every socket (1008 terminal — the daemon treats it as "do not
  // reconnect") and wipe the roster + pairing window. PAIRED DEVICE TOKENS and the DAEMON-KEY PIN are
  // kept. Keeping device tokens (subject to their rolling TTL) lets a phone reconnect after an idle
  // session — e.g. a morning refresh after the laptop slept — without re-pairing. Keeping the pin is a
  // SECURITY requirement: if we dropped it, an idled session would fall back to trust-on-first-use, so a
  // leaked-URL holder could connect as a daemon (any key), re-open a pairing window, and pair. With the
  // pin retained, only the real daemon (holding session.json's daemonKey) can be a daemon; a fresh
  // secret means a new sessionId → a different DO, so the stale pin never blocks a genuine reset.
  private async expireSession(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(1008, "session ended");
    }
    const keep = (key: string) => key.startsWith(DEVICE_STORAGE_PREFIX) || key === DAEMON_AUTH_KEY;
    const stale = [...(await this.ctx.storage.list()).keys()].filter((key) => !keep(key));
    if (stale.length > 0) await this.ctx.storage.delete(stale);
  }
}

function send(socket: WebSocket, envelope: BridgeEnvelope): void {
  try {
    socket.send(JSON.stringify(envelope));
  } catch {
    // socket is closing; ignore
  }
}

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}

// The role on a socket's attachment (undefined if unattached). Used by the revoke-on-exit decision.
function roleOf(socket: WebSocket): "daemon" | "browser" | undefined {
  return (socket.deserializeAttachment() as SocketAttachment | undefined)?.role;
}

function safeJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
