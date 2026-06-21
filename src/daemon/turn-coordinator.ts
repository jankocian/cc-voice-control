// The voice remote's turn state machine, isolated from all I/O. Two hooks bracket every turn —
// UserPromptSubmit gives the REAL prompt (`turnOpened`), Stop gives the reply (`turnClosed`) — because
// the transcript can't be trusted for either (Claude Code injects synthetic user-role records: slash
// markers, whole SKILL.md bodies). Decisions are emitted through injected callbacks, so the whole
// machine is unit-testable with a fake clock and no daemon/cmux/WebSocket/OpenAI.

// A slash command (`/voice-control:start`, the spawn skill, any `/…`) is a plugin/CLI command, not
// conversation.
export function isSlashCommand(prompt: string): boolean {
  return prompt.trimStart().startsWith("/");
}

export type TurnKind = "voice" | "typed" | "plugin";

type OpenTurn = { kind: TurnKind; prompt: string; openedAt: number };

// A turn open this long with no Stop is treated as abandoned and reaped, so the idle-gate can release
// queued prompts. Generous: real agent turns run minutes; this is only the unattended backstop.
const TURN_TTL_MS = 20 * 60 * 1000;

// Bound the double-fired-Stop dedup set (a repeat fires within seconds) so the daemon can't leak.
const REPLY_UUID_CAP = 100;

export type TurnCoordinatorDeps = {
  // Type `text` into the pane (cmux). Resolves true on success. Called only when Claude is idle.
  inject: (text: string) => Promise<boolean>;
  // A finished VOICE turn (one we injected): speak its reply.
  speakReply: (reply: string) => void;
  // A finished TYPED turn (the user keyed it in the terminal): show their real prompt + speak it.
  mirrorTypedTurn: (prompt: string, reply: string) => void;
  // The working/idle state changed → the daemon re-emits status.
  onStatusChange: () => void;
  log?: (message: string) => void;
  now?: () => number; // injectable clock so the reaper is testable
};

export class TurnCoordinator {
  // We inject ONE voice prompt at a time, only while Claude is idle. `inFlight` is the prompt awaited;
  // `queue` holds prompts captured while Claude was busy.
  private inFlight?: string;
  private readonly queue: string[] = [];

  // `openTurns`: FIFO of running turns (a reply closes the oldest). `injectedPending`: prompts WE typed,
  // awaiting their turnOpened so we recognise our own voice turns by exact content. `injectedAt`: when
  // the current injection went out, so one whose turnOpened never arrives can be reaped.
  private readonly openTurns: OpenTurn[] = [];
  private readonly injectedPending: string[] = [];
  private injectedAt?: number;
  private readonly seenReplyUuids = new Set<string>();

  // Identity token for the current injection, bumped on every inject AND clearTurns. pump() captures it
  // before awaiting inject() and re-checks after, so a late result is recognised as stale by IDENTITY,
  // not by the prompt string (the canned status/summary prompts repeat).
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

  /** A turn STARTED (UserPromptSubmit, with the real prompt). Classify it and reflect "working". */
  turnOpened(prompt: string): void {
    this.reapStaleTurns();
    this.openTurns.push({ kind: this.classify(prompt), prompt, openedAt: this.now() });
    this.deps.onStatusChange();
  }

  /** A turn FINISHED (Stop, with the reply). Pair it with the oldest open turn and act on its kind. */
  turnClosed(reply: string, replyUuid?: string): void {
    if (replyUuid) {
      if (this.seenReplyUuids.has(replyUuid)) return; // double-fired Stop
      this.seenReplyUuids.add(replyUuid);
      if (this.seenReplyUuids.size > REPLY_UUID_CAP) {
        const oldest = this.seenReplyUuids.values().next().value;
        if (oldest !== undefined) this.seenReplyUuids.delete(oldest);
      }
    }
    const turn = this.openTurns.shift();
    if (turn?.kind === "voice") {
      this.log(`voice reply, ${reply.length} chars`);
      this.inFlight = undefined; // our injection completed → release the next queued voice prompt
      this.injectedAt = undefined;
      if (reply) this.deps.speakReply(reply);
    } else if (turn?.kind === "typed") {
      this.log(`typed reply, ${reply.length} chars`);
      if (reply) this.deps.mirrorTypedTurn(turn.prompt, reply);
    } else if (turn) {
      this.log("plugin turn ignored");
    }
    // ANY close may have idled the pane → always try to drain the queue (no open turn = daemon started
    // mid-turn, e.g. the bootstrap /voice-control:start; pump is then a no-op).
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

  private classify(prompt: string): TurnKind {
    const trimmed = prompt.trim();
    if (this.injectedPending.length > 0 && this.injectedPending[0].trim() === trimmed) {
      this.injectedPending.shift(); // exact content match — we typed those bytes
      return "voice";
    }
    return isSlashCommand(prompt) ? "plugin" : "typed";
  }

  private async pump(): Promise<void> {
    this.reapStaleTurns(); // free the queue if a previous turn hung — else the idle-gate blocks forever
    if (this.inFlight !== undefined) return; // our own injection is still pending
    if (this.openTurns.length > 0) return; // Claude is mid-turn — wait for the pane to go idle
    const next = this.queue.shift();
    if (next === undefined) return;
    const seq = ++this.injectSeq;
    this.inFlight = next; // set before awaiting so a concurrent pump sees "busy"
    this.injectedAt = this.now();
    this.injectedPending.length = 0; // any leftover never opened a turn (stale) — start clean
    this.injectedPending.push(next); // turnOpened recognises this turn as ours by exact content
    this.deps.onStatusChange();
    const ok = await this.deps.inject(next);
    if (this.injectSeq !== seq) return; // superseded while awaiting (interrupt/reset/re-inject) → stale
    if (!ok) {
      this.inFlight = undefined;
      this.injectedAt = undefined;
      this.injectedPending.pop();
      this.deps.onStatusChange();
      void this.pump(); // try the next queued prompt
    }
  }

  private clearTurns(): void {
    this.inFlight = undefined;
    this.injectedAt = undefined;
    this.openTurns.length = 0;
    this.injectedPending.length = 0;
    this.injectSeq++; // invalidate any in-flight inject() await so its late result is dropped as stale
  }

  // Backstop: drop turns stuck past TURN_TTL_MS so the idle-gate can release queued prompts. Two stuck
  // shapes: an OPEN turn that never closed, and an INJECTED prompt whose turnOpened never arrived.
  private reapStaleTurns(): void {
    const cutoff = this.now() - TURN_TTL_MS;
    while (this.openTurns.length > 0 && this.openTurns[0].openedAt < cutoff) {
      const stale = this.openTurns.shift();
      if (stale?.kind === "voice") {
        this.inFlight = undefined;
        this.injectedAt = undefined;
      }
      this.log("reaped a stale open turn");
    }
    if (
      this.inFlight !== undefined &&
      this.injectedPending.length > 0 &&
      this.injectedAt !== undefined &&
      this.injectedAt < cutoff
    ) {
      this.log("reaped a stuck injection (no turn-open arrived)");
      this.inFlight = undefined;
      this.injectedAt = undefined;
      this.injectedPending.length = 0;
    }
  }

  private log(message: string): void {
    this.deps.log?.(`[turn] ${message}`);
  }
}
