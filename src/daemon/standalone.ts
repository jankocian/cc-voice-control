#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { resolveConfig, stateDir, writeSetupNeededRuntime } from "./config.js";
import { createDaemonInit, VoiceDaemon } from "./voice-daemon.js";

/**
 * Standalone voice-remote daemon — the daemon's own entry point.
 *
 * Launched by `/voice-control:start` as a Claude Code background Bash task
 * (`run_in_background`), so it stays a CHILD of the interactive Claude process and
 * keeps inside cmux's process tree — the socket trust needed to type into the pane.
 * (A `nohup &`/`setsid` daemon is reparented to launchd and cmux rejects it.) The
 * task IS the daemon: it is the visible, killable `/tasks` entry. There is no MCP
 * host and no `active`-flag poll — start = launch this task, stop = kill it.
 *
 * Teardown: Claude Code sends SIGTERM-before-SIGKILL on background-task teardown, and
 * `/voice-control:stop` SIGTERMs us by pid; either way the handler runs `daemon.stop()`
 * (closes WS + HTTP, terminates the bridge session, removes runtime.json/qr.txt). On a
 * plain interactive exit a task can instead be orphaned to launchd (PID 1, #43944) — the
 * orphan self-reap guard detects the lost Claude parent and exits, so no deaf zombie lingers.
 *
 * stdout is free here (no JSON-RPC channel), so the banner prints the phone URL to stdout
 * (visible in the `/tasks` output). Diagnostics still go to stderr + ${stateDir}/daemon.log.
 */

const LOG_MAX_BYTES = 1_000_000;

// Persist all diagnostics to ${stateDir}/daemon.log so the daemon's runtime diagnostics
// (cmux health, injection results) survive even if the task's stderr scrollback is lost.
// Tee console.error to the file; cap it so it can't grow without bound. Called from main()
// (not at import time) so importing this module for its pure helpers has no side effects.
function installLogTee(): void {
  mkdirSync(stateDir(), { recursive: true });
  const logFile = join(stateDir(), "daemon.log");
  const baseError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    baseError(...args);
    try {
      if (existsSync(logFile) && statSync(logFile).size > LOG_MAX_BYTES) truncateSync(logFile, 0);
      appendFileSync(logFile, `${new Date().toISOString()} ${args.map((a) => String(a)).join(" ")}\n`);
    } catch {
      // logging must never throw into the daemon
    }
  };
}

// How often the orphan guard re-checks the parent chain.
const ORPHAN_GUARD_INTERVAL_MS = 5000;

/**
 * Pure decision for the orphan self-reap guard: should the daemon reap itself? A child whose
 * parent has exited is reparented to launchd (PID 1) on macOS/Linux — and a PID-1 child has
 * already lost cmux trust (it's no longer in the pane's process tree). That reparent is the
 * only way our Claude parent goes away, so `ppid === 1` is the whole signal.
 */
export function shouldReap(ppidNow: number): boolean {
  return ppidNow === 1;
}

function startOrphanGuard(stop: (reason: string) => void): void {
  const timer = setInterval(() => {
    if (shouldReap(process.ppid)) stop("orphaned (reparented to launchd, PID 1)");
  }, ORPHAN_GUARD_INTERVAL_MS);
  // Don't let the guard keep the process alive on its own; the daemon's WS + HTTP + health
  // timer are the load-bearing handles. (No-op on platforms without unref, e.g. some shims.)
  timer.unref?.();
}

async function main(): Promise<void> {
  installLogTee();
  const result = await resolveConfig();
  if (!result.ok) {
    // No OpenAI key yet: publish onboarding runtime.json so the start skill can branch on
    // needsSetup, then EXIT 0 — the task ends, so there's no ghost /tasks entry.
    writeSetupNeededRuntime(result);
    console.error(`[standalone] setup needed: ${result.missing} not set (${result.configPath})`);
    process.exit(0);
  }

  const daemon = new VoiceDaemon(createDaemonInit(result.config));
  await daemon.start(); // opens hook HTTP listener + bridge WS, writes runtime.json + qr.txt
  // stdout banner — visible in the /tasks output; this is the "voice is live" signal.
  console.log(`voice remote active — ${daemon.browserUrl}`);
  console.log("kill this task (/tasks, or /voice-control:stop) to stop voice.");

  let stopping = false;
  const stop = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    console.error(`[standalone] ${reason} → stopping`);
    daemon.stop(); // closes WS + HTTP, terminates the bridge session, removes runtime.json/qr.txt
    process.exit(0);
  };

  process.on("SIGTERM", () => stop("SIGTERM")); // Claude Code teardown / /voice-control:stop
  process.on("SIGINT", () => stop("SIGINT")); // /tasks kill / TaskStop / Ctrl-C
  startOrphanGuard(stop); // self-reap if we lose our Claude parent (#43944)

  // No artificial keep-alive: the daemon's bridge WS, hook HTTP listener and 5s cmux-health
  // timer are active handles, so Node stays up until a signal or the orphan guard fires.
}

// Only run when invoked as the process entry point (node …/standalone.js) — not when imported
// (e.g. by the unit test that exercises shouldReap). Compare REAL paths: import.meta.url is
// symlink-resolved but argv[1] is the literal launch path, so a symlinked CLAUDE_PLUGIN_ROOT
// (/tmp, a worktree, a symlinked checkout) would otherwise never match and the task would no-op.
function isEntryPoint(): boolean {
  if (!argv[1]) return false;
  try {
    return realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) {
  main().catch((error) => {
    console.error(`[standalone] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
