// Read Claude Code's transcript JSONL for the daemon to project (see transcript-projection.ts). The hooks
// hand the daemon a `transcript_path`; the daemon owns the reading + the flush wait so the hooks stay
// trivial. We never read the whole file — it grows to many MB over a long session — only the last
// TAIL_BYTES: the phone's scrollback budget (it shows the newest MAX_PROJECTED_TURNS of whatever lands in
// here). The reply is matched by native-uuid identity off the live transcript tail, and the answer is the
// file's last record, so it's always read — the tail is a pure DISPLAY window, never a correctness boundary,
// and the read is bounded by it (not the file size) so it scales to arbitrarily long chats.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { type ProjectedTurn, projectTurns, type TranscriptRecord } from "./transcript-projection.js";

// How far back we read: the phone's scrollback budget and the read-cost guard. Exported so tests can
// overflow it by construction.
export const TAIL_BYTES = 512 * 1024;

/** Parse the JSONL records in the last TAIL_BYTES of the transcript. When we begin mid-file the first line
 *  is a partial record and is dropped; any line torn mid-flush is skipped. */
export function readRecords(path: string): TranscriptRecord[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const eof = fstatSync(fd).size;
    const start = Math.max(0, eof - TAIL_BYTES);
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
    return records;
  } catch {
    return [];
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
  }
}

/** Project the transcript at `path` into conversational turns. The daemon polls this on a turn close
 *  (waiting for the reply to flush — see voice-daemon's handleTurnClose) and reads it on every event. */
export function projectTranscript(path: string, maxTurns?: number): ProjectedTurn[] {
  return projectTurns(readRecords(path), maxTurns);
}
