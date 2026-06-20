#!/usr/bin/env node
/**
 * UserPromptSubmit hook for the voice remote.
 *
 * Fires the moment a prompt is submitted in this pane — whether spoken (the daemon types it in)
 * or typed directly in the terminal. It POSTs to THIS pane's daemon at /working so the phone shows
 * "working" for the whole turn, including typed turns the daemon never injected (the Stop hook
 * clears it again). If the daemon isn't running, this is a no-op. It never blocks the prompt.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-thread runtime file: runtime/<surfaceId>.json (matches config.ts#threadRuntimePath). The
// hook runs in this pane, so $CMUX_SURFACE_ID identifies its own daemon; "default" mirrors the
// daemon's fallback name when launched outside cmux.
const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "cc-voice-control");
const SURFACE_ID = process.env.CMUX_SURFACE_ID || "default";
const RUNTIME_PATH = join(STATE_DIR, "runtime", `${SURFACE_ID}.json`);

main().catch(() => process.exit(0));

async function main() {
  let runtime;
  try {
    runtime = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
  } catch {
    process.exit(0); // daemon not running in this pane
  }
  if (!runtime?.port) process.exit(0);
  await post(runtime.port).catch(() => {});
  process.exit(0);
}

function post(port) {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/working", method: "POST", headers: { "content-length": 0 } },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.end();
  });
}
