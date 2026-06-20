import { describe, expect, it } from "vitest";
import type { ThreadInfo } from "../../src/shared/protocol";
import { buildRoster, rosterKey, type StoredThread, storedFromInfo, threadIdFromKey } from "./registry";

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
  it("stamps live `connected` per thread from the presence predicate", () => {
    // Thread A has a live daemon socket; thread B's daemon dropped 3 min ago (offline).
    const map = new Map<string, StoredThread>([
      [rosterKey("a"), stored(labelA, null)],
      [rosterKey("b"), stored(labelB, 1_000)]
    ]);
    const connected = new Set(["a"]);
    const roster = buildRoster(map, (id) => connected.has(id));

    expect(roster).toEqual([
      { threadId: "a", label: labelA, state: "idle", listening: true, lastSeenAt: null, connected: true },
      { threadId: "b", label: labelB, state: "idle", listening: true, lastSeenAt: 1_000, connected: false }
    ]);
  });

  it("includes offline threads (stored but no live socket) so the phone can grade them per #10", () => {
    const map = new Map<string, StoredThread>([[rosterKey("gone"), stored(labelA, 42)]]);
    const roster = buildRoster(map, () => false);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ threadId: "gone", connected: false, lastSeenAt: 42 });
  });

  it("returns an empty roster when no threads are stored", () => {
    expect(buildRoster(new Map(), () => true)).toEqual([]);
  });
});
