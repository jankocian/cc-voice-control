import { spawn } from "node:child_process";

/**
 * Thin wrapper over the cmux CLI (the multiplexer hosting the interactive Claude
 * Code pane). We type the transcript into the pane and submit Enter, so it lands
 * as a real user message in the live session.
 *
 * Robustness, learned from the cmux CLI contract:
 *  - Pass the socket path explicitly (`--socket`) and drop the deprecated
 *    `CMUX_SOCKET` alias so a stale/empty value can't break the connection.
 *  - Target by BOTH `--workspace` and `--surface`; `send` resolves a surface
 *    within its workspace, and the defaults ($CMUX_WORKSPACE_ID/$CMUX_SURFACE_ID)
 *    are the daemon's own (the Claude pane it was launched from).
 *  - No focus needed: `send` delivers to background surfaces just fine.
 */
const CMUX_BIN = process.env.CMUX_BIN || "cmux";
const SOCKET_PATH = process.env.CMUX_SOCKET_PATH;
const WORKSPACE_ID = process.env.CMUX_WORKSPACE_ID;

function cmuxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Deprecated alias; if it's set (even empty) alongside CMUX_SOCKET_PATH the CLI
  // can refuse to run. We always pass --socket, so drop it.
  delete env.CMUX_SOCKET;
  return env;
}

const CMUX_TIMEOUT_MS = 8000;

function runCmux(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const globals = SOCKET_PATH ? ["--socket", SOCKET_PATH] : [];
  return new Promise((resolve) => {
    const child = spawn(CMUX_BIN, [...globals, ...args], { env: cmuxEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (result: { ok: boolean; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A hung cmux subprocess must never stall the daemon (startup or inject).
    const timer = setTimeout(() => {
      console.error(`[cmux] ${args.join(" ")} -> timed out after ${CMUX_TIMEOUT_MS}ms`);
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      done({ ok: false, stdout, stderr: "timeout" });
    }, CMUX_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (error) => {
      console.error(`[cmux] ${args.join(" ")} -> spawn error: ${error}`);
      done({ ok: false, stdout, stderr: String(error) });
    });
    child.on("exit", (code) => {
      if (code !== 0) console.error(`[cmux] ${args.join(" ")} -> exit ${code} | ${stdout.trim()} ${stderr.trim()}`);
      done({ ok: code === 0, stdout, stderr });
    });
  });
}

function target(surface?: string): string[] {
  const args: string[] = [];
  if (WORKSPACE_ID) args.push("--workspace", WORKSPACE_ID);
  if (surface) args.push("--surface", surface);
  return args;
}

/** True if the cmux control socket is reachable. */
export async function cmuxPing(): Promise<boolean> {
  const r = await runCmux(["ping"]);
  return r.ok && /PONG/.test(r.stdout);
}

/** Type text into the surface and submit it (as a real user message). */
export async function cmuxSubmit(text: string, surface?: string): Promise<boolean> {
  const typed = await runCmux(["send", ...target(surface), "--", text]);
  if (!typed.ok) return false;
  await delay(150);
  const submitted = await runCmux(["send-key", ...target(surface), "enter"]);
  return submitted.ok;
}

/** Interrupt the running turn (Esc is Claude Code's stop). */
export async function cmuxInterrupt(surface?: string): Promise<boolean> {
  const r = await runCmux(["send-key", ...target(surface), "escape"]);
  return r.ok;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
