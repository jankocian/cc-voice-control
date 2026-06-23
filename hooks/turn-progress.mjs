#!/usr/bin/env node
/**
 * PreToolUse hook — tells this pane's daemon Claude is about to run a tool.
 *
 * Fires before each tool call, by which point Claude has already written the short narration it precedes
 * the tool with ("I'll read the file first…"). The daemon re-reads the transcript and pushes those STEPS
 * to the phone live — so during a long turn you see what Claude is doing instead of a frozen "working".
 *
 * AskUserQuestion is special: Claude does NOT write that tool_use record to the transcript until the question
 * is ANSWERED, so the transcript is empty of it while the picker is open — nothing for the daemon to read.
 * But THIS hook fires the instant the picker opens and its payload carries the question (`tool_input`). So
 * for AskUserQuestion we forward the question itself; the daemon surfaces it live from the hook, not the
 * transcript. No-op if the daemon isn't running; never blocks the tool.
 */
import { postDaemon, readDaemonRuntime, readStdin } from "./lib/daemon-client.mjs";

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
  if (!runtime?.port) process.exit(0); // daemon not running in this pane
  const body = { transcriptPath: hook.transcript_path || "" };
  // The pending question lives only in the hook payload (not the transcript yet) — pass it through.
  if (hook.tool_name === "AskUserQuestion" && hook.tool_input && Array.isArray(hook.tool_input.questions)) {
    body.question = { toolUseId: hook.tool_use_id || "", questions: hook.tool_input.questions };
  }
  await postDaemon(runtime.port, "/turn-progress", body).catch(() => {});
  process.exit(0);
}
