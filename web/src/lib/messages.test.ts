import { describe, expect, it } from "vitest";
import { type Message, makeMessage, messageFromHistory, reconcileMessages } from "./messages";
import type { HistoryTurn } from "./protocol";

// A daemon-originated row (transcript / claude_reply / history) carries seq + timestamp.
function turn(seq: number, role: "user" | "claude", text: string, hasAudio = false): HistoryTurn {
  return { seq, timestamp: 1000 + seq, requestId: `r${seq}`, role, text, hasAudio };
}

describe("reconcileMessages", () => {
  it("orders the thread newest-first by seq", () => {
    const a = makeMessage("You", "first", "r1", { seq: 1, timestamp: 1001 });
    const b = makeMessage("Claude Code", "second", "r2", { seq: 2, timestamp: 1002 });
    const c = makeMessage("You", "third", "r3", { seq: 3, timestamp: 1003 });
    const out = reconcileMessages([], [a, c, b]);
    expect(out.map((m) => m.requestId)).toEqual(["r3", "r2", "r1"]);
  });

  it("dedups a turn echoed live then seen again in a history snapshot (by seq)", () => {
    // Live claude_reply, then a reconnect history that includes the same turn.
    const live = makeMessage("Claude Code", "answer", "r2", { seq: 2, timestamp: 1002 });
    const restored = [turn(1, "user", "q"), turn(2, "claude", "answer")].map(messageFromHistory);
    const out = reconcileMessages([live], restored);
    expect(out.map((m) => m.requestId)).toEqual(["r2", "r1"]);
    // Exactly one row for seq 2 (no duplicate).
    expect(out.filter((m) => m.seq === 2)).toHaveLength(1);
  });

  it("lets a later occurrence upgrade hasAudio (history teaches a live row it is fetchable)", () => {
    const live = makeMessage("Claude Code", "answer", "r2", { seq: 2, timestamp: 1002 });
    expect(live.hasAudio).toBeUndefined();
    const restored = messageFromHistory(turn(2, "claude", "answer", true));
    const out = reconcileMessages([live], [restored]);
    expect(out.find((m) => m.seq === 2)?.hasAudio).toBe(true);
  });

  it("dedups by requestId for seq-less rows", () => {
    const first: Message = { id: "x", kind: "claude", requestId: "rx", title: "", body: "one", time: "" };
    const again: Message = { id: "x2", kind: "claude", requestId: "rx", title: "", body: "two", time: "" };
    const out = reconcileMessages([first], [again]);
    const matches = out.filter((m) => m.requestId === "rx");
    expect(matches).toHaveLength(1);
    expect(matches[0].body).toBe("two"); // later occurrence wins
  });

  it("restores a full thread on reconnect, merging with anything already present", () => {
    // Phone already saw turns 5 & 6 live; reconnect history carries the last few turns.
    const live = [
      makeMessage("You", "q3", "r5", { seq: 5, timestamp: 1005 }),
      makeMessage("Claude Code", "a3", "r6", { seq: 6, timestamp: 1006 })
    ];
    const restored = [
      turn(3, "user", "q2"),
      turn(4, "claude", "a2", true),
      turn(5, "user", "q3"),
      turn(6, "claude", "a3", true)
    ].map(messageFromHistory);
    const out = reconcileMessages(live, restored);
    expect(out.map((m) => m.requestId)).toEqual(["r6", "r5", "r4", "r3"]);
  });

  it("caps the thread at the MAX_LOG window", () => {
    const incoming = Array.from({ length: 80 }, (_, i) =>
      makeMessage("Claude Code", `a${i}`, `r${i}`, { seq: i, timestamp: 1000 + i })
    );
    const out = reconcileMessages([], incoming);
    expect(out).toHaveLength(60);
    // Newest 60 survive (seq 79..20); the oldest are dropped.
    expect(out[0].seq).toBe(79);
    expect(out[out.length - 1].seq).toBe(20);
  });
});

describe("messageFromHistory", () => {
  it("maps a user turn to a 'you' row and a claude turn to a 'claude' row, carrying meta", () => {
    const user = messageFromHistory(turn(1, "user", "hi"));
    const claude = messageFromHistory(turn(2, "claude", "hello", true));
    expect(user.kind).toBe("you");
    expect(claude.kind).toBe("claude");
    expect(claude.requestId).toBe("r2");
    expect(claude.seq).toBe(2);
    expect(claude.hasAudio).toBe(true);
    expect(user.hasAudio).toBe(false);
  });
});
