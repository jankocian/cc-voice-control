// The activity log model. Only the user's transcript and Claude's real reply are
// ever logged (errors surface as transient flashes, not log rows) — matching the
// vanilla client's deliberately clean log.

import type { HistoryTurn } from "./protocol";

export type MessageKind = "you" | "claude" | "system" | "error";

export type Message = {
  // Stable key for rendering. For Claude replies this is the daemon requestId so
  // audio can be attached/looked up; otherwise a generated id.
  id: string;
  kind: MessageKind;
  // The daemon requestId, present for Claude replies (drives playback + sync).
  requestId?: string;
  // Daemon-monotonic sequence number, present for daemon-originated turns (transcript /
  // claude_reply / history). Reconciliation merges + orders the thread by this. Absent for
  // purely local rows (none today), which keep insertion order at the top.
  seq?: number;
  // Daemon creation time (epoch ms), present alongside seq.
  timestamp?: number;
  // True for a reply whose audio the daemon still retains (fetchable on demand). Drives
  // tap-to-play rendering for history rows whose bytes haven't been fetched yet.
  hasAudio?: boolean;
  title: string;
  body: string;
  // Wall-clock time the row was created, e.g. "12:34 AM" (captured once).
  time: string;
};

export const MAX_LOG = 60;

const TITLE_TO_KIND: Record<string, MessageKind> = {
  You: "you",
  "Claude Code": "claude"
};

let counter = 0;

export function makeMessage(
  title: string,
  body: string,
  requestId?: string,
  meta?: { seq?: number; timestamp?: number; hasAudio?: boolean }
): Message {
  const time = formatClock(meta?.timestamp);
  counter += 1;
  return {
    id: requestId ?? `m${counter}`,
    kind: TITLE_TO_KIND[title] ?? "system",
    requestId,
    seq: meta?.seq,
    timestamp: meta?.timestamp,
    hasAudio: meta?.hasAudio,
    title,
    body,
    time
  };
}

// Build a Message from a retained history turn (text only; audio fetched on demand).
export function messageFromHistory(turn: HistoryTurn): Message {
  return makeMessage(turn.role === "user" ? "You" : "Claude Code", turn.text, turn.requestId, {
    seq: turn.seq,
    timestamp: turn.timestamp,
    hasAudio: turn.hasAudio
  });
}

// "12:34 AM" from an epoch-ms timestamp (the daemon's, so all clients agree), falling back
// to the local clock for rows that carry no daemon timestamp.
function formatClock(timestamp?: number): string {
  const date = timestamp !== undefined ? new Date(timestamp) : new Date();
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Merge incoming rows into the thread and return it newest-first.
 *
 * This is the single reconciliation point that makes history durable: the daemon's
 * `history` event (on reconnect) and the live `transcript`/`claude_reply` events both flow
 * through here, so a refresh or a 2nd browser restores the full thread while live turns
 * still append. Daemon turns carry a unique `seq` *and* a unique `requestId` (1:1), so
 * either fully dedups a turn echoed live and later seen in a history snapshot. Rules:
 *
 *  - Dedup daemon rows by `seq` (also keyed by `requestId`/`id` to be safe). A later
 *    occurrence wins, so history's `hasAudio` can upgrade an earlier live row (and a live
 *    `claude_reply` can refresh a history row).
 *  - Dedup seq-less rows (none today; defensive) by `requestId` then `id`.
 *  - Order by `seq` descending (newest first). Seq-less rows sort above everything in
 *    insertion order, mirroring today's prepend-newest behaviour.
 *  - Cap at MAX_LOG, dropping the oldest (tail) rows.
 */
export function reconcileMessages(existing: readonly Message[], incoming: readonly Message[]): Message[] {
  // Keys a row dedups on: seq (daemon turns) plus requestId/id (React-key uniqueness).
  const keysOf = (m: Message): string[] => {
    const keys: string[] = [];
    if (m.seq !== undefined) keys.push(`seq:${m.seq}`);
    if (m.requestId) keys.push(`req:${m.requestId}`);
    keys.push(`id:${m.id}`);
    return keys;
  };

  // winners: key -> the latest row claiming that key. order: rows in first-seen order, so
  // seq-less rows preserve insertion order.
  const winners = new Map<string, Message>();
  const order: Message[] = [];

  const absorb = (message: Message): void => {
    const keys = keysOf(message);
    // Remove any earlier rows this message supersedes (shared key) before adding it, so a
    // live row and a later history row for the same turn collapse to one.
    const superseded = new Set<Message>();
    for (const key of keys) {
      const prev = winners.get(key);
      if (prev) superseded.add(prev);
    }
    if (superseded.size > 0) {
      for (let i = order.length - 1; i >= 0; i--) if (superseded.has(order[i])) order.splice(i, 1);
    }
    for (const key of keys) winners.set(key, message);
    order.push(message);
  };

  for (const message of existing) absorb(message);
  for (const message of incoming) absorb(message);

  // Stable newest-first sort: seq-less rows first (insertion order), then by seq desc.
  // Array#sort is stable in modern engines (ES2019+), so equal-rank rows keep their order.
  const sorted = [...order].sort(compareNewestFirst);
  return sorted.slice(0, MAX_LOG);
}

// Newest-first: a seq-less row sorts before any sequenced one; otherwise higher seq first.
// Equal-rank pairs return 0 so the stable sort preserves insertion order.
function compareNewestFirst(a: Message, b: Message): number {
  if (a.seq === undefined && b.seq === undefined) return 0;
  if (a.seq === undefined) return -1;
  if (b.seq === undefined) return 1;
  return b.seq - a.seq;
}
