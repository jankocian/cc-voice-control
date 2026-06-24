// The voice remote's INJECTION queue + idle-gate, isolated from all I/O so it's unit-testable with a fake
// clock. The transcript is the source of truth for the CONVERSATION and for the working lamp (see
// transcript-projection.ts / VoiceDaemon.isWorking); this owns only the voice side: queue spoken prompts
// and type them into the pane ONE AT A TIME, while Claude is idle.
//
// "Busy" is a single LEVEL, not a count. Claude runs a pane's turns serially, so a Stop means "idle now"
// no matter how many UserPromptSubmit preceded it — a glued/merged prompt fires two opens but one close.
// Modelling it as a counter was the bug that left the gate (and the old hook-counted lamp) stuck. The
// daemon ORs `isBusy` with the transcript truth for the working lamp (see VoiceDaemon.computeState): either
// an open turn OR an unanswered transcript turn reads as working, so a dropped Stop can't flip the lamp to
// idle while a reply is still streaming. `idle_prompt` (60s) and the reaper below clear a stuck `isBusy`.
//
// `permissionPending` is the one thing the transcript CAN'T see: a permission_prompt (Claude blocked on the
// user's approval) writes no transcript record. The Notification hook sets it; the next forward-progress
// edge (a tool ran, the turn opened/closed, or a 60s idle_prompt) clears it.

// A turn open this long with no Stop is treated as abandoned and reaped, so the idle-gate can release
// queued prompts. Generous: real agent turns run minutes; this is only the unattended backstop.
const TURN_TTL_MS = 20 * 60 * 1000;

export type TurnCoordinatorDeps = {
  // Type `text` into the pane (cmux). Resolves true on success. Called only when Claude is idle.
  inject: (text: string) => Promise<boolean>;
  // The working/idle state changed → the daemon re-emits status.
  onStatusChange: () => void;
  log?: (message: string) => void;
  now?: () => number; // injectable clock so the reaper is testable
};

export class TurnCoordinator {
  // We inject ONE voice prompt at a time, only while Claude is idle. `inFlight` is the prompt we just
  // typed and are waiting to see open as a turn; `queue` holds prompts captured while Claude was busy.
  private inFlight?: string;
  private injectedAt?: number;
  private readonly queue: string[] = [];

  // The pane is busy from a turn's UserPromptSubmit until its Stop. A LEVEL, not a count — see the header.
  private paneBusy = false;
  private busySince?: number;

  // Claude is blocked on the user's approval (a permission_prompt Notification). Set by the hook, cleared on
  // the next forward-progress edge. The transcript can't see this (no record), so it lives here. See header.
  private permissionPending = false;

  // Identity token for the current injection, bumped on every inject AND clear. pump() captures it before
  // awaiting inject() and re-checks after, so a late result is recognised as stale by IDENTITY, not by the
  // prompt string (the canned status/summary prompts repeat).
  private injectSeq = 0;

  private readonly now: () => number;

