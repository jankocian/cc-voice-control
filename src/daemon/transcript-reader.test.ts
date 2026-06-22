import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRecords, TAIL_BYTES } from "./transcript-reader.js";

// The point of the floor offset: the CURRENT turn is always read in full, even when it writes more than the
// display tail between the prompt and its answer — a huge thinking block, an hour of tool output. "Answer
// always at EOF" guarantees the answer is read; the floor guarantees the prompt is.
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

describe("readRecords — floor offset reads the whole turn, tail is a display window", () => {
  let dir: string;
  let path: string;
  let promptOffset: number; // byte position where the prompt record begins

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reader-test-"));
    path = join(dir, "t.jsonl");
    // [prior turn] [PROMPT] [more-than-a-tail of tool output] [ANSWER]: the prompt is pushed past the tail.
    const prior = userRec("PRIOR", "an earlier turn");
    promptOffset = Buffer.byteLength(prior);
    writeFileSync(
      path,
      prior + userRec("PROMPT", "do a huge thing") + fillerRec("FILL", TAIL_BYTES + 100_000) + answerRec("ANSWER")
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("tail read drops a prompt that's beyond TAIL_BYTES (but always keeps the answer at EOF)", () => {
    const uuids = readRecords(path).records.map((r) => r.uuid);
    expect(uuids).not.toContain("PROMPT"); // scrolled out of the display tail
    expect(uuids).toContain("ANSWER"); // last record → always read
  });

  it("reading from the turn's floor offset includes the prompt, however large the turn", () => {
    const uuids = readRecords(path, promptOffset).records.map((r) => r.uuid);
    expect(uuids).toContain("PROMPT"); // the floor is what makes the identity match deterministic
    expect(uuids).toContain("ANSWER");
  });

  it("does not drop the prompt even though the floor sits exactly on its record boundary", () => {
    // Regression for the off-by-one: lines.shift() must drop the boundary newline, not the prompt itself.
    const first = readRecords(path, promptOffset).records[0];
    expect(first?.uuid).toBe("PROMPT");
  });

  it("reports the file's eof so the daemon can capture the next turn's floor", () => {
    expect(readRecords(path).eof).toBe(statSync(path).size);
  });
});
