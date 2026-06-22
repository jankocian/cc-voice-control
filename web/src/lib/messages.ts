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
  title: string;
  body: string;
  // Wall-clock time the turn happened, e.g. "12:34 AM".
  time: string;
};

export const MAX_LOG = 60;

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
