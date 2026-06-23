#!/usr/bin/env node
/**
 * Notification hook — tells this pane's daemon when Claude is waiting on the HUMAN.
 *
 * Claude Code fires Notification with a `notification_type`; hooks.json registers TWO narrow entries
 * (matcher `permission_prompt` / `idle_prompt`), each invoking this script with the kind as argv[2] — so we
 * never depend on the (undocumented) stdin field. We pass it through anyway as a belt-and-suspenders.
 *   • permission → a permission_prompt fired (Claude is blocked on the user's approval) → daemon shows
 *     "awaiting". Fires immediately when the dialog appears.
 *   • idle       → idle_prompt (Claude has been idle 60s+ waiting for input) → a guaranteed floor that
 *     clears a stuck-busy lamp if a Stop was ever dropped. The transcript still decides the rest.
 * No-op if the daemon isn't running in this pane; never blocks Claude.
 */
import { postDaemon, readDaemonRuntime, readStdin } from "./lib/daemon-client.mjs";

main().catch(() => process.exit(0));

async function main() {
  const argKind = process.argv[2]; // "permission" | "idle", baked into the hooks.json command by matcher
  const payload = await readStdin();
  let hook = {};
  try {
    hook = JSON.parse(payload || "{}");
  } catch {
    // keep argKind; the stdin field is only a fallback
  }
  const kind = argKind || (hook.notification_type === "idle_prompt" ? "idle" : "permission");
  if (kind !== "permission" && kind !== "idle") process.exit(0);
  const runtime = readDaemonRuntime();
  if (!runtime?.port) process.exit(0); // daemon not running in this pane
  await postDaemon(runtime.port, "/notify", { kind }).catch(() => {});
  process.exit(0);
}
