#!/usr/bin/env node
/**
 * Stop hook for the voice remote.
 *
 * Fires when the interactive Claude Code session finishes a turn. It reads the turn's FINAL
 * assistant reply from the transcript and POSTs it to this pane's daemon at /turn-close. The daemon
 * pairs it with the turn it opened (from the UserPromptSubmit hook) and speaks / mirrors / ignores
 * accordingly — so this hook does NOT try to figure out what the user said (the transcript buries
 * the real prompt under command markers and SKILL.md bodies; UserPromptSubmit carries it instead).
 * If the daemon isn't running, this is a no-op. It never blocks the Stop event.
 */
import { readFileSync, watch } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-thread runtime file: runtime/<surfaceId>.json (matches config.ts#threadRuntimePath). This hook
// runs in the pane that finished a turn, so $CMUX_SURFACE_ID identifies its own daemon; "default"
// mirrors the daemon's fallback when launched outside cmux.
const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "cc-voice-control");
const SURFACE_ID = process.env.CMUX_SURFACE_ID || "default";
const RUNTIME_PATH = join(STATE_DIR, "runtime", `${SURFACE_ID}.json`);

main().catch(() => process.exit(0));

async function main() {
  const payload = await readStdin();
  let hook;
  try {
    hook = JSON.parse(payload || "{}");
  } catch {
    process.exit(0);
  }

  const runtime = readRuntime();
  if (!runtime?.port) process.exit(0); // daemon not running

  const reply = await resolveReply(hook.transcript_path);
  if (!reply) process.exit(0);

  await post(runtime.port, { reply: reply.text, replyUuid: reply.uuid }).catch(() => {});
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function readRuntime() {
  try {
    return JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Resolve the turn's final assistant reply. The Stop hook can fire before Claude has flushed the
 * final message to the transcript JSONL, so we read once and, if it isn't there yet, wait for the
 * file to change (fs.watch — event-driven, no polling) and re-read. The turn is done once the newest
 * assistant message carries a terminal stop_reason (not a tool_use pause). Backstop: the hook timeout.
 */
function resolveReply(transcriptPath) {
  if (!transcriptPath) return Promise.resolve(undefined);

  const read = () => readReply(transcriptPath);
  const first = read();
  if (first.final) return Promise.resolve({ text: first.text, uuid: first.uuid });

  return new Promise((resolve) => {
    let watcher;
    let settled = false;
    const finish = (reply) => {
      if (settled) return;
      settled = true;
      if (watcher) watcher.close();
      resolve(reply);
    };
    try {
      watcher = watch(transcriptPath, () => {
        const r = read();
        if (r.final) finish({ text: r.text, uuid: r.uuid });
      });
      watcher.on("error", () => finish(undefined));
    } catch {
      finish(undefined);
    }
  });
}

function readReply(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return { final: false };
  }
  const records = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // Scan from the end for the newest assistant message. The turn is finished once it carries a
  // terminal stop_reason; a tool_use pause means the final reply hasn't been written yet.
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const message = record.message || record;
    const role = message.role || record.type;
    if (role !== "assistant") continue;
    const stop = message.stop_reason;
    if (stop && stop !== "tool_use") {
      return { final: true, text: extractText(message.content), uuid: record.uuid || message.id || "" };
    }
    return { final: false }; // newest assistant message is a tool pause → not done yet
  }
  return { final: false };
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

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/turn-close",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length }
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
