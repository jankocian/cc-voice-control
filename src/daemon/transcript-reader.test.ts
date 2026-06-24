import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRecords, TAIL_BYTES } from "./transcript-reader.js";

// We read the last TAIL_BYTES — the phone's display window. The answer is the file's last record so it is
// always read; older records beyond the tail scroll out (a display bound, not a correctness one).
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const userRec = (uuid: string, text: string) =>
  line({
    type: "user",
    uuid,
    timestamp: "2026-06-22T13:50:00.000Z",
    promptSource: "typed",
    message: { role: "user", content: text }
  });
const fillerRec = (uuid: string, bytes: number) =>
  line({
    type: "user",
    uuid,
    timestamp: "2026-06-22T13:51:00.000Z",
    message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(bytes) }] }
  });
const answerRec = (uuid: string) =>
  line({
    type: "assistant",
    uuid,
    timestamp: "2026-06-22T13:55:00.000Z",
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }
  });

describe("readRecords — last-TAIL_BYTES window, answer always at EOF", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reader-test-"));
    path = join(dir, "t.jsonl");
    // [PROMPT] [more-than-a-tail of tool output] [ANSWER]: the prompt is pushed past the tail.
    writeFileSync(
      path,
      userRec("PROMPT", "do a huge thing") + fillerRec("FILL", TAIL_BYTES + 100_000) + answerRec("ANSWER")
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the answer at EOF but drops records that scrolled past the tail", () => {
    const uuids = readRecords(path).map((r) => r.uuid);
    expect(uuids).not.toContain("PROMPT"); // scrolled out of the display tail
    expect(uuids).toContain("ANSWER"); // last record → always read
  });

  it("drops the partial first line when it begins mid-file (no torn record)", () => {
    // The tail starts inside the giant FILL record, so the first line read is a fragment and must be
    // dropped — never surfaced as a torn/garbage record.
    const records = readRecords(path);
    expect(records.every((r) => typeof r.uuid === "string")).toBe(true);
    expect(records[0]?.uuid).toBe("ANSWER");
  });

  it("returns [] for a missing file", () => {
    expect(readRecords(join(dir, "nope.jsonl"))).toEqual([]);
  });
});
