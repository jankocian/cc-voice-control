// The voice remote's INJECTION queue + idle-gate, isolated from all I/O so it's unit-testable with a fake
// clock. The transcript is the source of truth for the CONVERSATION (see transcript-projection.ts); this
// owns only the voice side: queue spoken prompts and type them into the pane ONE AT A TIME, while Claude
// is idle. It tracks whether a turn is open (Claude working) purely to gate injection and drive the lamp —
// there is no reply pairing, dedup, or mirroring here; the daemon decides TTS and the phone view straight
// from the transcript, so a miscounted turn is at worst a cosmetic lamp blip the reaper clears, never a
// wrong/duplicated/misordered message.

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

type OpenTurn = { prompt: string; openedAt: number };

export class TurnCoordinator {
  // We inject ONE voice prompt at a time, only while Claude is idle. `inFlight` is the prompt we just
  // typed and are waiting to see open as a turn; `queue` holds prompts captured while Claude was busy.
  private inFlight?: string;
  private injectedAt?: number;
  private readonly queue: string[] = [];

  // Open turns (between a UserPromptSubmit and its Stop), oldest-first — Claude finishes a pane's turns in
  // order. Only the COUNT matters (idle-gate + lamp); `prompt` is kept so we can recognise our own
  // injection landing and so the reaper can log something meaningful.
  private readonly openTurns: OpenTurn[] = [];

  // Identity token for the current injection, bumped on every inject AND clear. pump() captures it before
  // awaiting inject() and re-checks after, so a late result is recognised as stale by IDENTITY, not by the
  // prompt string (the canned status/summary prompts repeat).
  private injectSeq = 0;

  private readonly now: () => number;

  constructor(private readonly deps: TurnCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Claude is working while any turn is open OR a voice prompt we injected is awaiting its open. */
  isWorking(): boolean {
    return this.openTurns.length > 0 || this.inFlight !== undefined;
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

  /** A turn STARTED (UserPromptSubmit). Mark "working"; if it's our injection landing, retire `inFlight`. */
  turnOpened(prompt: string): void {
    this.reapStaleTurns();
    const trimmed = prompt.trim();
    if (this.inFlight !== undefined && this.inFlight.trim() === trimmed) {
      // Our injected prompt is now a real open turn — stop counting it as in-flight (the open turn itself
      // keeps the idle-gate closed until its Stop).
      this.inFlight = undefined;
      this.injectedAt = undefined;
    }
    this.openTurns.push({ prompt, openedAt: this.now() });
    this.deps.onStatusChange();
  }

  /** A turn FINISHED (Stop). Drop the oldest open turn (Claude finishes in order) and drain the queue. */
  turnClosed(): void {
    this.openTurns.shift();
    void this.pump();
    this.deps.onStatusChange();
  }

  /** The user Esc'd the running turn (the daemon does the Esc): drop all turns, run the queue. */
  interrupt(): void {
    this.clearTurns();
    this.deps.onStatusChange(); // isWorking just went false; pump() below no-ops on an empty queue
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
    if (this.openTurns.length > 0) return; // Claude is mid-turn — wait for the pane to go idle
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
    this.openTurns.length = 0;
    this.injectSeq++; // invalidate any in-flight inject() await so its late result is dropped as stale
  }

  // Backstop: drop turns stuck past TURN_TTL_MS so the idle-gate can release queued prompts. Two stuck
  // shapes: an OPEN turn that never closed, and an INJECTED prompt whose turnOpened never arrived.
  private reapStaleTurns(): void {
    const cutoff = this.now() - TURN_TTL_MS;
    while (this.openTurns.length > 0 && this.openTurns[0].openedAt < cutoff) {
      this.openTurns.shift();
      this.log("reaped a stale open turn");
    }
    if (this.inFlight !== undefined && this.injectedAt !== undefined && this.injectedAt < cutoff) {
      this.log("reaped a stuck injection (no turn-open arrived)");
      this.inFlight = undefined;
      this.injectedAt = undefined;
    }
  }

  private log(message: string): void {
    this.deps.log?.(`[voice] ${message}`);
  }
}
