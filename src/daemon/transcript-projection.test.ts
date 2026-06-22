import { describe, expect, it } from "vitest";
import {
  dropSessionAnnouncement,
  type ProjectedTurn,
  pairReplies,
  projectTurns,
  resolveVoiceReply,
  type TranscriptRecord
} from "./transcript-projection.js";

// Record shapes mirror real Claude Code transcript JSONL (verified against live sessions): top-level
// type/uuid/timestamp/isSidechain/isMeta/promptSource + nested message{role,content,stop_reason}.
const user = (uuid: string, ts: string, content: unknown, extra: Partial<TranscriptRecord> = {}): TranscriptRecord => ({
  type: "user",
  uuid,
  timestamp: ts,
  message: { role: "user", content },
  ...extra
});
const asst = (
  uuid: string,
  ts: string,
  content: unknown,
  stop: string | null = "end_turn",
  extra: Partial<TranscriptRecord> = {}
): TranscriptRecord => ({
  type: "assistant",
  uuid,
  timestamp: ts,
  message: { role: "assistant", stop_reason: stop, content },
  ...extra
});
const text = (t: string) => [{ type: "text", text: t }];

describe("projectTurns — the filter", () => {
  it("keeps real typed/queued user turns and finished assistant replies, dropping all synthetic noise", () => {
    const records: TranscriptRecord[] = [
      // — kept —
      user("u1", "2026-06-21T15:00:01.000Z", "Hee-o.", { promptSource: "typed" }), // voice-injected (cmux types it → typed)
      asst("a1", "2026-06-21T15:00:02.000Z", text("Hey! I hear you.")),
      user("u2", "2026-06-21T15:00:03.000Z", "[Image #5] does this look right?", { promptSource: "typed" }), // real image-prefixed
      user("u3", "2026-06-21T15:00:04.000Z", "yes please", { promptSource: "queued" }),
      asst("a2", "2026-06-21T15:00:05.000Z", text("On it.")),
      // — dropped (synthetic / non-conversational) —
      user("n1", "2026-06-21T15:00:06.000Z", "<command-name>/clear</command-name>"), // slash-command marker (no promptSource)
      user("n2", "2026-06-21T15:00:07.000Z", "Base directory for this skill: /x", { isMeta: true }), // skill body
      user("n3", "2026-06-21T15:00:08.000Z", [{ type: "tool_result", content: "ok" }], { promptSource: "typed" }), // tool result
      user("n4", "2026-06-21T15:00:09.000Z", "<task-notification>done</task-notification>", { promptSource: "system" }),
      user("n5", "2026-06-21T15:00:10.000Z", "/voice-control:start", { promptSource: "typed" }), // a typed slash command
      user("n6", "2026-06-21T15:00:11.000Z", "side", { promptSource: "typed", isSidechain: true }),
      asst("n7", "2026-06-21T15:00:12.000Z", [{ type: "tool_use", id: "t", name: "Bash", input: {} }], "tool_use"),
      asst("n8", "2026-06-21T15:00:13.000Z", [{ type: "thinking", thinking: "hmm" }]), // thinking-only, no text
      asst("n9", "2026-06-21T15:00:14.000Z", text("sub-agent"), "end_turn", { isSidechain: true })
    ];
    const turns = projectTurns(records);
    expect(turns.map((t) => t.uuid)).toEqual(["u1", "a1", "u2", "u3", "a2"]);
    expect(turns.map((t) => t.role)).toEqual(["user", "claude", "user", "user", "claude"]);
    expect(turns.every((t) => t.interim === false)).toBe(true); // no tool_use-with-text records here
    expect(turns[0]).toEqual({
      uuid: "u1",
      timestamp: Date.parse("2026-06-21T15:00:01.000Z"),
      role: "user",
      text: "Hee-o.",
      interim: false
    });
  });

  it("surfaces interim STEPS (assistant text before a tool call) flagged interim, plus the final reply", () => {
    const turns = projectTurns([
      user("u", "2026-06-21T15:00:01.000Z", "fix the bug", { promptSource: "typed" }),
      // narration text written before a tool call → a step
      asst(
        "s1",
        "2026-06-21T15:00:02.000Z",
        [
          { type: "text", text: "I'll start by reading the file." },
          { type: "tool_use", id: "t", name: "Read", input: {} }
        ],
        "tool_use"
      ),
      asst("s2", "2026-06-21T15:00:03.000Z", [{ type: "thinking", thinking: "hmm" }], "tool_use"), // thinking-only → dropped
      asst("a", "2026-06-21T15:00:04.000Z", text("Fixed it."))
    ]);
    expect(turns.map((t) => [t.uuid, t.interim])).toEqual([
      ["u", false],
      ["s1", true], // the step
      ["a", false] // the final reply
    ]);
    expect(turns[1].text).toBe("I'll start by reading the file.");
  });

  it("orders by native timestamp even if records arrive out of order, and uses native uuids as identity", () => {
    const turns = projectTurns([
      asst("a", "2026-06-21T15:00:05.000Z", text("second")),
      user("u", "2026-06-21T15:00:01.000Z", "first", { promptSource: "typed" })
    ]);
    expect(turns.map((t) => t.uuid)).toEqual(["u", "a"]);
  });

  it("keeps only the newest window when over maxTurns", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      user(`u${i}`, `2026-06-21T15:00:${String(i).padStart(2, "0")}.000Z`, `m${i}`, { promptSource: "typed" })
    );
    expect(projectTurns(records, 3).map((t) => t.uuid)).toEqual(["u7", "u8", "u9"]);
  });

  it("drops a thinking-only end_turn record, keeping the later answer text as the final reply", () => {
    // Extended thinking flushes the thinking block as its OWN record stamped end_turn, then streams the
    // answer text (same message) as a second end_turn record many seconds later. The thinking record has
    // no text → dropped; only the answer text becomes the final reply. (Real incident: d6644242 transcript.)
    const turns = projectTurns([
      user("u", "2026-06-22T13:50:35.594Z", "deep research please", { promptSource: "typed" }),
      asst("step", "2026-06-22T13:53:54.182Z", text("Let me read the recorder code."), "tool_use"),
      asst("think", "2026-06-22T13:55:30.072Z", [{ type: "thinking", thinking: "x".repeat(5123) }], "end_turn"),
      asst("answer", "2026-06-22T13:55:49.298Z", text("## What's happening\n\nI traced it…"), "end_turn")
    ]);
    expect(turns.map((t) => [t.uuid, t.interim])).toEqual([
      ["u", false],
      ["step", true],
      ["answer", false] // the thinking-only record is gone
    ]);
    expect(pairReplies(turns).map((p) => [p.prompt?.uuid, p.reply.uuid])).toEqual([["u", "answer"]]);
  });

  it("keeps mid-turn narration as a step and the end_turn text as the final reply", () => {
    const turns = projectTurns([
      user("u", "2026-06-21T15:00:01.000Z", "do it", { promptSource: "typed" }),
      asst(
        "a-mid",
        "2026-06-21T15:00:02.000Z",
        [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "t", name: "Bash", input: {} }
        ],
        "tool_use"
      ),
      asst("a-final", "2026-06-21T15:00:04.000Z", text("done."))
    ]);
    expect(turns.map((t) => [t.uuid, t.interim])).toEqual([
      ["u", false],
      ["a-mid", true],
      ["a-final", false]
    ]);
  });
});

