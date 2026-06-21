#!/usr/bin/env node
/**
 * Stop hook — tells this pane's daemon a turn FINISHED.
 *
 * The daemon reads the finished turn straight from the transcript (the source of truth: native uuids +
 * native order), polling it for the flush if needed, so this hook just hands over the path and returns.
 * No-op if the daemon isn't running; never blocks the Stop event.
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
  await postDaemon(runtime.port, "/turn-close", {
    transcriptPath: hook.transcript_path || ""
  }).catch(() => {});
  process.exit(0);
}
