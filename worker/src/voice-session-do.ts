import { DurableObject } from "cloudflare:workers";
import { readBridgeAuthQuery } from "../../src/shared/bridge-contract";
import type { BridgeEnvelope, RosterThread, ThreadId, ThreadInfo } from "../../src/shared/protocol";
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
    const { role, threadId: daemonThreadId } = readBridgeAuthQuery(url.searchParams);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    // Browsers must connect from the bridge's own origin; the daemon (Node `ws`) sends no Origin
    // header. WebSockets bypass CORS, so this is the only thing stopping a malicious page opening the
    // socket if the session URL ever leaks.
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) {
      return new Response("Forbidden origin", { status: 403 });
    }

    if (!role) {
      return new Response("Invalid role", { status: 400 });
    }

    // No token check here: this DO is only reachable via idFromName(sha256(secret)), so arriving here
    // already proves the caller knows the session secret. The secret is the whole capability.

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

    // A daemon connecting (re)claims the session: cancel any pending revoke-on-exit alarm.
    if (role === "daemon") await this.ctx.storage.deleteAlarm();

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
  private async upsertThread(threadId: ThreadId, info: ThreadInfo): Promise<void> {
    const stored = storedFromInfo(info);
    await this.putThread(threadId, stored);
    // `spawnId` rides only on this live delta (a one-shot follow signal), never into storage — so a
    // later full-roster snapshot can't re-fire the follow.
    const thread: RosterThread = { threadId, ...stored, connected: true, spawnId: info.spawnId };
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

  // Tear the whole session down: close every socket (1008 terminal — the daemon treats it as "do not
  // reconnect") and wipe storage so a leaked URL reaching a revoked session sees nothing.
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