  constructor(private readonly deps: TurnCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Our injection is typed but not yet seen as an open turn. The daemon folds this into the working lamp
   *  so the gap before the prompt lands in the transcript still reads as working (not a flicker to idle). */
  get hasInFlight(): boolean {
    return this.inFlight !== undefined;
  }

  /** The pane is mid-turn (a UserPromptSubmit without its Stop yet), as the inject gate sees it. The daemon
   *  ORs this with the transcript-derived state for the working lamp, so a dropped Stop can't idle it early. */
  get isBusy(): boolean {
    return this.paneBusy;
  }

  /** Claude is blocked on the user's approval (a permission_prompt). The daemon shows "awaiting" for this. */
  get awaitingPermission(): boolean {
    return this.permissionPending;
  }

  /** The voice prompt currently in flight (for the status "currentTask"), if any. */
  get currentVoicePrompt(): string | undefined {
    return this.inFlight;
  }

  /** A spoken transcript to run: queue it and inject once the pane is idle. */
  enqueueVoice(text: string): void {
    this.queue.push(text);
    void this.pump();
  }

  /** A turn STARTED (UserPromptSubmit). The pane is busy; if it's our injection landing, retire `inFlight`. */
  turnOpened(prompt: string): void {
    this.reapStaleTurns();
    const trimmed = prompt.trim();
    if (this.inFlight !== undefined && this.inFlight.trim() === trimmed) {
      this.inFlight = undefined;
      this.injectedAt = undefined;
    }
    this.paneBusy = true;
    this.busySince = this.now();
    this.permissionPending = false; // a new prompt is forward progress past any pending approval
    this.deps.onStatusChange();
  }

  /** A turn FINISHED (Stop): the pane is idle now — an ABSOLUTE edge, not a decrement. Drain the queue. */
  turnClosed(): void {
    this.paneBusy = false;
    this.busySince = undefined;
    this.permissionPending = false;
    void this.pump();
    this.deps.onStatusChange();
  }

  /** Claude is blocked on the user's approval (a permission_prompt Notification): show "awaiting". */
  notePermissionPrompt(): void {
    if (this.permissionPending) return;
    this.permissionPending = true;
    this.deps.onStatusChange();
  }

  /** A forward-progress edge that isn't a turn open/close (a tool ran — PreToolUse) clears a pending
   *  approval: if Claude is running tools again, it's no longer parked on the permission prompt. */
  noteProgress(): void {
    if (!this.permissionPending) return;
    this.permissionPending = false;
    this.deps.onStatusChange();
  }

  /** `idle_prompt` (Claude has been idle 60s+): a guaranteed floor that clears a stuck-busy lamp if a Stop
   *  was ever dropped. The transcript still decides whether there's genuinely unfinished work. */
  forceIdle(): void {
    this.paneBusy = false;
    this.busySince = undefined;
    this.permissionPending = false;
    void this.pump();
    this.deps.onStatusChange();
  }

  /** The user Esc'd the running turn (the daemon does the Esc): drop all turns, run the queue. */
  interrupt(): void {
    this.clearTurns();
    this.deps.onStatusChange(); // pump() below no-ops on an empty queue
    void this.pump();
  }

  /** /clear or /compact: end the topic — drop every in-flight/queued/open turn. */
  reset(): void {
    this.clearTurns();
    this.queue.length = 0;
    this.deps.onStatusChange();
  }

  private async pump(): Promise<void> {
    this.reapStaleTurns(); // free the gate if a previous turn hung — else injection blocks forever
    if (this.inFlight !== undefined) return; // our own injection is still pending its open
    if (this.paneBusy) return; // Claude is mid-turn — wait for the pane to go idle
    // Shift BEFORE injecting. This is also why a queued prompt can't become a "duplicate" of a merged/glued
    // record: a prompt's text only reaches the pane (and thus any transcript record) by being injected here,
    // which removes it from the queue first — so it can never be both still-queued AND part of a glued turn.
    const next = this.queue.shift();
    if (next === undefined) return;
    const seq = ++this.injectSeq;
    this.inFlight = next; // set before awaiting so a concurrent pump sees "busy"
    this.injectedAt = this.now();
    this.deps.onStatusChange();
    const ok = await this.deps.inject(next);
    if (this.injectSeq !== seq) return; // superseded while awaiting (interrupt/reset/re-inject) → stale
    if (!ok) {
      this.inFlight = undefined;
      this.injectedAt = undefined;
      this.deps.onStatusChange();
      void this.pump(); // try the next queued prompt
    }
  }

  private clearTurns(): void {
    this.inFlight = undefined;
    this.injectedAt = undefined;
    this.paneBusy = false;
    this.busySince = undefined;
    this.injectSeq++; // invalidate any in-flight inject() await so its late result is dropped as stale
  }

  // Backstop for the INJECT GATE only: free a turn stuck open past TURN_TTL_MS (a missed Stop) or an
  // injection whose turn-open never arrived, so injection can't wedge forever. The working LAMP is
  // transcript-derived and self-heals on its own; this never drives it. Runs on every pump()/turnOpened()
  // rather than a timer, so a stuck queue clears on the next coordinator activity (e.g. the next spoken
  // prompt's enqueueVoice → pump) — adequate, since the queue only matters when there's a prompt to inject.
  private reapStaleTurns(): void {
    const cutoff = this.now() - TURN_TTL_MS;
    if (this.paneBusy && this.busySince !== undefined && this.busySince < cutoff) {
      this.paneBusy = false;
      this.busySince = undefined;
      this.log("reaped a stale open turn");
    }
    if (this.inFlight !== undefined && this.injectedAt !== undefined && this.injectedAt < cutoff) {
      this.inFlight = undefined;
      this.injectedAt = undefined;
      this.log("reaped a stuck injection (no turn-open arrived)");
    }
  }

  private log(message: string): void {
    this.deps.log?.(`[voice] ${message}`);
  }
}
