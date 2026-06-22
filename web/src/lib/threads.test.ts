import { describe, expect, it } from "vitest";
import type { RosterThread } from "./protocol";
import {
  activeThread,
  applyJoined,
  applyLeft,
  applyRoster,
  bumpUnread,
  initialThreadsState,
  switchThread,
  type ThreadsState,
  unreadFor
} from "./threads";

function thread(threadId: string, over: Partial<RosterThread> = {}): RosterThread {
  return {
    threadId,
    label: { title: threadId },
    state: "idle",
    listening: true,
    connected: true,
    lastSeenAt: null,
    ...over
  };
}

// A store with two connected threads, A active. Each case starts here and asserts one transition.
function twoThreads(): ThreadsState {
  return applyRoster(initialThreadsState, [thread("a"), thread("b")]);
}

describe("applyRoster — the snapshot a (re)connecting browser receives", () => {
  it("focuses the first thread when nothing was active yet", () => {
    const state = applyRoster(initialThreadsState, [thread("a"), thread("b")]);
    expect(state.threads.map((t) => t.threadId)).toEqual(["a", "b"]);
    expect(state.activeThreadId).toBe("a");
  });

  it("sorts offline threads last and defaults to a CONNECTED thread (never a dormant pane)", () => {
    // The QR/refresh used to land on threads[0] regardless of presence — i.e. a dormant offline thread.
    const state = applyRoster(initialThreadsState, [
      thread("offline", { connected: false, lastSeenAt: 1 }),
      thread("live")
    ]);
    expect(state.threads.map((t) => t.threadId)).toEqual(["live", "offline"]); // offline sorted last
    expect(state.activeThreadId).toBe("live"); // default skips the offline one
  });

  it("preserves the active thread across a snapshot when it survives", () => {
    const before = switchThread(twoThreads(), "b");
    const after = applyRoster(before, [thread("a"), thread("b"), thread("c")]);
    expect(after.activeThreadId).toBe("b");
  });

  it("falls back to the first thread when the active one vanished from the roster", () => {
    const before = switchThread(twoThreads(), "b");
    const after = applyRoster(before, [thread("a"), thread("c")]);
    expect(after.activeThreadId).toBe("a");
  });

  it("drops unread counts for threads no longer present", () => {
    const before = bumpUnread(twoThreads(), "b"); // b has unread while a is active
    const after = applyRoster(before, [thread("a")]); // b is gone
    expect(unreadFor(after, "b")).toBe(0);
    expect(after.unread.has("b")).toBe(false);
  });

  it("clears the active thread when the roster goes empty", () => {
    const after = applyRoster(twoThreads(), []);
    expect(after.activeThreadId).toBeNull();
    expect(after.threads).toEqual([]);
  });
});

describe("applyJoined — upsert (first-seen AND label/state refresh)", () => {
  it("appends a never-seen thread", () => {
    const after = applyJoined(twoThreads(), thread("c"));
    expect(after.threads.map((t) => t.threadId)).toEqual(["a", "b", "c"]);
  });

  it("replaces a known thread in place (refresh) without reordering", () => {
    const refreshed = thread("a", { state: "working", label: { title: "a · working" } });
    const after = applyJoined(twoThreads(), refreshed);
    expect(after.threads.map((t) => t.threadId)).toEqual(["a", "b"]);
    expect(after.threads[0].state).toBe("working");
    expect(after.threads[0].label.title).toBe("a · working");
  });

  it("makes the very first thread active", () => {
    const after = applyJoined(initialThreadsState, thread("a"));
    expect(after.activeThreadId).toBe("a");
    expect(activeThread(after)?.threadId).toBe("a");
  });

  it("does not steal focus from an already-active thread", () => {
    const before = switchThread(twoThreads(), "b");
    const after = applyJoined(before, thread("c"));
    expect(after.activeThreadId).toBe("b");
  });
});

describe("applyLeft — a thread's daemon dropped", () => {
  it("keeps the thread but flips it offline + stamps lastSeenAt (#10 grading)", () => {
    const after = applyLeft(twoThreads(), "b", 1_700_000_000_000);
    const b = after.threads.find((t) => t.threadId === "b");
    expect(b?.connected).toBe(false);
    expect(b?.lastSeenAt).toBe(1_700_000_000_000);
    // The roster still lists it (greyed), so the swipe pager / switcher don't yank the pane.
    expect(after.threads.map((t) => t.threadId)).toEqual(["a", "b"]);
  });

  it("leaves the active thread unchanged even if it's the one that left", () => {
    const after = applyLeft(twoThreads(), "a", 1);
    expect(after.activeThreadId).toBe("a");
    expect(after.threads.find((t) => t.threadId === "a")?.connected).toBe(false);
  });
});

describe("bumpUnread — a reply landed on a thread", () => {
  it("increments a background thread's badge", () => {
    const after = bumpUnread(bumpUnread(twoThreads(), "b"), "b");
    expect(unreadFor(after, "b")).toBe(2);
  });

  it("never counts the active thread (it's on screen)", () => {
    const after = bumpUnread(twoThreads(), "a"); // a is active
    expect(unreadFor(after, "a")).toBe(0);
  });

  it("adds a batch of new messages at once (and a non-positive count is a no-op)", () => {
    const after = bumpUnread(twoThreads(), "b", 3);
    expect(unreadFor(after, "b")).toBe(3);
    expect(unreadFor(bumpUnread(after, "b", 0), "b")).toBe(3); // 0 → unchanged
  });
});

describe("switchThread — focus + clear unread", () => {
  it("activates the target and clears only its unread", () => {
    const withUnread = bumpUnread(bumpUnread(twoThreads(), "b"), "b");
    const after = switchThread(withUnread, "b");
    expect(after.activeThreadId).toBe("b");
    expect(unreadFor(after, "b")).toBe(0);
  });

  it("is a no-op for the already-active thread (same reference back)", () => {
    const state = twoThreads();
    expect(switchThread(state, "a")).toBe(state);
  });

  it("is a no-op for an unknown thread", () => {
    const state = twoThreads();
    expect(switchThread(state, "zzz")).toBe(state);
  });
});
