#!/usr/bin/env node
/**
 * SessionStart hook for the voice remote.
 *
 * `/clear` and `/compact` start a brand-new topic in the SAME pane (same CMUX_SURFACE_ID, same
 * daemon process), so the daemon's voice history would otherwise still show the old conversation.
 * SessionStart fires with `source` ∈ {startup, resume, clear, compact}; on `clear`/`compact` we POST
 * to THIS pane's daemon at /reset so it hides the prior topic (raises its projection floor) and pushes
 * an empty `history` to the phone. `startup` is a fresh process (nothing to clear) and `resume`
 * deliberately keeps history, so both are ignored. If the daemon isn't running, this is a no-op. Never blocks.
 */
import { postDaemon, readDaemonRuntime, readStdin } from "./lib/daemon-client.mjs";

// Only these two sources mean "new topic, same pane → reset". startup/resume keep history.
const RESET_SOURCES = new Set(["clear", "compact"]);

main().catch(() => process.exit(0));

async function main() {
  const payload = await readStdin();
  let hook;
  try {
    hook = JSON.parse(payload || "{}");
  } catch {
    process.exit(0);
  }

  if (!RESET_SOURCES.has(hook.source)) process.exit(0);

  const runtime = readDaemonRuntime();
  if (!runtime?.port) process.exit(0); // daemon not running in this pane

  await postDaemon(runtime.port, "/reset").catch(() => {});
  process.exit(0);
}
