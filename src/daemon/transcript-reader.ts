// Read Claude Code's transcript JSONL for the daemon to project (see transcript-projection.ts). The hooks
// hand the daemon a `transcript_path`; the daemon owns the reading + the flush wait so the hooks stay
// trivial. We never read the whole file — it grows to many MB over a long session.
//
// By default we read the last TAIL_BYTES (the recent turns shown on the phone). When the daemon passes
// `floorOffset` — the byte position it recorded at the START of the current turn — we read from there
// instead whenever that's further back, so the CURRENT turn is ALWAYS read in full however large it grew (a
// huge thinking block, an hour of tool output). That's what makes the reply match deterministic: the
// prompt record is always present, so it's an exact identity match, never an ordering guess. TAIL_BYTES is
// then a pure DISPLAY knob (how much history the phone shows), never a correctness boundary. Either way the
// read is bounded by the turn span or the tail — not the file size — so it scales to arbitrarily long chats.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { type ProjectedTurn, projectTurns, type TranscriptRecord } from "./transcript-projection.js";

// How far back we read by default: the phone's scrollback budget (it shows the newest MAX_PROJECTED_TURNS
// of whatever lands in here) and the read-cost guard when no turn is anchoring the read. NOT a correctness
// boundary — a turn larger than this is still read in full via floorOffset. Exported so tests overflow it
// by construction.
export const TAIL_BYTES = 512 * 1024;

export type TranscriptRead = { records: TranscriptRecord[]; eof: number };

/** Parse the JSONL records the daemon needs, plus the file's current size (`eof`). Reads from `floorOffset`
 *  if given and it's further back than the tail (so the turn that began there is read whole), else the last
 *  TAIL_BYTES. `eof` lets the daemon remember where the file ends — the read floor it captures next turn. */
export function readRecords(path: string, floorOffset?: number): TranscriptRead {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const eof = fstatSync(fd).size;
    const tailStart = Math.max(0, eof - TAIL_BYTES);
    // Read from whichever is earlier — the turn's floor or the tail — so we never lose the current turn,
    // and never read less than the tail's worth of recent context. A `floorOffset` sits exactly on a record
    // boundary (the byte just before the prompt), and we drop the first line below as a presumed partial —
    // so back up one byte: the dropped "line" becomes the previous record's trailing newline, leaving the
    // prompt itself intact.
    const floorStart = floorOffset === undefined ? undefined : Math.max(0, floorOffset - 1);
    const start = floorStart === undefined ? tailStart : Math.min(tailStart, floorStart);
    const buf = Buffer.alloc(eof - start);
    const bytesRead = readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8", 0, bytesRead).split("\n");
    if (start > 0) lines.shift(); // drop the partial first line when we began mid-file
    const records: TranscriptRecord[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as TranscriptRecord);
      } catch {
        // skip a partial line written mid-flush
      }
    }
    return { records, eof };
  } catch {
    return { records: [], eof: 0 };
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
  }
}

/** Project the transcript at `path` into conversational turns, returning the file's `eof` alongside. The
 *  daemon polls this on a turn close (waiting for the reply to flush — see voice-daemon's handleTurnClose),
 *  reads it on every event, and passes `floorOffset` so the open turn is always read in full. */
export function projectTranscript(
  path: string,
  maxTurns?: number,
  floorOffset?: number
): { turns: ProjectedTurn[]; eof: number } {
  const { records, eof } = readRecords(path, floorOffset);
  return { turns: projectTurns(records, maxTurns), eof };
}
