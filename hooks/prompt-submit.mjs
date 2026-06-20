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
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-thread runtime file: runtime/<surfaceId>.json (matches config.ts#threadRuntimePath). The hook
// runs in this pane, so $CMUX_SURFACE_ID identifies its own daemon; "default" mirrors the daemon's
// fallback name when launched outside cmux.
const STATE_DIR = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "cc-voice-control");
const SURFACE_ID = process.env.CMUX_SURFACE_ID || "default";
const RUNTIME_PATH = join(STATE_DIR, "runtime", `${SURFACE_ID}.json`);

main().catch(() => process.exit(0));

async function main() {
  const payload = await readStdin();
  let hook;
  try {
    hook = JSON.parse(payload || "{}");
  } catch {
    process.exit(0);
  }
  let runtime;
  try {
    runtime = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
  } catch {
    process.exit(0); // daemon not running in this pane
  }
  if (!runtime?.port) process.exit(0);
  await post(runtime.port, {
    prompt: typeof hook.prompt === "string" ? hook.prompt : "",
    permissionMode: hook.permission_mode || ""
  }).catch(() => {});
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

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/turn-open",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length }
      },
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
