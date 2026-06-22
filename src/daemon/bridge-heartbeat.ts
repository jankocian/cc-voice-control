// Keepalive for the daemon's bridge WebSocket. Removing the old 4s status heartbeat (v4) also removed
// the only traffic on an idle socket, so an idle-dropped connection went unnoticed: Cloudflare saw the
// close (marked the thread offline → phone reads "Session offline"), but the daemon's socket sat in a
// zombie OPEN state forever, so it never reconnected even though the process was alive. A ping/pong
// heartbeat fixes both halves — it keeps the idle socket warm AND detects a half-open drop.

const OPEN = 1; // WebSocket.OPEN — inlined so the helper needn't import `ws`.

// The slice of the `ws` socket the heartbeat needs. Keeping it structural lets the unit test drive it
// with a fake socket (no real server) — the real `ws` WebSocket satisfies it.
export interface PingableSocket {
  readyState: number;
  on(event: "pong", listener: () => void): void;
  ping(): void;
  terminate(): void;
}

// Ping every `intervalMs`. Each tick: if the previous ping got no pong, the connection is dead →
// terminate it (the caller's `close` handler then reconnects); otherwise send a ping. Cloudflare
// auto-responds to ping frames with pongs even while the Durable Object hibernates, so a healthy idle
// socket stays warm and a dead one is caught within ~2 intervals. Returns a stop() to clear the timer
// (call it from the socket's `close` handler so a reconnect starts a fresh heartbeat).
export function startBridgeHeartbeat(socket: PingableSocket, intervalMs: number): () => void {
  let awaitingPong = false;
  socket.on("pong", () => {
    awaitingPong = false;
  });
  const timer = setInterval(() => {
    if (socket.readyState !== OPEN) return; // closing/closed — the close handler owns reconnect
    if (awaitingPong) {
      socket.terminate(); // no pong since the last tick → half-open; force a close → reconnect
      return;
    }
    awaitingPong = true;
    socket.ping();
  }, intervalMs);
  return () => clearInterval(timer);
}
