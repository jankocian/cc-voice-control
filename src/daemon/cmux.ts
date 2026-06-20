import { spawn } from "node:child_process";

/**
 * Thin wrapper over the cmux CLI (the multiplexer hosting the interactive Claude
 * Code pane). We type the transcript into the pane and submit Enter, so it lands
 * as a real user message in the live session.
 *
 * Hard-won contract (verified against the live cmux CLI):
 *  - Pass the socket path explicitly (`--socket`) and drop the deprecated
 *    `CMUX_SOCKET` alias so a stale/empty value can't break the connection.
 *  - **Clear `CMUX_WORKSPACE_ID`** for every call. cmux scopes a `--surface`
 *    lookup to the caller's workspace when that var is set; with it cleared, a bare
 *    `--surface` resolves GLOBALLY. This is the whole ballgame for robustness: the
 *    surface ref is stable for the life of the pane, so a globally-resolved surface
 *    keeps working even after the user drags the pane into a different workspace
 *    (which makes `CMUX_WORKSPACE_ID` stale). Pinning the workspace — or letting the
 *    env scope the lookup — is what made injection (and the "listening" lamp) break
 *    on a moved pane.
 *  - Target by `--surface` ONLY (never `--workspace`).
 *  - Liveness uses `read-screen --surface` (which resolves the same global way
 *    `send` does), so "reachable for read" predicts "reachable for inject". A plain
 *    `ping` only proves the control socket is up, not that the pane exists.
 */
const CMUX_BIN = process.env.CMUX_BIN || process.env.CMUX_BUNDLED_CLI_PATH || "cmux";
const SOCKET_PATH = process.env.CMUX_SOCKET_PATH;

function cmuxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Deprecated alias; if it's set (even empty) alongside CMUX_SOCKET_PATH the CLI
  // can refuse to run. We always pass --socket, so drop it.
  delete env.CMUX_SOCKET;
  // Force GLOBAL surface resolution (see the module note): without this, cmux scopes
  // `--surface` to this (possibly stale) workspace and a moved pane becomes invisible.
  delete env.CMUX_WORKSPACE_ID;
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

// Target a surface by its ref/UUID ONLY — never the workspace (which we also clear
// from the env), so the lookup resolves globally and survives a workspace move.
export function cmuxTarget(surface?: string): string[] {
  return surface ? ["--surface", surface] : [];
}

/** True if the cmux control socket is reachable (socket-level only — not the pane). */
export async function cmuxPing(): Promise<boolean> {
  const r = await runCmux(["ping"]);
  return r.ok && /PONG/.test(r.stdout);
}

export type CmuxHealth = {
  // cmux control socket reachable (ping).
  socketUp: boolean;
  // true  = the pane is reachable (globally resolved)
  // false = cmux is up but the pane is positively gone (closed)
  // null  = unknown (no surface to probe, or cmux socket down)
  surfaceAlive: boolean | null;
};

/**
 * Probe the daemon's pane the same way injection reaches it: a global `read-screen
 * --surface` (workspace env is cleared in cmuxEnv). Exit 0 ⇒ reachable. Only when
 * that fails do we ping, to tell "pane closed" (socket up, surface gone) apart from
 * "cmux down" (socket unreachable) — the caller stays optimistic on the latter.
 */
export async function cmuxHealth(surface?: string): Promise<CmuxHealth> {
  if (!surface) return { socketUp: await cmuxPing(), surfaceAlive: null };
  const reach = await runCmux(["read-screen", "--surface", surface, "--lines", "1"]);
  if (reach.ok) return { socketUp: true, surfaceAlive: true };
  const socketUp = await cmuxPing();
  return { socketUp, surfaceAlive: socketUp ? false : null };
}

/** Type text into the surface and submit it (as a real user message). */
export async function cmuxSubmit(text: string, surface?: string): Promise<boolean> {
  // Two ordered writes to the same surface socket: cmux delivers them in order, so the
  // text is fully typed before Enter submits it. The daemon serializes injection (one
  // in-flight turn at a time), so no other message can interleave between the two.
  const typed = await runCmux(["send", ...cmuxTarget(surface), "--", text]);
  if (!typed.ok) return false;
  const submitted = await runCmux(["send-key", ...cmuxTarget(surface), "enter"]);
  return submitted.ok;
}

/** Interrupt the running turn (Esc is Claude Code's stop). */
export async function cmuxInterrupt(surface?: string): Promise<boolean> {
  const r = await runCmux(["send-key", ...cmuxTarget(surface), "escape"]);
  return r.ok;
}

/**
 * The cmux per-surface TITLE for `surface` (the live Claude task description, e.g.
 * "Review to-dos and plan next implementation"), or undefined if unavailable. Probe §0.6-A
 * confirmed `tree --all --json --id-format both` exposes a per-surface `title`. We match the
 * entry whose ref/uuid equals `surface` (`--id-format both` makes both forms present), and
 * strip the leading spinner glyph the title carries while a turn is running.
 *
 * Best-effort: any failure (cmux down, no title field, surface not found) returns undefined
 * so the label falls through to repo·branch. The whole subtree is searched recursively since
 * cmux nests workspaces → surfaces.
 */
export async function cmuxSurfaceTitle(surface?: string): Promise<string | undefined> {
  if (!surface) return undefined;
  const r = await runCmux(["tree", "--all", "--json", "--id-format", "both"]);
  if (!r.ok) return undefined;
  try {
    const node = findSurfaceNode(JSON.parse(r.stdout) as unknown, surface);
    const title = node && typeof node.title === "string" ? stripSpinnerGlyph(node.title) : "";
    return title.length > 0 ? title : undefined;
  } catch {
    return undefined;
  }
}

// A surface node carries an opaque `title` plus one or more id forms. We don't model the
// whole cmux tree — only the fields we read — and recurse over any array-valued children.
type CmuxNode = { title?: unknown; id?: unknown; ref?: unknown; uuid?: unknown; [k: string]: unknown };

// Find the tree node whose id/ref/uuid matches `surface`. `--id-format both` means a surface
// may carry either the short ref (surface:N) or the UUID under any of these keys, so we match
// against all of them.
function findSurfaceNode(root: unknown, surface: string): CmuxNode | undefined {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      stack.push(...cur);
    } else if (cur && typeof cur === "object") {
      const node = cur as CmuxNode;
      if (node.id === surface || node.ref === surface || node.uuid === surface) return node;
      for (const value of Object.values(node)) if (value && typeof value === "object") stack.push(value);
    }
  }
  return undefined;
}

// cmux prefixes the title with a Braille spinner glyph (⠂⠂…) + whitespace while a turn runs.
// Strip any leading non-word run so the chip shows the bare task description. Exported for tests.
export function stripSpinnerGlyph(title: string): string {
  return title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
}
