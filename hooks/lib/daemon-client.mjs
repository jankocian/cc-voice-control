// Shared client for the per-pane voice daemon, used by every hook (stop-notify, prompt-submit,
// session-reset). Centralises the local daemon contract — the runtime-file location and the timed
// localhost POST — so the daemon's interface lives in ONE place instead of being copy-pasted across
// hook scripts.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Plugin runtime state lives in Claude Code's managed per-plugin data dir ($CLAUDE_PLUGIN_DATA,
// exported to hook processes), never in ~/.config. Per-thread file runtime/<surfaceId>.json (matches
// config.ts#threadRuntimePath); the hook runs in its pane, so $CMUX_SURFACE_ID names its own daemon.
function runtimePath() {
  const stateDir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), "cc-voice-control");
  const surface = process.env.CMUX_SURFACE_ID || "default";
  return join(stateDir, "runtime", `${surface}.json`);
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
