import { describe, expect, it } from "vitest";
import type { ThreadInfo } from "../../src/shared/protocol";
import { buildRoster, isLastDaemon, rosterKey, type StoredThread, storedFromInfo, threadIdFromKey } from "./registry";

const labelA = { title: "voice-control · main", repo: "voice-control", branch: "main", cwd: "voice-control" };
const labelB = { title: "api · feat/x", repo: "api", branch: "feat/x", cwd: "api" };

function stored(label: StoredThread["label"], lastSeenAt: number | null): StoredThread {
  return { label, state: "idle", listening: true, lastSeenAt };
}

describe("rosterKey / threadIdFromKey roundtrip", () => {
  it("prefixes and strips the threadId symmetrically", () => {
    expect(rosterKey("surface:1")).toBe("thread:surface:1");
    expect(threadIdFromKey(rosterKey("surface:1"))).toBe("surface:1");
  });
});

describe("storedFromInfo", () => {
  it("clears lastSeenAt (a freshly-registered thread is live right now)", () => {
    const info: ThreadInfo = { threadId: "s", label: labelA, state: "working", listening: false };
    expect(storedFromInfo(info)).toEqual({ label: labelA, state: "working", listening: false, lastSeenAt: null });
  });
});

describe("buildRoster — the snapshot a (re)connecting browser receives", () => {
  const NOW = 1_700_000_000_000;
  const recent = NOW - 60_000; // 1 min ago — offline but within the ghost TTL
  const ancient = NOW - 31 * 60 * 1000; // 31 min ago — a ghost (past GHOST_TTL_MS)

  it("stamps live `connected` per thread from the presence predicate", () => {
    // Thread A has a live daemon socket; thread B's daemon dropped a minute ago (offline, not yet a ghost).
    const map = new Map<string, StoredThread>([
      [rosterKey("a"), stored(labelA, null)],
      [rosterKey("b"), stored(labelB, recent)]
    ]);
    const connected = new Set(["a"]);
    const roster = buildRoster(map, (id) => connected.has(id), NOW);

    expect(roster).toEqual([
      { threadId: "a", label: labelA, state: "idle", listening: true, lastSeenAt: null, connected: true },
      { threadId: "b", label: labelB, state: "idle", listening: true, lastSeenAt: recent, connected: false }
    ]);
  });

  it("includes recently-offline threads (stored, no live socket) so the phone can grade them per #10", () => {
    const map = new Map<string, StoredThread>([[rosterKey("gone"), stored(labelA, recent)]]);
    const roster = buildRoster(map, () => false, NOW);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ threadId: "gone", connected: false, lastSeenAt: recent });
  });

  it("DROPS ghosts (offline longer than the TTL) so a restart-heavy session doesn't pile up dead entries", () => {
    const map = new Map<string, StoredThread>([
      [rosterKey("live"), stored(labelA, null)],
      [rosterKey("ghost"), stored(labelB, ancient)]
    ]);
    const roster = buildRoster(map, (id) => id === "live", NOW);
    expect(roster.map((t) => t.threadId)).toEqual(["live"]);
  });

  it("keeps a still-connected thread even if its stored lastSeenAt is ancient (it's live now)", () => {
    const map = new Map<string, StoredThread>([[rosterKey("back"), stored(labelA, ancient)]]);
    const roster = buildRoster(map, () => true, NOW);
    expect(roster).toHaveLength(1);
  });

  it("returns an empty roster when no threads are stored", () => {
    expect(buildRoster(new Map(), () => true, NOW)).toEqual([]);
  });
});

describe("isLastDaemon — the revoke-on-exit decision (excludes the closing socket)", () => {
  type Sock = { id: number; role: "daemon" | "browser" };
  const roleOf = (s: Sock) => s.role;
  const daemon = (id: number): Sock => ({ id, role: "daemon" });
  const browser = (id: number): Sock => ({ id, role: "browser" });

  it("no daemon attached → true (nothing left to keep the session alive)", () => {
    expect(isLastDaemon([], roleOf)).toBe(true);
    expect(isLastDaemon([browser(1), browser(2)], roleOf)).toBe(true);
  });

  it("a daemon is attached (none excluded) → false", () => {
    expect(isLastDaemon([daemon(1)], roleOf)).toBe(false);
    expect(isLastDaemon([browser(1), daemon(2)], roleOf)).toBe(false);
  });

  it("excludes the closing socket: the ONLY daemon closing → true (it was the last)", () => {
    // getWebSockets() still lists the socket during its own close handler; without the exclusion
    // running /stop in the only pane would never revoke the session.
    const closing = daemon(1);
    expect(isLastDaemon([closing], roleOf, closing)).toBe(true);
    expect(isLastDaemon([closing, browser(2)], roleOf, closing)).toBe(true);
  });

  it("a sibling daemon survives the exclusion → false (never revoke a still-live session)", () => {
    const closing = daemon(1);
    expect(isLastDaemon([closing, daemon(2)], roleOf, closing)).toBe(false);
  });
});
