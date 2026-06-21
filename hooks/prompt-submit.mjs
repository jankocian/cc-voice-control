#!/usr/bin/env node
/**
 * UserPromptSubmit hook for the voice remote.
 *
 * Fires the instant a prompt is submitted in this pane — spoken (the daemon types it in) or typed
 * directly in the terminal — and BEFORE Claude Code expands any slash command / skill. So `prompt`
 * here is the user's REAL words (e.g. "/voice-control:start", not the SKILL.md body), which is the
 * one reliable place to classify a turn. We POST it to this pane's daemon at /turn-open; the daemon
 * opens the turn (driving the working lamp) and, on the matching Stop, speaks/mirrors/ignores it.
 * `permission_mode` rides along so a spawn during the turn inherits it. No-op if no daemon; never
 * blocks the prompt.
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
    prompt: typeof hook.prompt === "string" ? hook.prompt : "",
    permissionMode: hook.permission_mode || ""
  }).catch(() => {});
  process.exit(0);
}
