// Shared client for the per-pane voice daemon, used by every hook (stop-notify, prompt-submit,
// session-reset). Centralises the local daemon contract — the runtime-file location and the timed
// localhost POST — so the daemon's interface lives in ONE place instead of being copy-pasted across
// hook scripts.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// The per-thread runtime file is hook↔daemon IPC; it lives at a FIXED $HOME path — NOT under
// $CLAUDE_PLUGIN_DATA — because a hook can inherit a DIFFERENT CLAUDE_PLUGIN_DATA than the daemon (a
// Codex-companion session forces the session-wide value onto hooks). $HOME + CMUX_SURFACE_ID is the
// anchor both processes share. MUST match config.ts#runtimeDir exactly.
function runtimePath() {
  const surface = process.env.CMUX_SURFACE_ID || "default";
  return join(homedir(), ".cache", "cc-voice-control", "runtime", `${surface}.json`);
}

/** The daemon's runtime info for this pane (`{ port, pid, … }`), or undefined if it isn't running. */
export function readDaemonRuntime() {
  try {
    return JSON.parse(readFileSync(runtimePath(), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * POST JSON to this pane's daemon at `route`. Times out fast so a frozen/zombie daemon can never hang
 * the hook (which would block the prompt / Stop event). The caller swallows rejections.
 */
export function postDaemon(port, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length },
        timeout: 2000
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", reject);
    if (data.length > 0) req.write(data);
    req.end();
  });
}

/** Read stdin to completion (hook payload JSON arrives there). */
export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}
