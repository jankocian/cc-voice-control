// The activity log model. Every row is a conversational turn the daemon projected from Claude's
// transcript (see src/daemon/transcript-projection.ts) and sent in a `history` snapshot; `id` is the
// turn's native uuid, so audio attaches to it and a turn re-sent in a later snapshot never duplicates.

import type { HistoryTurn } from "./protocol";

export type MessageKind = "you" | "claude";

export type Message = {
  // Stable render key = the turn's native transcript uuid (the daemon's requestId). Audio is keyed to it.
  id: string;
  kind: MessageKind;
  requestId: string;
  // Native transcript timestamp (epoch ms). The thread is ordered newest-first by this — stable across
  // daemon restarts (unlike the old daemon-monotonic seq).
  timestamp: number;
  // True for a reply whose audio the daemon still retains (fetchable on demand). Drives tap-to-play.
  hasAudio?: boolean;
  // A "step": Claude's narration before a tool call. Rendered dimmer; tap-to-play synthesizes on demand.
  interim?: boolean;
  // A local "sending…" placeholder for the user's just-spoken words (from an stt_echo), shown instantly
  // until the authoritative projection includes the real turn. Never authoritative; never has audio.
  pending?: boolean;
  title: string;
  body: string;
  // Wall-clock time the turn happened, e.g. "12:34 AM".
  time: string;
};

export const MAX_LOG = 60;

// An optimistic "you" placeholder built from an stt_echo — shown the instant we have the transcribed
// words, before the inject→transcript→projection round-trip lands. `id` is local (never a transcript
// uuid), so it can't collide with a real row; `mergeEchoes` drops it once the real turn appears.
export function echoMessage(id: string, text: string, timestamp: number): Message {
  return {
    id,
    kind: "you",
    requestId: "", // not a transcript row → no audio, never a play target
    timestamp,
    pending: true,
    title: "You",
    body: text,
    time: formatClock(timestamp)
  };
}

// The echoes not yet reflected by a real user turn in `messages`. Match is substring — a real turn that
// CONTAINS the echo text resolves it — so a merged/glued prompt ("A" + "B" → one "A.B" row) reconciles both
// echoes. Used both to prune echo state once turns land and to decide what still renders. Pure.
export function unresolvedEchoes(echoes: readonly Message[], messages: readonly Message[]): Message[] {
  if (echoes.length === 0) return echoes as Message[];
  const userTexts = messages.filter((m) => m.kind === "you").map((m) => m.body.trim());
  return echoes.filter((e) => !userTexts.some((t) => t.includes(e.body.trim())));
}

// Merge optimistic echo placeholders into the authoritative (newest-first) thread for display: unresolved
// echoes render at the top (the most recent thing the user did), above the projected turns. Pure.
export function mergeEchoes(messages: readonly Message[], echoes: readonly Message[]): Message[] {
  const unresolved = unresolvedEchoes(echoes, messages);
  if (unresolved.length === 0) return messages as Message[];
  return [...unresolved].sort((a, b) => b.timestamp - a.timestamp).concat(messages);
}

// Build a Message from a projected history turn.
export function messageFromHistory(turn: HistoryTurn): Message {
  return {
    id: turn.requestId,
    kind: turn.role === "user" ? "you" : "claude",
    requestId: turn.requestId,
    timestamp: turn.timestamp,
    hasAudio: turn.hasAudio,
    interim: turn.interim === true,
    title: turn.role === "user" ? "You" : "Claude Code",
    body: turn.text,
    time: formatClock(turn.timestamp)
  };
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
