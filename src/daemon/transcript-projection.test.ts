import { describe, expect, it } from "vitest";
import {
  dropSessionAnnouncement,
  isPaneWorking,
  type ProjectedTurn,
  pendingQuestion,
  projectTurns,
  questionSpeech,
  selectActiveBranch,
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

describe("selectActiveBranch — drop dead branches so the phone matches the desktop", () => {
  it("drops a superseded sibling user turn (the real 18s-apart glued-prompt incident: transcript 02104852)", () => {
    // Two voice utterances injected 18s apart; Claude Code merged them: the transcript holds TWO sibling
    // user rows under the same parent — an orphan "A" (no answer) and the consumed, glued "A.B" — and
    // Claude answered only A.B. A flat replay shows 3 messages; the desktop shows 1. We must show 1.
    const records: TranscriptRecord[] = [
      user("uprev", "2026-06-22T23:00:00.000Z", "previous q", { promptSource: "typed", parentUuid: "root0" }),
      asst("P", "2026-06-22T23:01:00.000Z", text("previous answer"), "end_turn", { parentUuid: "uprev" }), // shared parent of A/AB
      user("A", "2026-06-22T23:03:57.000Z", "Я вот смышто это к ничему.", { promptSource: "typed", parentUuid: "P" }),
      user("AB", "2026-06-22T23:04:15.000Z", "Я вот смышто это к ничему.Mluvím česky, ty vole.", {
        promptSource: "typed",
        parentUuid: "P"
      }),
      asst("R", "2026-06-22T23:04:33.000Z", text("Smazáno."), "end_turn", { parentUuid: "AB" })
    ];
    const turns = projectTurns(records);
    expect(turns.map((t) => t.uuid)).toEqual(["uprev", "P", "AB", "R"]); // orphan A is gone
    expect(turns.filter((t) => t.role === "user").map((t) => t.text)).toEqual([
      "previous q",
      "Я вот смышто это к ничему.Mluvím česky, ty vole." // the glued turn, once — never the orphan A alone
    ]);
  });

  it("leaves a normal linear conversation untouched (every record on the active path)", () => {
    const records: TranscriptRecord[] = [
      user("u1", "2026-06-21T15:00:01.000Z", "hi", { promptSource: "typed" }),
      asst("a1", "2026-06-21T15:00:02.000Z", text("hello"), "end_turn", { parentUuid: "u1" }),
      user("u2", "2026-06-21T15:00:03.000Z", "more", { promptSource: "typed", parentUuid: "a1" }),
      asst("a2", "2026-06-21T15:00:04.000Z", text("ok"), "end_turn", { parentUuid: "u2" })
    ];
    expect(selectActiveBranch(records).map((r) => r.uuid)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("drops a dead SUBTREE: a superseded turn AND its descendant reply", () => {
    const records: TranscriptRecord[] = [
      asst("P", "2026-06-22T23:01:00.000Z", text("parent")),
      user("A", "2026-06-22T23:02:00.000Z", "dead branch", { promptSource: "typed", parentUuid: "P" }),
      asst("A1", "2026-06-22T23:02:30.000Z", text("answer on the dead branch"), "end_turn", { parentUuid: "A" }),
      user("AB", "2026-06-22T23:03:00.000Z", "live branch", { promptSource: "typed", parentUuid: "P" }),
      asst("R", "2026-06-22T23:03:30.000Z", text("answer on the live branch"), "end_turn", { parentUuid: "AB" })
    ];
    expect(selectActiveBranch(records).map((r) => r.uuid)).toEqual(["P", "AB", "R"]); // A and A1 both gone
  });

  it("drops a dead sibling that shares an out-of-window parent with the active path", () => {
    // The orphan + its glued sibling both stay in the tail while their common parent scrolls out. The
    // orphan still shares that (now out-of-window) parent with the on-path sibling, so it's recognised as
    // superseded and dropped — the incident can't re-materialize once the window slides.
    const records: TranscriptRecord[] = [
      user("orphan", "2026-06-21T15:00:00.000Z", "dead sibling", { promptSource: "typed", parentUuid: "GONE" }),
      user("u1", "2026-06-21T15:00:01.000Z", "live sibling", { promptSource: "typed", parentUuid: "GONE" }),
      asst("a1", "2026-06-21T15:00:02.000Z", text("hello"), "end_turn", { parentUuid: "u1" })
    ];
    expect(selectActiveBranch(records).map((r) => r.uuid)).toEqual(["u1", "a1"]); // orphan gone
  });

  it("drops an off-path SECOND ROOT (null parent) so the active branch has a unique root-level turn", () => {
    // Two root-level (no parent) user records: an orphan and the survivor that took the path. The orphan
    // must drop — else two root-level turns survive and the reply re-bind's sibling-uniqueness breaks.
    const records: TranscriptRecord[] = [
      user("Aroot", "2026-06-22T23:00:00.000Z", "yes", { promptSource: "typed" }), // root orphan, no parent
      user("Sroot", "2026-06-22T23:00:05.000Z", "yes please go", { promptSource: "typed" }), // root survivor
      asst("R", "2026-06-22T23:00:10.000Z", text("done"), "end_turn", { parentUuid: "Sroot" })
    ];
    expect(selectActiveBranch(records).map((r) => r.uuid)).toEqual(["Sroot", "R"]); // orphan root gone
  });

  it("keeps an off-path record whose parent is unknown and unshared (conservative: can't prove it dead)", () => {
    // A windowed read may begin mid-branch on a record rooted above the window with no on-path sibling —
    // hiding real history would be worse than a rare, desktop-divergent stale row, so it is kept.
    const records: TranscriptRecord[] = [
      user("disconnected", "2026-06-21T15:00:00.000Z", "rooted above the window", {
        promptSource: "typed",
        parentUuid: "UNRELATED"
      }),
      user("u1", "2026-06-21T15:00:01.000Z", "hi", { promptSource: "typed", parentUuid: "GONE" }),
      asst("a1", "2026-06-21T15:00:02.000Z", text("hello"), "end_turn", { parentUuid: "u1" })
    ];
    expect(selectActiveBranch(records).map((r) => r.uuid)).toEqual(["disconnected", "u1", "a1"]);
  });

  it("is a no-op when records carry no parentUuid (flat fixtures behave exactly as before)", () => {
    const records: TranscriptRecord[] = [
      user("u1", "2026-06-21T15:00:01.000Z", "a", { promptSource: "typed" }),
      asst("a1", "2026-06-21T15:00:02.000Z", text("b"))
    ];
    expect(selectActiveBranch(records)).toBe(records); // same reference: nothing to drop
  });
});

describe("isPaneWorking — working lamp derived from the transcript, never counted", () => {
  const turn = (uuid: string, role: ProjectedTurn["role"], interim = false): ProjectedTurn => ({
    uuid,
    timestamp: 0,
    role,
    text: `${uuid}-text`,
    interim
  });

  it("idle when the newest user turn has its final reply", () => {
    expect(isPaneWorking([turn("u", "user"), turn("a", "claude")])).toBe(false);
  });

  it("working when the newest user turn has no reply yet", () => {
    expect(isPaneWorking([turn("u1", "user"), turn("a1", "claude"), turn("u2", "user")])).toBe(true);
  });

  it("working when only interim steps have flushed (a turn mid-tool-call is still answering)", () => {
    expect(isPaneWorking([turn("u", "user"), turn("s1", "claude", true), turn("s2", "claude", true)])).toBe(true);
  });

  it("self-heals the merged-prompt case: an answered glued turn reads idle however the hooks fired", () => {
    // The transcript after selectActiveBranch: the orphan is gone, the glued turn is answered → idle. The
    // lamp is right regardless of the two-opens/one-close hook imbalance that stuck the old counter.
    expect(isPaneWorking([turn("AB", "user"), turn("R", "claude")])).toBe(false);
  });

  it("idle with no user turn at all", () => {
    expect(isPaneWorking([turn("a", "claude")])).toBe(false);
    expect(isPaneWorking([])).toBe(false);
  });
});

describe("pendingQuestion — Claude is blocked on the user (awaiting), derived from the transcript", () => {
  const turn = (uuid: string, role: ProjectedTurn["role"], interim = false): ProjectedTurn => ({
    uuid,
    timestamp: 0,
    role,
    text: `${uuid}-text`,
    interim
  });
  const question = (uuid: string, answered: boolean): ProjectedTurn => ({
    ...turn(uuid, "claude"),
    question: { toolUseId: `tu-${uuid}`, questions: [{ question: "Pick one?", options: [{ label: "A" }] }], answered }
  });

  it("awaiting when the newest content turn is an unanswered question", () => {
    expect(pendingQuestion([turn("u", "user"), question("q", false)])).toBe(true);
  });

  it("not awaiting once the question is answered (Claude is now concluding → working, not awaiting)", () => {
    expect(pendingQuestion([turn("u", "user"), question("q", true)])).toBe(false);
  });

  it("not awaiting when a real reply is the newest content turn", () => {
    expect(pendingQuestion([turn("u", "user"), turn("a", "claude")])).toBe(false);
  });

  it("skips interim steps to find the unanswered question (still awaiting)", () => {
    // The scan ignores interim turns, so the newest NON-interim claude turn — the open question — still wins.
    expect(pendingQuestion([turn("u", "user"), question("q", false), turn("s", "claude", true)])).toBe(true);
  });

  it("not awaiting with no claude turn at all", () => {
    expect(pendingQuestion([turn("u", "user")])).toBe(false);
    expect(pendingQuestion([])).toBe(false);
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

describe("projectTurns — interactive AskUserQuestion", () => {
  const askRec = (uuid: string, ts: string, toolUseId: string, questions: unknown): TranscriptRecord =>
    asst(uuid, ts, [{ type: "tool_use", id: toolUseId, name: "AskUserQuestion", input: { questions } }], "tool_use");
  const answerRec = (uuid: string, ts: string, toolUseId: string): TranscriptRecord =>
    user(uuid, ts, [{ type: "tool_result", tool_use_id: toolUseId, content: "answered" }], { promptSource: "typed" });
  const Q = [
    {
      question: "Which audio strategy?",
      header: "Audio",
      multiSelect: false,
      options: [{ label: "Mixing", description: "over music" }, { label: "Pause" }]
    }
  ];

  it("projects an AskUserQuestion tool call into an unanswered question turn (card, not a bubble)", () => {
    const turns = projectTurns([askRec("q1", "2026-06-21T15:00:00.000Z", "tu_1", Q)]);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("claude");
    expect(turns[0].interim).toBe(false);
    expect(turns[0].question).toEqual({
      toolUseId: "tu_1",
      answered: false,
      questions: [
        {
          question: "Which audio strategy?",
          header: "Audio",
          multiSelect: false,
          options: [{ label: "Mixing", description: "over music" }, { label: "Pause" }]
        }
      ]
    });
    expect(turns[0].text).toContain("Which audio strategy?"); // spoken rendering present for TTS
  });

  it("marks the question answered once its tool_result lands", () => {
    const turns = projectTurns([
      askRec("q1", "2026-06-21T15:00:00.000Z", "tu_1", Q),
      answerRec("r1", "2026-06-21T15:00:30.000Z", "tu_1")
    ]);
    expect(turns).toHaveLength(1); // the tool_result itself is not a conversational turn
    expect(turns[0].question?.answered).toBe(true);
  });

  it("a question does NOT end the working state — the pane stays working until the real conclusion lands", () => {
    const paused = projectTurns([
      user("u1", "2026-06-21T15:00:00.000Z", "which one?", { promptSource: "typed" }),
      askRec("q1", "2026-06-21T15:00:05.000Z", "tu_1", Q)
    ]);
    expect(isPaneWorking(paused)).toBe(true); // a question is not the answer → still working (poll keeps going)

    const concluded = projectTurns([
      user("u1", "2026-06-21T15:00:00.000Z", "which one?", { promptSource: "typed" }),
      askRec("q1", "2026-06-21T15:00:05.000Z", "tu_1", Q),
      answerRec("r1", "2026-06-21T15:00:30.000Z", "tu_1"),
      asst("a1", "2026-06-21T15:01:00.000Z", text("Done — went with mixing."))
    ]);
    expect(isPaneWorking(concluded)).toBe(false); // the conclusion is the final reply → idle
  });

  it("contains a malformed question record instead of breaking the projection", () => {
    const turns = projectTurns([
      user("u1", "2026-06-21T15:00:00.000Z", "hi", { promptSource: "typed" }),
      // tool_use present but input.questions missing → not a valid question; record carries no text either.
      asst(
        "bad",
        "2026-06-21T15:00:05.000Z",
        [{ type: "tool_use", id: "x", name: "AskUserQuestion", input: {} }],
        "tool_use"
      ),
      asst("a1", "2026-06-21T15:00:10.000Z", text("Still here."))
    ]);
    expect(turns.map((t) => t.uuid)).toEqual(["u1", "a1"]); // broken record skipped, conversation intact
    expect(turns.some((t) => t.question)).toBe(false);
  });

  it("questionSpeech letters the options and omits Claude Code's appended rows", () => {
    const spoken = questionSpeech(Q);
    expect(spoken).toContain("A: Mixing");
    expect(spoken).toContain("B: Pause");
    expect(spoken).not.toContain("Type something");
  });
});
