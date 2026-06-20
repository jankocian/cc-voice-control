import { describe, expect, it } from "vitest";
import { buildHistoryEvent, HistoryRing, selectAudioReply } from "./history-ring.js";

const audio = { audioBase64: "AAAA", mimeType: "audio/mpeg" };

// A deterministic clock so timestamps are assertable.
function clock(start = 1000) {
  let t = start;
  return () => t++;
}

describe("HistoryRing", () => {
  it("stamps every turn with a monotonic seq and a timestamp", () => {
    const ring = new HistoryRing(3, clock());
    const u = ring.add("user", "u1", "hello");
    const c = ring.add("claude", "c1", "hi there");
    expect(u.seq).toBe(1);
    expect(c.seq).toBe(2);
    expect(u.timestamp).toBe(1000);
    expect(c.timestamp).toBe(1001);
  });

  it("keeps exactly the last N reply-turns plus the user message(s) that precede them", () => {
    const ring = new HistoryRing(2, clock());
    // Four full turns: each user message immediately followed by its reply.
    ring.add("user", "u1", "q1");
    ring.add("claude", "c1", "a1");
    ring.add("user", "u2", "q2");
    ring.add("claude", "c2", "a2");
    ring.add("user", "u3", "q3");
    ring.add("claude", "c3", "a3");
    ring.add("user", "u4", "q4");
    ring.add("claude", "c4", "a4");

    // Only the last 2 reply-turns survive (c3+c4 and their parent users u3+u4).
    const ids = ring.snapshot().map((e) => e.requestId);
    expect(ids).toEqual(["u3", "c3", "u4", "c4"]);
  });

  it("retains multiple user messages leading up to a single retained reply", () => {
    const ring = new HistoryRing(1, clock());
    // Two user messages, then one reply: all three share the single retained reply window.
    ring.add("user", "u1", "part one");
    ring.add("user", "u2", "part two");
    ring.add("claude", "c1", "answer");
    expect(ring.snapshot().map((e) => e.requestId)).toEqual(["u1", "u2", "c1"]);
  });

  it("drops user messages older than the oldest retained reply", () => {
    const ring = new HistoryRing(1, clock());
    ring.add("user", "u1", "old question");
    ring.add("claude", "c1", "old answer");
    ring.add("user", "u2", "new question");
    ring.add("claude", "c2", "new answer");
    // Only the newest reply-turn survives; the older user message is evicted with its reply.
    expect(ring.snapshot().map((e) => e.requestId)).toEqual(["u2", "c2"]);
  });

  it("caps total entries when replies never land, bounding the parentless-user backlog", () => {
    const ring = new HistoryRing(2, clock()); // ceiling = maxReplies(2) * MAX_ENTRIES_PER_REPLY(4) = 8
    // 20 user turns that never produce a reply (e.g. every turn interrupted): reply-window
    // eviction never triggers, so without the ceiling this would grow without bound.
    for (let i = 1; i <= 20; i++) ring.add("user", `u${i}`, `q${i}`);
    const ids = ring.snapshot().map((e) => e.requestId);
    expect(ids).toHaveLength(8);
    // Only the newest 8 survive; the oldest are dropped.
    expect(ids).toEqual(["u13", "u14", "u15", "u16", "u17", "u18", "u19", "u20"]);
  });

  it("attaches audio to the matching reply and ignores evicted ids", () => {
    const ring = new HistoryRing(1, clock());
    ring.add("claude", "c1", "first");
    ring.add("claude", "c2", "second"); // evicts c1
    ring.attachAudio("c1", audio); // no-op (evicted)
    ring.attachAudio("c2", audio);
    expect(ring.get("c1")).toBeUndefined();
    expect(ring.get("c2")?.audio).toEqual(audio);
  });
});

describe("buildHistoryEvent", () => {
  it("emits text-only turns with hasAudio flagged per reply", () => {
    const ring = new HistoryRing(2, clock());
    ring.add("user", "u1", "q");
    ring.add("claude", "c1", "with audio");
    ring.add("claude", "c2", "no audio");
    ring.attachAudio("c1", audio);

    expect(buildHistoryEvent(ring)).toEqual({
      type: "history",
      turns: [
        { seq: 1, timestamp: 1000, requestId: "u1", role: "user", text: "q", hasAudio: false },
        { seq: 2, timestamp: 1001, requestId: "c1", role: "claude", text: "with audio", hasAudio: true },
        { seq: 3, timestamp: 1002, requestId: "c2", role: "claude", text: "no audio", hasAudio: false }
      ]
    });
  });
});

describe("selectAudioReply", () => {
  it("returns a replay-flagged tts_audio when the reply still has audio (hit)", () => {
    const ring = new HistoryRing(2, clock());
    ring.add("claude", "c1", "hi");
    ring.attachAudio("c1", audio);
    expect(selectAudioReply(ring, "c1")).toEqual({ type: "tts_audio", requestId: "c1", replay: true, ...audio });
  });

  it("returns a graceful error when the reply was evicted (miss)", () => {
    const ring = new HistoryRing(1, clock());
    ring.add("claude", "c1", "first");
    ring.add("claude", "c2", "second"); // evicts c1
    expect(selectAudioReply(ring, "c1")).toEqual({
      type: "error",
      requestId: "c1",
      message: "Audio for that reply is no longer available."
    });
  });

  it("returns a graceful error when the reply exists but has no audio yet", () => {
    const ring = new HistoryRing(1, clock());
    ring.add("claude", "c1", "no tts");
    expect(selectAudioReply(ring, "c1")).toEqual({
      type: "error",
      requestId: "c1",
      message: "Audio for that reply is no longer available."
    });
  });
});
