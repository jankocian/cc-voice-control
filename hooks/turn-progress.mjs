#!/usr/bin/env node
/**
 * PreToolUse hook — tells this pane's daemon Claude is about to run a tool.
 *
 * Fires before each tool call, by which point Claude has already written the short narration it precedes
 * the tool with ("I'll read the file first…"). The daemon re-reads the transcript and pushes those STEPS
 * to the phone live — so during a long turn you see what Claude is doing instead of a frozen "working".
 * Like the other hooks it just hands over the transcript path; the daemon reads + projects it. No-op if the
 * daemon isn't running; never blocks the tool.
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
  await postDaemon(runtime.port, "/turn-progress", {
    transcriptPath: hook.transcript_path || ""
  }).catch(() => {});
  process.exit(0);
}
