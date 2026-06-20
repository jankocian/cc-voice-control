#!/usr/bin/env node
/**
 * SessionStart hook for the voice remote.
 *
 * `/clear` and `/compact` start a brand-new topic in the SAME pane (same CMUX_SURFACE_ID, same
 * daemon process), so the daemon's voice history would otherwise still show the old
 * conversation. SessionStart fires with `source` ∈ {startup, resume, clear, compact}; on
 * `clear`/`compact` we POST to THIS pane's daemon at /reset so it wipes its history ring and
 * pushes an empty `history` to the phone. `startup` is a fresh process (nothing to clear) and
 * `resume` deliberately keeps history, so both are ignored.
 *
 * Reuses the exact hook→HTTP transport the Stop hook uses (127.0.0.1:<port> from this pane's
 * per-thread runtime file). If the daemon isn't running, this is a no-op. It never blocks.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Plugin runtime state lives in Claude Code's managed per-plugin data dir ($CLAUDE_PLUGIN_DATA,
// exported to hook processes), never in ~/.config. Falls back to a temp dir if somehow unset.
const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "cc-voice-control");
// Per-thread runtime file: runtime/<surfaceId>.json (matches config.ts#threadRuntimePath). The
// hook runs in this pane, so $CMUX_SURFACE_ID identifies its own daemon; "default" mirrors the
// daemon's fallback name when launched outside cmux.
const SURFACE_ID = process.env.CMUX_SURFACE_ID || "default";
const RUNTIME_PATH = join(STATE_DIR, "runtime", `${SURFACE_ID}.json`);

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

  const runtime = readRuntime();
  if (!runtime?.port) process.exit(0); // daemon not running in this pane

  await post(runtime.port).catch(() => {});
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

function post(port) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/reset", method: "POST", headers: { "content-length": 0 } },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.end();
  });
}
