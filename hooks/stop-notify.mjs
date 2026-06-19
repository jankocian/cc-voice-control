#!/usr/bin/env node
/**
 * Stop hook for the voice remote.
 *
 * Fires when the interactive Claude Code session finishes a turn. It reads the
 * last assistant message from the transcript and POSTs it to the local voice
 * daemon, which speaks it back on the phone. If the daemon isn't running, this
 * is a no-op. It never blocks the Stop event.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

// Plugin runtime state lives in Claude Code's managed per-plugin data dir
// ($CLAUDE_PLUGIN_DATA, exported to hook processes), never in the user's
// ~/.config. Falls back to a temp dir if the variable is somehow unset.
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
  if (!runtime || !runtime.port) process.exit(0); // daemon not running

  const text = await resolveReplyText(hook.transcript_path);
  if (!text) process.exit(0);

  await post(runtime.port, { text, sessionId: hook.session_id || "" }).catch(() => {});
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    setTimeout(() => resolve(data), 1500);
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
 * Return the FINAL assistant reply for the turn that just finished.
 *
 * Two problems this handles:
 *  1. Flush lag — the Stop hook can fire before Claude has flushed the latest
 *     message to the transcript JSONL, so we poll.
 *  2. Intermediary messages — a turn that uses tools emits several assistant
 *     text blocks (narration between tool calls). Those carry
 *     `stop_reason: "tool_use"`; only the real final answer carries a terminal
 *     stop_reason (`end_turn`, `max_tokens`, `stop_sequence`, ...). We return the
 *     last assistant message after the user prompt whose stop_reason is NOT
 *     "tool_use", polling until that final message appears. If a turn ever ends
 *     without a terminal stop_reason, we fall back to the latest assistant text.
 */
async function resolveReplyText(transcriptPath) {
  if (!transcriptPath) return "";
  let fallback = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    // ~9s budget — tool-heavy turns flush their final message slightly later
    const { final, latest } = readReply(transcriptPath);
    if (final) return final;
    if (latest) fallback = latest;
    await delay(150);
  }
  return fallback;
}

function readReply(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return { final: "", latest: "" };
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

  // Scan back from the end (after the most recent real user prompt). `latest` is
  // the most recent assistant text of any kind; `final` is the most recent one
  // that ended the turn (terminal stop_reason, not a tool_use pause).
  let latest = "";
  for (let i = records.length - 1; i > lastUser; i--) {
    const message = records[i].message || records[i];
    const role = message.role || records[i].type;
    if (role !== "assistant") continue;
    const text = extractText(message.content);
    if (!text) continue;
    if (!latest) latest = text;
    const stop = message.stop_reason;
    if (stop && stop !== "tool_use") return { final: text, latest };
  }
  return { final: "", latest };
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      { host: "127.0.0.1", port, path: "/reply", method: "POST", headers: { "content-type": "application/json", "content-length": data.length } },
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
