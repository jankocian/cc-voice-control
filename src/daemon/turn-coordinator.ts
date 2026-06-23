// The voice remote's INJECTION queue + idle-gate, isolated from all I/O so it's unit-testable with a fake
// clock. The transcript is the source of truth for the CONVERSATION and for the working lamp (see
// transcript-projection.ts / VoiceDaemon.isWorking); this owns only the voice side: queue spoken prompts
// and type them into the pane ONE AT A TIME, while Claude is idle.
//
// "Busy" is a single LEVEL, not a count. Claude runs a pane's turns serially, so a Stop means "idle now"
// no matter how many UserPromptSubmit preceded it — a glued/merged prompt fires two opens but one close.
// Modelling it as a counter was the bug that left the gate (and the old hook-counted lamp) stuck. The
// daemon folds `isBusy` into the working lamp ANDed with the transcript truth, so neither signal alone can
// wedge the lamp; the reaper below is a last-resort backstop for the INJECT GATE only.

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
   *  ANDs this with the transcript-derived state for the working lamp, so a stale hook can't wedge it. */
  get isBusy(): boolean {
    return this.paneBusy;
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
    this.deps.onStatusChange();
  }

  /** A turn FINISHED (Stop): the pane is idle now — an ABSOLUTE edge, not a decrement. Drain the queue. */
  turnClosed(): void {
    this.paneBusy = false;
    this.busySince = undefined;
    void this.pump();
    this.deps.onStatusChange();
  }

  /** The user Esc'd the running turn (the daemon does the Esc): drop all turns, run the queue. */
  interrupt(): void {
    this.clearTurns();
    this.deps.onStatusChange(); // pump() below no-ops on an empty queue
    void this.pump();
  }

  /** Esc + run `text` next, ahead of anything already queued. */
  interruptWith(text: string): void {
    this.clearTurns();
    this.queue.unshift(text);
    void this.pump(); // re-injects immediately → emits "working"
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
  // transcript-derived and self-heals on its own; this never drives it.
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
