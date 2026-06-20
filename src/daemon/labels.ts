/**
 * Compute a human label for a thread (one Claude pane) — the chip the phone shows in the
 * thread switcher. Pure-ish, isolated like history-ring.ts / shouldReap so the title-priority
 * and graceful-degrade logic is unit-testable without spawning git/cmux.
 *
 * The label is `{ title, repo, branch, cwd }`, where `title` is the single string shown on
 * the chip, chosen most-specific-first (see pickTitle):
 *   1. the cmux per-surface TITLE (the live Claude task description, probe §0.6-A);
 *   2. else `repo · branch` (the guaranteed-available default for a git checkout);
 *   3. else the cwd basename;
 *   4. else the threadId (never empty).
 *
 * Every input is best-effort: a missing piece is simply omitted and the title falls through.
 * The daemon sends this in thread_register on connect and refreshes it (the cmux title tracks
 * the running task), folding the refresh into the existing cmux-health tick — no new timer.
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { ThreadLabel } from "../shared/protocol.js";
import { cmuxSurfaceTitle } from "./cmux.js";

const TITLE_SEPARATOR = " · ";

// Injected so tests can stub cmux/git without child processes. Each returns undefined when
// its source is unavailable (cmux down, not a git repo) — the label degrades from there.
export type LabelProbes = {
  surfaceTitle: (surface?: string) => Promise<string | undefined>;
  gitRepoBranch: (cwd: string) => Promise<{ repo?: string; branch?: string }>;
};

/**
 * Compute the thread label. `cwd` is the daemon's process.cwd() (cmux exposes no per-surface
 * cwd — issue #2761); `surfaceId` is its CMUX_SURFACE_ID (also the threadId). `threadId` is
 * the last-resort title so the chip is never blank.
 */
export async function computeLabel(
  cwd: string,
  surfaceId: string | undefined,
  threadId: string,
  probes: LabelProbes = defaultProbes
): Promise<ThreadLabel> {
  const [paneTitle, { repo, branch }] = await Promise.all([probes.surfaceTitle(surfaceId), probes.gitRepoBranch(cwd)]);
  const cwdBase = basename(cwd) || undefined;
  return { title: pickTitle({ paneTitle, repo, branch, cwd: cwdBase, threadId }), repo, branch, cwd: cwdBase };
}

// Most-specific-first; every fallback is guaranteed non-empty by the threadId floor.
function pickTitle(parts: {
  paneTitle?: string;
  repo?: string;
  branch?: string;
  cwd?: string;
  threadId: string;
}): string {
  if (parts.paneTitle) return parts.paneTitle;
  if (parts.repo && parts.branch) return `${parts.repo}${TITLE_SEPARATOR}${parts.branch}`;
  if (parts.repo) return parts.repo;
  if (parts.cwd) return parts.cwd;
  return parts.threadId;
}

const defaultProbes: LabelProbes = {
  surfaceTitle: cmuxSurfaceTitle,
  gitRepoBranch: gitRepoBranch
};

/**
 * repo (basename of the worktree root) + branch via two `git -C <cwd>` calls. Mirrors cmux.ts'
 * spawn-with-timeout ethos so a hung/absent git can never stall the daemon; a non-repo (or any
 * failure) yields `{}` so the label degrades to the cwd basename.
 */
export async function gitRepoBranch(cwd: string): Promise<{ repo?: string; branch?: string }> {
  const [top, head] = await Promise.all([
    runGit(["-C", cwd, "rev-parse", "--show-toplevel"]),
    runGit(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])
  ]);
  return {
    repo: top ? basename(top) : undefined,
    // A detached HEAD prints "HEAD"; treat that as no branch so the title degrades to repo.
    branch: head && head !== "HEAD" ? head : undefined
  };
}

const GIT_TIMEOUT_MS = 4000;

// Run a git command, returning trimmed stdout on exit 0 or undefined otherwise. Self-contained
// (own spawn) so labels.ts has no cmux coupling beyond the title probe; killed on timeout so a
// stuck git (e.g. a network filesystem) can't wedge label refresh.
function runGit(args: string[]): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const done = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      done(undefined);
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("error", () => done(undefined));
    child.on("exit", (code) => done(code === 0 ? stdout.trim() || undefined : undefined));
  });
}