describe("pairReplies — voice TTS targeting", () => {
  it("pairs each reply with the user prompt it answers", () => {
    const turns = projectTurns([
      user("u1", "2026-06-21T15:00:01.000Z", "spoken", { promptSource: "typed" }),
      asst("a1", "2026-06-21T15:00:02.000Z", text("answer"))
    ]);
    const pairs = pairReplies(turns);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reply.uuid).toBe("a1");
    expect(pairs[0].prompt?.text).toBe("spoken");
  });

  it("pairs the voice reply correctly even when a typed prompt queued behind it (reply not newest)", () => {
    // voice "spoken" → its reply, then a typed "typed q" that queued, then ITS reply (newest).
    const turns = projectTurns([
      user("u1", "2026-06-21T15:00:01.000Z", "spoken", { promptSource: "typed" }),
      asst("a1", "2026-06-21T15:00:02.000Z", text("voice reply")),
      user("u2", "2026-06-21T15:00:03.000Z", "typed q", { promptSource: "queued" }),
      asst("a2", "2026-06-21T15:00:04.000Z", text("typed reply"))
    ]);
    const pairs = pairReplies(turns);
    expect(pairs.map((p) => [p.prompt?.text, p.reply.uuid])).toEqual([
      ["spoken", "a1"],
      ["typed q", "a2"]
    ]);
  });

  it("returns no pairs when there is no reply yet", () => {
    const turns = projectTurns([user("u1", "2026-06-21T15:00:01.000Z", "hi", { promptSource: "typed" })]);
    expect(pairReplies(turns)).toEqual([]);
  });
});

