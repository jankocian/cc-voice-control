// The voice remote's turn state machine, isolated from all I/O.
//
// We never scrape the transcript for "what the user said" — Claude Code injects synthetic user-role
// records (slash markers, whole SKILL.md bodies) that poison it. Instead two hooks bracket every
// turn: UserPromptSubmit hands us the REAL prompt (`turnOpened`) and Stop hands us the reply
// (`turnClosed`). This module owns the resulting state — the inject queue, the in-flight injection,
// the open-turn FIFO, classification, dedup and stale-turn reaping — and emits its decisions through
// injected callbacks (`inject` / `speakReply` / `mirrorTypedTurn`), so it is fully unit-testable with
// a fake clock and no daemon, WebSocket, cmux or OpenAI.

// A prompt that is a slash command (`/voice-control:start`, the spawn skill, any `/…`) is a
// plugin/CLI command, not conversation — classified from the REAL prompt the hook reports.
export function isSlashCommand(prompt: string): boolean {
  return prompt.trimStart().startsWith("/");
}

export type TurnKind = "voice" | "typed" | "plugin";

type OpenTurn = { kind: TurnKind; prompt: string; openedAt: number };

// A turn open longer than this with no Stop is treated as abandoned (Claude crashed, or an interrupt
// swallowed the Stop) and reaped, so the idle-gate can release queued voice prompts. Generous: real
// agent turns can run many minutes; interrupting clears turns immediately, so this is only the
// unattended backstop.
const TURN_TTL_MS = 20 * 60 * 1000;

// Cap on the double-fired-Stop dedup set — a repeat fires within seconds, so only recent reply uuids
// matter; bounding it keeps a long-running daemon from leaking memory.
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
  // Diagnostic log line (stderr). Optional so tests stay quiet.
  log?: (message: string) => void;
  // Injectable clock so the reaper is testable. Defaults to Date.now.
  now?: () => number;
};

export class TurnCoordinator {
  // The daemon injects ONE voice prompt at a time and ONLY while Claude is idle. `inFlight` is the
  // prompt currently typed/awaited; `queue` holds voice prompts captured while Claude was busy.
  private inFlight?: string;
  private readonly queue: string[] = [];

  // `openTurns` is the FIFO of turns Claude is running (each classified from its real prompt); a reply
  // closes the oldest. `injectedPending` holds prompts WE typed, awaiting their turnOpened so we
  // recognise our own voice turns by exact content. `injectedAt` dates the current injection so a
  // prompt whose turnOpened never arrives can be reaped. `seenReplyUuids` dedups a double-fired Stop.
  private readonly openTurns: OpenTurn[] = [];
  private readonly injectedPending: string[] = [];
  private injectedAt?: number;
  private readonly seenReplyUuids = new Set<string>();

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
    // ANY close may have left the pane idle, so always try to drain a queued voice prompt — not just
    // after a voice turn. (No open turn → the daemon started mid-turn, e.g. the bootstrap
    // /voice-control:start; pump is then a safe no-op.)
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
    this.inFlight = next; // set before awaiting so a concurrent pump sees "busy"
    this.injectedAt = this.now();
    this.injectedPending.length = 0; // any leftover never opened a turn (stale) — start clean
    this.injectedPending.push(next); // turnOpened recognises this turn as ours by exact content
    this.deps.onStatusChange();
    const ok = await this.deps.inject(next);
    // While we awaited, an interrupt/reset/re-inject may have moved on — our `inFlight` is no longer
    // `next`. The result is then stale: acting on it would clobber the current injection. Drop it.
    if (this.inFlight !== next) return;
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
  }

  // Backstop: drop turns stuck longer than TURN_TTL_MS so the idle-gate can release queued voice
  // prompts. Two stuck shapes: an OPEN turn that never closed, and an INJECTED prompt whose
  // turnOpened never arrived. Reaping a voice/injection clears the injection lock.
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
