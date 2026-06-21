// Read Claude Code's transcript JSONL from disk for the daemon to project (see transcript-projection.ts).
// The hooks hand the daemon a `transcript_path`; the daemon owns the reading + the flush-race wait so the
// hooks stay trivial. Only the file tail is read — the transcript grows to many MB over a session and the
// finished turn always lives at the end.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { type ProjectedTurn, projectTurns, type TranscriptRecord } from "./transcript-projection.js";

const TAIL_BYTES = 512 * 1024;

/** Parse the JSONL records from the tail of the transcript (the newest turns live there). */
export function readTailRecords(path: string): TranscriptRecord[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
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

/** Project the transcript tail at `path` into conversational turns. The daemon polls this on a turn close
 *  (waiting for the reply to flush — see voice-daemon's handleTurnClose) and reads it on every event. */
export function projectTranscript(path: string, maxTurns?: number): ProjectedTurn[] {
  return projectTurns(readTailRecords(path), maxTurns);
}
