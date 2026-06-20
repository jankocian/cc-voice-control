// Pure thread-registry helpers for the Durable Object, kept free of any `cloudflare:workers`
// import so the routing/dedup/roster rules are unit-testable under plain vitest (the DO class
// itself needs a Workers runtime). index.ts imports these and wires them to ctx.storage /
// getWebSockets(); the decisions live here.

import type { RosterThread, ThreadId, ThreadInfo } from "../../src/shared/protocol";

// A thread's roster entry as stored in the DO: the daemon's last-registered info minus its live
// presence (presence is computed at read time). `lastSeenAt` is stamped when the daemon socket
// closes; null while it is connected (or never seen leaving).
export type StoredThread = Omit<ThreadInfo, "threadId"> & { lastSeenAt: number | null };

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

// Shape a freshly-registered thread for storage: live now, so its lastSeenAt is cleared.
export function storedFromInfo(info: ThreadInfo): StoredThread {
  return { label: info.label, state: info.state, listening: info.listening, lastSeenAt: null };
}

// Assemble the roster a browser receives from the stored thread entries, stamping each with
// live `connected` (is a daemon socket attached for it right now?). Pure (storage map +
// presence predicate in, RosterThread[] out) so the join/lastSeenAt shaping is testable
// without a DO runtime.
export function buildRoster(
  stored: Map<string, StoredThread>,
  isConnected: (threadId: ThreadId) => boolean
): RosterThread[] {
  const threads: RosterThread[] = [];
  for (const [key, value] of stored) {
    const threadId = threadIdFromKey(key);
    threads.push({ threadId, ...value, connected: isConnected(threadId) });
  }
  return threads;
}
