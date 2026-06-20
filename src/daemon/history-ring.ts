/**
 * Durable, replayable conversation history kept daemon-side so a phone that refreshes,
 * opens a 2nd browser, or reconnects after sleep can restore the whole thread — not just
 * the single latest reply the daemon used to retain.
 *
 * Pure data structure (no I/O, no protocol/network awareness) so the eviction + sequencing
 * rules are unit-testable in isolation, the same way `standalone.ts`'s `shouldReap` pulls the
 * orphan-guard decision out of its side-effectful host module.
 *
 * The ring holds the last `maxReplies` CLAUDE replies PLUS the user message(s) that
 * preceded each retained reply. Reply entries carry their synthesized audio (mp3
 * base64/mime) so it can be served on demand; user entries are text only. Every entry gets
 * a daemon-monotonic `seq` and a `timestamp` at creation, which the phone uses to merge and
 * order the thread (newest-first) while deduping against live events by `requestId`.
 */

import type { DaemonToBrowserEvent, HistoryTurn } from "../shared/protocol.js";

// Hard ceiling on retained entries, as a multiple of the reply window — guards against
// unbounded growth when turns never produce a reply (every turn interrupted, or terminal-
// typed turns whose reply never matches `inFlight`). 4× leaves room for turns with several
// user messages before their reply while still bounding a pathological backlog. See evict().
const MAX_ENTRIES_PER_REPLY = 4;

export type RingAudio = { audioBase64: string; mimeType: string };

export type RingEntry = {
  seq: number;
  timestamp: number;
  requestId: string;
  role: "user" | "claude";
  text: string;
  // Reply entries only; attached once TTS finishes (see attachAudio).
  audio?: RingAudio;
};

export class HistoryRing {
  private readonly entries: RingEntry[] = [];
  private nextSeq = 1;

  constructor(
    private readonly maxReplies: number,
    // Injected so tests get deterministic timestamps; defaults to the wall clock.
    private readonly now: () => number = Date.now
  ) {}

  /** Append a turn, stamping it with the next `seq` + a `timestamp`. Returns the entry. */
  add(role: "user" | "claude", requestId: string, text: string): RingEntry {
    const entry: RingEntry = { seq: this.nextSeq++, timestamp: this.now(), requestId, role, text };
    this.entries.push(entry);
    this.evict();
    return entry;
  }

  /**
   * Attach synthesized audio to the matching reply entry (by requestId). No-op if the
   * entry was already evicted — TTS can land after the ring has moved on.
   */
  attachAudio(requestId: string, audio: RingAudio): void {
    const entry = this.entries.find((e) => e.requestId === requestId && e.role === "claude");
    if (entry) entry.audio = audio;
  }

  /** The retained entry for `requestId`, or undefined if evicted / never recorded. */
  get(requestId: string): RingEntry | undefined {
    return this.entries.find((e) => e.requestId === requestId);
  }

  /** Oldest-first snapshot of the retained thread (for building a `history` event). */
  snapshot(): readonly RingEntry[] {
    return this.entries;
  }

  /**
   * Keep the last `maxReplies` reply entries plus the user message(s) leading up to each.
   *
   * The window of the oldest retained reply starts right after the previous (now-evicted)
   * reply: every user message between them belongs to it and is kept. So the cutoff is the
   * seq of the LAST reply we're dropping — keep everything with a strictly greater seq.
   * Anything at-or-before it (that older reply and the user messages preceding it) is
   * dropped. Keying off the dropped reply (not the kept one) is what retains the parent
   * user message(s), which sit at smaller seqs than their reply.
   */
  private evict(): void {
    const replySeqs = this.entries.filter((e) => e.role === "claude").map((e) => e.seq);
    if (replySeqs.length > this.maxReplies) {
      // replySeqs is ascending. The last reply we drop is just before the retained window.
      const cutoff = replySeqs[replySeqs.length - this.maxReplies - 1];
      let write = 0;
      for (const entry of this.entries) {
        if (entry.seq > cutoff) this.entries[write++] = entry;
      }
      this.entries.length = write;
    }
    // Reply-window eviction never triggers if replies never land, so leading user entries
    // would grow without bound. Cap the total to a small multiple of the reply window and
    // drop the oldest beyond it (text-only entries, so this is purely a memory guard).
    const maxEntries = this.maxReplies * MAX_ENTRIES_PER_REPLY;
    if (this.entries.length > maxEntries) {
      this.entries.splice(0, this.entries.length - maxEntries);
    }
  }
}

/**
 * Build the `history` event the daemon answers `sync` with: the retained thread, text only,
 * with `hasAudio` flagged per reply so the phone renders fetchable rows as tap-to-play.
 * Audio bytes are deliberately omitted — they're fetched per row via `get_audio`.
 */
export function buildHistoryEvent(ring: HistoryRing): Extract<DaemonToBrowserEvent, { type: "history" }> {
  const turns: HistoryTurn[] = ring.snapshot().map((e) => ({
    seq: e.seq,
    timestamp: e.timestamp,
    requestId: e.requestId,
    role: e.role,
    text: e.text,
    hasAudio: e.audio !== undefined
  }));
  return { type: "history", turns };
}

/**
 * Resolve a `get_audio` request against the ring. A hit returns a `tts_audio` flagged
 * `replay` (tap-to-play, never auto-play); a miss (evicted or never had audio) returns a
 * graceful `error` so the phone can tell the user the clip is gone rather than hang.
 */
export function selectAudioReply(ring: HistoryRing, requestId: string): DaemonToBrowserEvent {
  const entry = ring.get(requestId);
  if (entry?.audio) {
    return { type: "tts_audio", requestId, replay: true, ...entry.audio };
  }
  return { type: "error", requestId, message: "Audio for that reply is no longer available." };
}
