#!/usr/bin/env node
/**
 * UserPromptSubmit hook — tells this pane's daemon a turn STARTED.
 *
 * Fires the instant a prompt is submitted (voice-injected or typed) and BEFORE Claude Code expands any
 * slash command / skill, so `prompt` is the user's REAL words. The daemon uses `prompt` only to recognise
 * its own voice injections (so it knows which replies to speak) and to drive the working lamp; it reads
 * the actual conversation from `transcriptPath` — the transcript is the source of truth. `permission_mode`
 * rides along so a spawn during the turn inherits it. No-op if no daemon; never blocks the prompt.
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
  await postDaemon(runtime.port, "/turn-open", {
    transcriptPath: hook.transcript_path || "",
    prompt: typeof hook.prompt === "string" ? hook.prompt : "",
    permissionMode: hook.permission_mode || ""
  }).catch(() => {});
  process.exit(0);
}
