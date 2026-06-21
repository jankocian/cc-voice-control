#!/usr/bin/env node
/**
 * Stop hook for the voice remote.
 *
 * Fires when the interactive Claude Code session finishes a turn. Reads the turn's FINAL assistant
 * reply AND the user prompt it answered (linked via `parentUuid` in the transcript) and POSTs both to
 * this pane's daemon at /turn-close. The daemon pairs the reply to its turn BY THAT PROMPT — identity,
 * not FIFO position — so a single lost turn can never shift the conversation onto the wrong reply.
 * No-op if the daemon isn't running. Never blocks the Stop event for longer than RESOLVE_TIMEOUT_MS.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { postDaemon, readDaemonRuntime, readStdin } from "./lib/daemon-client.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The finished turn's records are at the END of the transcript, which can grow to many MB over a
// session — read only the tail rather than re-parsing the whole file on every poll.
const TAIL_BYTES = 512 * 1024;
const RESOLVE_TIMEOUT_MS = 12_000;
const POLL_MS = 150;

main().catch(() => process.exit(0));

async function main() {
  const payload = await readStdin();
  let hook;
  try {
    hook = JSON.parse(payload || "{}");
  } catch {
    process.exit(0);
  }

  const runtime = readDaemonRuntime();
  if (!runtime?.port) process.exit(0); // daemon not running

  const turn = await resolveTurn(hook.transcript_path);
  if (!turn) process.exit(0);

  await postDaemon(runtime.port, "/turn-close", {
    prompt: turn.prompt,
    reply: turn.text,
    replyUuid: turn.uuid
  }).catch(() => {});
  process.exit(0);
}

/**
 * Resolve the finished turn (its reply + the prompt it answered). The Stop hook can fire before Claude
 * has flushed the final message, so we POLL the transcript until the newest assistant message carries a
 * terminal stop_reason — robust where fs.watch silently drops or races the write (the bug that lost
 * replies). Backstop: a hard timeout so the hook never hangs the Stop event.
 */
async function resolveTurn(transcriptPath) {
  if (!transcriptPath) return undefined;
  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
  for (;;) {
    const turn = readTurn(transcriptPath);
    if (turn.final) return turn;
    if (Date.now() >= deadline) return undefined;
    await sleep(POLL_MS);
  }
}

// Parse the JSONL records from the tail of the transcript (newest turn lives there).
function readTailRecords(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // drop the partial first line when we began mid-file
    return lines
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
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

function readTurn(transcriptPath) {
  const records = readTailRecords(transcriptPath);
  if (records.length === 0) return { final: false };

  // The newest assistant record. If it's a tool_use pause (no terminal stop_reason), the final reply
  // hasn't been written yet → not done.
  let replyIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    const m = records[i].message || records[i];
    if ((m.role || records[i].type) === "assistant") {
      replyIdx = i;
      break;
    }
  }
  if (replyIdx < 0) return { final: false };
  const replyMsg = records[replyIdx].message || records[replyIdx];
  const stop = replyMsg.stop_reason;
  if (!stop || stop === "tool_use") return { final: false };

  // The reply is the newest terminal assistant. If it's thinking-only (no text), step back to the
  // nearest preceding assistant in this turn that actually has text.
  let text = extractText(replyMsg.content);
  let uuid = records[replyIdx].uuid || replyMsg.id || "";
  if (!text) {
    for (let i = replyIdx - 1; i >= 0; i--) {
      const m = records[i].message || records[i];
      const role = m.role || records[i].type;
      if (role === "user") break; // previous turn boundary
      if (role !== "assistant") continue;
      const t = extractText(m.content);
      if (t) {
        text = t;
        uuid = records[i].uuid || m.id || "";
        break;
      }
    }
  }

  return { final: true, text, uuid, prompt: promptFor(records, records[replyIdx]) };
}

// The user prompt this reply answered: follow parentUuid from the reply back to the nearest user
// record. For a typed/voice turn that's the real text (= the open turn's prompt, so the daemon matches
// it by identity); for a slash-command turn it may be synthetic, but the daemon classifies plugin
// turns from /turn-open and ignores them regardless. Empty if the link runs off the read tail.
function promptFor(records, replyRecord) {
  const byUuid = new Map();
  for (const r of records) if (r.uuid) byUuid.set(r.uuid, r);
  let cur = replyRecord;
  for (let hops = 0; cur && hops < 50; hops++) {
    const m = cur.message || cur;
    if ((m.role || cur.type) === "user") {
      const t = extractText(m.content);
      if (t) return t;
    }
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : undefined;
  }
  return "";
}

function extractText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}
