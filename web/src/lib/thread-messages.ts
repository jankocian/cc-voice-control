import type { Dispatch, SetStateAction } from "react";
import type { BridgeRuntime } from "../hooks/useBridge";
import { type Message, reconcileMessages } from "./messages";
import type { RosterThread, ThreadId } from "./protocol";

// A thread with no session_status yet falls back to its roster snapshot for the runtime; currentTask
// only arrives via session_status, so it's undefined until the first one.
export const DEFAULT_RUNTIME: BridgeRuntime = { state: "idle", currentTask: undefined, listening: true };

// A stable empty array so threads with no messages yet don't churn the pager memo.
export const EMPTY_MESSAGES: Message[] = [];

// Fall back to a thread's roster snapshot (state/listening) before its first session_status arrives.
export function rosterRuntime(thread: RosterThread | undefined): BridgeRuntime | undefined {
  if (!thread) return undefined;
  return { state: thread.state, listening: thread.listening, currentTask: undefined };
}

// Apply a message-list update to one thread in the per-thread Map (immutably, so React re-renders).
export function updateThreadMessages(
  setMap: Dispatch<SetStateAction<Map<ThreadId, Message[]>>>,
  threadId: ThreadId,
  update: (prev: Message[]) => Message[]
): void {
  setMap((prev) => {
    const next = new Map(prev);
    next.set(threadId, update(prev.get(threadId) ?? []));
    return next;
  });
}

// Reconcile incoming rows into the thread (merge/dedup/order by seq), then drop cached audio for any
// row that fell out of the capped window — preserving the bounded-memory pruning.
export function reconcileAndPrune(
  prev: Message[],
  incoming: Message[],
  dropAudio: (requestId: string) => void
): Message[] {
  const next = reconcileMessages(prev, incoming);
  const kept = new Set(next.map((m) => m.requestId).filter((id): id is string => id !== undefined));
  for (const message of prev) {
    if (message.requestId && !kept.has(message.requestId)) dropAudio(message.requestId);
  }
  return next;
}

// Drop entries whose threadId is no longer in `live`; returns the same map ref when nothing changed (so
// it never forces a re-render). `onDrop` releases any resource the evicted value held.
export function pruneThreadMap<V>(
  map: Map<ThreadId, V>,
  live: ReadonlySet<ThreadId>,
  onDrop?: (value: V) => void
): Map<ThreadId, V> {
  let next: Map<ThreadId, V> | null = null;
  for (const [threadId, value] of map) {
    if (live.has(threadId)) continue;
    next ??= new Map(map);
    next.delete(threadId);
    onDrop?.(value);
  }
  return next ?? map;
}