describe("resolveVoiceReply — pick the FINAL reply to speak by identity, never an interim step", () => {
  const turn = (uuid: string, role: ProjectedTurn["role"], ts: number, interim = false): ProjectedTurn => ({
    uuid,
    timestamp: ts,
    role,
    text: `${uuid}-text`,
    interim
  });

  it("returns the final reply paired to our prompt uuid, not the interim steps before it", () => {
    const turns = [
      turn("u", "user", 1),
      turn("s1", "claude", 2, true),
      turn("s2", "claude", 3, true),
      turn("final", "claude", 4)
    ];
    expect(resolveVoiceReply(turns, "u")?.uuid).toBe("final");
  });

  it("returns undefined while only interim steps have flushed — so the caller keeps waiting for the answer", () => {
    // THE REGRESSION: the Stop hook can fire (or be polled) before the answer text lands; the old fallback
    // grabbed the first step here and spoke/consumed it, so the real answer was never spoken (no audio).
    const turns = [turn("u", "user", 1), turn("s1", "claude", 2, true), turn("s2", "claude", 3, true)];
    expect(resolveVoiceReply(turns, "u")).toBeUndefined();
  });

  it("matches by IDENTITY, not order: with two prompts + replies, each uuid resolves to its own reply", () => {
    const turns = [turn("u1", "user", 1), turn("a1", "claude", 2), turn("u2", "user", 3), turn("a2", "claude", 4)];
    expect(resolveVoiceReply(turns, "u1")?.uuid).toBe("a1");
    expect(resolveVoiceReply(turns, "u2")?.uuid).toBe("a2");
  });

  it("returns undefined when the prompt uuid isn't anchored yet", () => {
    expect(resolveVoiceReply([turn("final", "claude", 4)], undefined)).toBeUndefined();
  });
});

describe("dropSessionAnnouncement — hide the start-skill QR/URL reply", () => {
  const SESSION_URL = "https://voice-control.nee.rs/s/SnSV7GD38MgW9TT1vsUV0Q";
  const turn = (uuid: string, role: ProjectedTurn["role"], text: string): ProjectedTurn => ({
    uuid,
    timestamp: 0,
    role,
    text,
    interim: false
  });

  it("drops the claude reply that embeds our own session URL, keeping everything else", () => {
    const turns = [
      turn("u1", "user", "howdy"),
      turn(
        "a1",
        "claude",
        `The voice remote is live. Scan this:\n\`\`\`\n[QR]\n\`\`\`\nTap/copy fallback: ${SESSION_URL}`
      ),
      turn("u2", "user", "do the thing"),
      turn("a2", "claude", "On it.")
    ];
    expect(dropSessionAnnouncement(turns, SESSION_URL).map((t) => t.uuid)).toEqual(["u1", "u2", "a2"]);
  });

  it("never touches a real message that doesn't contain the URL (even reworded announcement copy needs it)", () => {
    const turns = [turn("a1", "claude", "The walkie-talkie is live — scan the QR above.")];
    expect(dropSessionAnnouncement(turns, SESSION_URL)).toEqual(turns);
  });

  it("never drops a user turn even if it quotes the URL", () => {
    const turns = [turn("u1", "user", `open ${SESSION_URL}`)];
    expect(dropSessionAnnouncement(turns, SESSION_URL)).toEqual(turns);
  });

  it("is a no-op without a session URL", () => {
    const turns = [turn("a1", "claude", "anything")];
    expect(dropSessionAnnouncement(turns, "")).toEqual(turns);
  });
});
