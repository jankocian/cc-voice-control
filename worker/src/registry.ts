// Pure thread-registry helpers for the Durable Object, kept free of any `cloudflare:workers`
// import so the routing/dedup/roster rules are unit-testable under plain vitest (the DO class
// itself needs a Workers runtime). index.ts imports these and wires them to ctx.storage /
// getWebSockets(); the decisions live here.

import type { ThreadId, WireRosterThread, WireThreadInfo } from "../../src/shared/protocol";

// A thread's roster entry as stored in the DO: the daemon's last-registered info minus its live
// presence (presence is computed at read time). `lastSeenAt` is stamped when the daemon socket
// closes; null while it is connected (or never seen leaving). The label is a sealed `EncBlob` the DO
// stores/relays opaquely (it can't read it) — so the worker never sees repo/branch/cwd names.
export type StoredThread = Omit<WireThreadInfo, "threadId"> & { lastSeenAt: number | null };

// Storage key prefix for the per-thread roster. Each thread is one small JSON entry
// (`<prefix><threadId>`) — labels + last-seen only, never conversation content.
export const ROSTER_KEY_PREFIX = "thread:";

// Grace after the roster goes empty before the session is revoked. Covers laptop-sleep /
// Wi-Fi-flap (a daemon reconnecting within the window keeps the session) while ensuring a
// leaked URL goes dead soon after the last pane disconnects (security §6.2).
export const EMPTY_SESSION_GRACE_MS = 3 * 60 * 1000;

export function rosterKey(threadId: ThreadId): string {
  return `${ROSTER_KEY_PREFIX}${threadId}`;
}

export function threadIdFromKey(key: string): ThreadId {
  return key.slice(ROSTER_KEY_PREFIX.length);
}

// Shape a freshly-registered thread for storage: live now, so its lastSeenAt is cleared. `label` is the
// sealed blob the daemon sent — stored as-is.
export function storedFromInfo(info: WireThreadInfo): StoredThread {
  return { label: info.label, state: info.state, listening: info.listening, lastSeenAt: null };
}

// Revoke-on-exit decision: is the given socket the LAST daemon attached? A closing/terminating
// socket is still listed by the DO's getWebSockets() while its own handler runs, so it MUST be
// excluded from the "any daemon left?" check — otherwise running /stop in the only pane would
// never revoke the session. Pure (socket list + role accessor + the excluded socket in, boolean
// out) so the revoke decision — including that exclusion edge — is unit-tested without a Workers
// runtime. `excluded` is omitted by the alarm path (no socket is closing there).
export function isLastDaemon<S>(
  sockets: Iterable<S>,
  roleOf: (socket: S) => "daemon" | "browser" | undefined,
  excluded?: S
): boolean {
  for (const socket of sockets) {
    if (socket === excluded) continue;
    if (roleOf(socket) === "daemon") return false;
  }
  return true;
}

// Assemble the roster a browser receives from the stored thread entries, stamping each with
// live `connected` (is a daemon socket attached for it right now?). Pure (storage map +
// presence predicate in, RosterThread[] out) so the join/lastSeenAt shaping is testable
// without a DO runtime.
// A thread offline (no daemon socket) for longer than this is a "ghost" — a crashed/quit pane the
// user won't return to. Pruned from roster snapshots so a restart-heavy session doesn't pile up dead
// entries (which made the old spawn-follow grab the wrong thread and clutter the switcher). Generous,
// so a briefly-sleeping laptop isn't dropped from the list too eagerly.
export const GHOST_TTL_MS = 30 * 60 * 1000;

export function isGhostThread(stored: StoredThread, connected: boolean, now: number): boolean {
  return !connected && stored.lastSeenAt !== null && now - stored.lastSeenAt > GHOST_TTL_MS;
}

// Build the roster snapshot, computing `connected` live and dropping long-offline ghosts.
export function buildRoster(
  stored: Map<string, StoredThread>,
  isConnected: (threadId: ThreadId) => boolean,
  now: number
): WireRosterThread[] {
  const threads: WireRosterThread[] = [];
  for (const [key, value] of stored) {
    const threadId = threadIdFromKey(key);
    const connected = isConnected(threadId);
    if (isGhostThread(value, connected, now)) continue;
    threads.push({ threadId, ...value, connected });
  }
  return threads;
}
