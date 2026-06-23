import { describe, expect, it } from "vitest";
import { buildThread, messageFromHistory, newestPlayableReply } from "./messages";
import type { HistoryTurn } from "./protocol";

// A projected history turn: native uuid (requestId) + native timestamp.
function turn(uuid: string, timestamp: number, role: "user" | "claude", text: string, hasAudio = false): HistoryTurn {
  return { requestId: uuid, timestamp, role, text, hasAudio };
}

describe("buildThread", () => {
  it("orders the snapshot newest-first by native timestamp", () => {
    const out = buildThread(
      [turn("a", 1001, "user", "first"), turn("c", 1003, "user", "third"), turn("b", 1002, "claude", "second")].map(
        messageFromHistory
      )
    );
    expect(out.map((m) => m.requestId)).toEqual(["c", "b", "a"]);
  });

  it("dedupes by native uuid (a turn re-sent in a later snapshot never duplicates)", () => {
    const out = buildThread(
      [turn("u", 1001, "user", "q"), turn("r", 1002, "claude", "answer"), turn("r", 1002, "claude", "answer")].map(
        messageFromHistory
      )
    );
    expect(out.filter((m) => m.requestId === "r")).toHaveLength(1);
  });

  it("orders correctly across a daemon RESTART (native timestamps are monotonic; the old seq reset)", () => {
    // The phone still holds the previous session's turns (high timestamps); the restarted daemon's first
    // turns have LATER wall-clock timestamps, so they sort on top — never buried, the restart-misorder bug.
    const beforeRestart = [turn("old1", 5000, "user", "earlier"), turn("old2", 5001, "claude", "earlier reply")];
    const afterRestart = [turn("new1", 9000, "user", "new message"), turn("new2", 9001, "claude", "new reply")];
    const out = buildThread([...beforeRestart, ...afterRestart].map(messageFromHistory));
    expect(out.map((m) => m.requestId)).toEqual(["new2", "new1", "old2", "old1"]);
  });

  it("caps the thread at the MAX_LOG window, keeping the newest", () => {
    const turns = Array.from({ length: 80 }, (_, i) => turn(`r${i}`, 1000 + i, "claude", `a${i}`));
    const out = buildThread(turns.map(messageFromHistory));
    expect(out).toHaveLength(60);
    expect(out[0].requestId).toBe("r79");
    expect(out[out.length - 1].requestId).toBe("r20");
  });
});

describe("messageFromHistory", () => {
  it("maps a user turn to a 'you' row and a claude turn to a 'claude' row, carrying native id + meta", () => {
    const user = messageFromHistory(turn("u", 1000, "user", "hi"));
    const claude = messageFromHistory(turn("a", 1001, "claude", "hello", true));
    expect(user.kind).toBe("you");
    expect(user.id).toBe("u"); // native uuid is the render key
    expect(claude.kind).toBe("claude");
    expect(claude.requestId).toBe("a");
    expect(claude.timestamp).toBe(1001);
    expect(claude.hasAudio).toBe(true);
    expect(user.hasAudio).toBe(false);
  });

  it("carries the interim flag for steps (and defaults it false)", () => {
    const step = messageFromHistory({
      requestId: "s",
      timestamp: 1002,
      role: "claude",
      text: "I'll read it",
      hasAudio: false,
      interim: true
    });
    const reply = messageFromHistory(turn("a", 1003, "claude", "done"));
    expect(step.interim).toBe(true);
    expect(reply.interim).toBe(false);
  });
});

describe("newestPlayableReply — play-on-land target", () => {
  const step = (uuid: string) =>
    messageFromHistory({
      requestId: uuid,
      timestamp: 1000,
      role: "claude",
      text: "step",
      hasAudio: false,
      interim: true
    });

  it("returns the FIRST (newest-first) non-interim Claude reply's requestId", () => {
    // Newest-first order: a fresh reply on top, then a step, then an older reply.
    const messages = [
      messageFromHistory(turn("newest", 1003, "claude", "done")),
      step("s"),
      messageFromHistory(turn("older", 1001, "claude", "prev"))
    ];
    expect(newestPlayableReply(messages)).toBe("newest");
  });

  it("skips interim steps and the user's own turns", () => {
    const messages = [
      step("s1"),
      messageFromHistory(turn("u", 1002, "user", "ask")),
      messageFromHistory(turn("reply", 1001, "claude", "answer"))
    ];
    expect(newestPlayableReply(messages)).toBe("reply");
  });

  it("returns null when there is no playable reply (empty / only steps / only user turns)", () => {
    expect(newestPlayableReply([])).toBeNull();
    expect(newestPlayableReply([step("s")])).toBeNull();
    expect(newestPlayableReply([messageFromHistory(turn("u", 1000, "user", "ask"))])).toBeNull();
  });
});
