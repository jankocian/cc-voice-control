#!/usr/bin/env node
/**
 * Stop hook for the voice remote.
 *
 * Fires when the interactive Claude Code session finishes a turn. It reads, from the
 * transcript, the user prompt that started the turn and the turn's FINAL assistant
 * reply, then POSTs both to the local voice daemon. The daemon speaks the reply only
 * if the prompt matches the turn it injected, so terminal-typed turns aren't read
 * aloud. If the daemon isn't running, this is a no-op. It never blocks the Stop event.
 */
import { readFileSync, watch } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Plugin runtime state lives in Claude Code's managed per-plugin data dir
// ($CLAUDE_PLUGIN_DATA, exported to hook processes), never in the user's ~/.config.
// Falls back to a temp dir if the variable is somehow unset.
const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "cc-voice-control");
const RUNTIME_PATH = join(STATE_DIR, "runtime.json");

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

  const turn = await resolveTurn(hook.transcript_path);
  if (!turn) process.exit(0);

  await post(runtime.port, { prompt: turn.prompt, text: turn.text, sessionId: hook.session_id || "" }).catch(() => {});
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
 * Resolve the finished turn: its user prompt and the final assistant reply.
 *
 * The Stop hook can fire before Claude has flushed the final assistant message to the
 * transcript JSONL, so we read once and, if the final message isn't there yet, wait for
 * the file to change (fs.watch — event-driven, no polling) and re-read. A turn ends with
 * a terminal assistant message (stop_reason ≠ "tool_use"), so this resolves as soon as
 * that write lands. The ultimate backstop is Claude Code's own hook timeout.
 */
function resolveTurn(transcriptPath) {
  if (!transcriptPath) return Promise.resolve(undefined);

  const read = () => readTurn(transcriptPath);
  const first = read();
  if (first.final) return Promise.resolve({ prompt: first.prompt, text: first.text });

  return new Promise((resolve) => {
    let watcher;
    let settled = false;
    const finish = (turn) => {
      if (settled) return;
      settled = true;
      if (watcher) watcher.close();
      resolve(turn);
    };
    try {
      watcher = watch(transcriptPath, () => {
        const r = read();
        if (r.final) finish({ prompt: r.prompt, text: r.text });
      });
      // If watching fails mid-flight, fall back to whatever we last read.
      watcher.on("error", () => finish(first.prompt ? { prompt: first.prompt, text: first.text } : undefined));
    } catch {
      finish(first.prompt ? { prompt: first.prompt, text: first.text } : undefined);
    }
  });
}

function readTurn(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return { final: false, prompt: "", text: "" };
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

  let lastUser = -1;
  for (let i = 0; i < records.length; i++) if (isUserPrompt(records[i])) lastUser = i;
  const prompt = lastUser >= 0 ? messageText(records[lastUser]) : "";

  // Scan back from the end (after the most recent real user prompt) for the assistant
  // message that ended the turn: a terminal stop_reason, not a tool_use pause.
  for (let i = records.length - 1; i > lastUser; i--) {
    const message = records[i].message || records[i];
    const role = message.role || records[i].type;
    if (role !== "assistant") continue;
    const stop = message.stop_reason;
    if (stop && stop !== "tool_use") return { final: true, prompt, text: extractText(message.content) };
  }
  return { final: false, prompt, text: "" };
}

// A real user turn (the injected prompt) — not a tool_result, which also has role "user".
function isUserPrompt(record) {
  const message = record.message || record;
  const role = message.role || record.type;
  if (role !== "user") return false;
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.some((b) => b && b.type === "text");
  return false;
}

function messageText(record) {
  const message = record.message || record;
  return extractText(message.content);
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
        path: "/reply",
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
