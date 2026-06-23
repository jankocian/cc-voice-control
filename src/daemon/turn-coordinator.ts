// The voice remote's INJECTION queue + idle-gate, isolated from all I/O so it's unit-testable. The
// transcript is the source of truth for the CONVERSATION and for the working lamp (see
// transcript-projection.ts / VoiceDaemon.isWorking); this owns only the voice side: queue spoken prompts
// and type them into the pane ONE AT A TIME, while Claude is idle.
//
// "Busy" is a single LEVEL, not a count. Claude runs a pane's turns serially, so a Stop means "idle now"
// no matter how many UserPromptSubmit preceded it — a glued/merged prompt fires two opens but one close.
// Modelling it as a counter was the bug that left the gate (and the old hook-counted lamp) stuck. As a
// belt-and-braces self-heal, the daemon also calls `noteIdleFromTranscript()` whenever the transcript
// shows the pane idle, so a missed Stop can never wedge the gate — no timer/reaper needed.

export type TurnCoordinatorDeps = {
  // Type `text` into the pane (cmux). Resolves true on success. Called only when Claude is idle.
  inject: (text: string) => Promise<boolean>;
  // The working/idle state changed → the daemon re-emits status.
  onStatusChange: () => void;
  log?: (message: string) => void;
};

export class TurnCoordinator {
  // We inject ONE voice prompt at a time, only while Claude is idle. `inFlight` is the prompt we just
  // typed and are waiting to see open as a turn; `queue` holds prompts captured while Claude was busy.
  private inFlight?: string;
  private readonly queue: string[] = [];

  // The pane is busy from a turn's UserPromptSubmit until its Stop. A LEVEL, not a count — see the header.
  private paneBusy = false;

  // Identity token for the current injection, bumped on every inject AND clear. pump() captures it before
  // awaiting inject() and re-checks after, so a late result is recognised as stale by IDENTITY, not by the
  // prompt string (the canned status/summary prompts repeat).
  private injectSeq = 0;

  constructor(private readonly deps: TurnCoordinatorDeps) {}

  /** Our injection is typed but not yet seen as an open turn. The daemon folds this into the working lamp
   *  so the gap before the prompt lands in the transcript still reads as working (not a flicker to idle). */
  get hasInFlight(): boolean {
    return this.inFlight !== undefined;
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
    const trimmed = prompt.trim();
    if (this.inFlight !== undefined && this.inFlight.trim() === trimmed) this.inFlight = undefined;
    this.paneBusy = true;
    this.deps.onStatusChange();
  }

  /** A turn FINISHED (Stop): the pane is idle now — an ABSOLUTE edge, not a decrement. Drain the queue. */
  turnClosed(): void {
    this.paneBusy = false;
    void this.pump();
    this.deps.onStatusChange();
  }

  /** The transcript shows the pane idle (its newest user turn has its final reply). Self-healing backstop:
   *  releases a `paneBusy` left set by a missed Stop, with no timer. Never clears `inFlight` — a just-typed
   *  prompt may not be in the transcript yet, so clearing it here could double-inject. No `onStatusChange`:
   *  the daemon only calls this from inside its own status emit (a re-emit would just recurse). */
  noteIdleFromTranscript(): void {
    if (!this.paneBusy) return;
    this.paneBusy = false;
    void this.pump();
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
    if (this.inFlight !== undefined) return; // our own injection is still pending its open
    if (this.paneBusy) return; // Claude is mid-turn — wait for the pane to go idle
    const next = this.queue.shift();
    if (next === undefined) return;
    const seq = ++this.injectSeq;
    this.inFlight = next; // set before awaiting so a concurrent pump sees "busy"
    this.deps.onStatusChange();
    const ok = await this.deps.inject(next);
    if (this.injectSeq !== seq) return; // superseded while awaiting (interrupt/reset/re-inject) → stale
    if (!ok) {
      this.inFlight = undefined;
      this.deps.onStatusChange();
      void this.pump(); // try the next queued prompt
    }
  }

  private clearTurns(): void {
    this.inFlight = undefined;
    this.paneBusy = false;
    this.injectSeq++; // invalidate any in-flight inject() await so its late result is dropped as stale
  }
}
