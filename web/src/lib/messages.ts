// The activity log model. Every row is a conversational turn the daemon projected from Claude's
// transcript (see src/daemon/transcript-projection.ts) and sent in a `history` snapshot; `id` is the
// turn's native uuid, so audio attaches to it and a turn re-sent in a later snapshot never duplicates.

import type { HistoryTurn } from "./protocol";

export type MessageKind = "you" | "claude";

// Delivery state of one of YOUR messages, WhatsApp-style. Optimistic rows (shown before the transcript
// catches up) are "queued" (clock) or "accepted" (one check); a native row projected from Claude's
// transcript is "logged" (two checks — it's in Claude's history). Only "you" rows carry it.
export type Delivery = "queued" | "accepted" | "logged";

export type Message = {
  // Stable render key = the turn's native transcript uuid (the daemon's requestId). Audio is keyed to it.
  // Optimistic (not-yet-in-transcript) rows use a synthetic `opt:` id until their native row lands.
  id: string;
  kind: MessageKind;
  requestId: string;
  // Delivery indicator for a "you" row (see Delivery). Undefined for claude rows.
  delivery?: Delivery;
  // Native transcript timestamp (epoch ms). The thread is ordered newest-first by this — stable across
  // daemon restarts (unlike the old daemon-monotonic seq).
  timestamp: number;
  // True for a reply whose audio the daemon still retains (fetchable on demand). Drives tap-to-play.
  hasAudio?: boolean;
  // A "step": Claude's narration before a tool call. Rendered dimmer; tap-to-play synthesizes on demand.
  interim?: boolean;
  title: string;
  body: string;
  // Wall-clock time the turn happened, e.g. "12:34 AM".
  time: string;
};

export const MAX_LOG = 60;

// Build a Message from a projected history turn. A user turn is in Claude's transcript → "logged".
export function messageFromHistory(turn: HistoryTurn): Message {
  return {
    id: turn.requestId,
    kind: turn.role === "user" ? "you" : "claude",
    requestId: turn.requestId,
    delivery: turn.role === "user" ? "logged" : undefined,
    timestamp: turn.timestamp,
    hasAudio: turn.hasAudio,
    interim: turn.interim === true,
    title: turn.role === "user" ? "You" : "Claude Code",
    body: turn.text,
    time: formatClock(turn.timestamp)
  };
}

// Optimistic outgoing rows: shown the instant the daemon reports a prompt_status, before the authoritative
// native row lands in `history`. Keyed by a synthetic `opt:` id so they never collide with native uuids.
const OPT_PREFIX = "opt:";
let optCounter = 0;
const DELIVERY_RANK: Record<Delivery, number> = { queued: 0, accepted: 1, logged: 2 };

export function isOptimistic(message: Message): boolean {
  return message.id.startsWith(OPT_PREFIX);
}

// Add or advance the optimistic "you" row for `text`. The same message goes queued → accepted, so we update
// the existing row in place (keeping its id/timestamp) rather than stacking a second bubble; delivery only
// ever advances (a stale earlier state can't downgrade it).
export function upsertOptimistic(
  prev: readonly Message[],
  text: string,
  state: "queued" | "accepted",
  now: number
): Message[] {
  const key = text.trim();
  const i = prev.findIndex((m) => isOptimistic(m) && m.body.trim() === key);
  if (i >= 0) {
    if (DELIVERY_RANK[state] <= DELIVERY_RANK[prev[i].delivery ?? "queued"]) return [...prev];
    const next = [...prev];
    next[i] = { ...next[i], delivery: state };
    return next;
  }
  const id = `${OPT_PREFIX}${now}-${optCounter++}`;
  return [
    ...prev,
    {
      id,
      kind: "you",
      requestId: id,
      delivery: state,
      timestamp: now,
      title: "You",
      body: text,
      time: formatClock(now)
    }
  ];
}

// The optimistic rows in `prev` NOT yet covered by a native user row in `native` — i.e. still in flight. A
// native turn CONTAINS the optimistic text (exact for a normal turn; a glued "A.B" contains "A"), so once it
// lands the placeholder is dropped and the native "logged" row renders instead. ponytail: substring match —
// a duplicate short phrase could drop a placeholder a beat early, never a real row.
export function unreconciledOptimistic(prev: readonly Message[], native: readonly Message[]): Message[] {
  const nativeUser = native.filter((m) => m.kind === "you").map((m) => m.body.trim());
  return prev.filter((m) => isOptimistic(m) && !nativeUser.some((t) => t.includes(m.body.trim())));
}

// "12:34 AM" from an epoch-ms timestamp (the daemon's native record time, so all clients agree).
function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Play-on-land: the newest incoming reply to autoplay when landing on a thread that had unread. `messages`
// is newest-first (see buildThread), so the first non-interim Claude turn with a requestId is the one. A
// step ("interim") narration or a user turn never plays. Returns its requestId, or null if none.
export function newestPlayableReply(messages: readonly Message[]): string | null {
  const reply = messages.find((m) => m.kind === "claude" && !m.interim && Boolean(m.requestId));
  return reply?.requestId ?? null;
}

/**
 * The daemon's `history` snapshot is the complete, deduped thread (it re-projects Claude's transcript on
 * every event), so the phone just orders it newest-first and caps it — no merge, no seq. We dedupe by
 * native uuid defensively (a snapshot should never contain a dup) and order by native timestamp, which is
 * monotonic across daemon restarts, so the thread can never reorder.
 */
export function buildThread(turns: readonly Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const turn of turns) byId.set(turn.requestId, turn); // later wins (defensive)
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_LOG);
}
