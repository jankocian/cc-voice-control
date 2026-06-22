// Pure per-thread state for the multi-session switcher (#7). The browser multiplexes one
// socket for every thread, so the app holds N conversations at once: the roster (which
// threads exist + their presence) plus per-thread messages and an unread count. Keeping the
// route-by-threadId / unread / roster-upsert rules here (no React, no DOM) makes them unit-
// testable and keeps `useThreads`/`App` thin. Messages stay a separate Map so this file owns
// only the bookkeeping; `reconcileMessages` (lib/messages) owns the merge of message rows.

import type { RosterThread, ThreadId } from "./protocol";

// The whole multi-thread store. `threads` is the roster order shown in the switcher + the
// swipe pager; `activeThreadId` is the one the shared mic/player act on; `unread` counts
// replies that landed while a thread was in the background (cleared on switch).
export type ThreadsState = {
  threads: RosterThread[];
  activeThreadId: ThreadId | null;
  unread: Map<ThreadId, number>;
  // The thread to focus on first load when it's present (from the URL fragment — see readThreadHint),
  // so resuming the saved thread happens BEFORE the carousel renders, with no swipe blip. Only used by
  // pickActive on a roster snapshot; ignored once a thread is active.
  preferredThreadId?: ThreadId | null;
};

export const initialThreadsState: ThreadsState = {
  threads: [],
  activeThreadId: null,
  unread: new Map()
};

// Replace the whole roster (a `thread_roster` snapshot on connect). Preserve the active
// thread if it's still present; otherwise fall back to the first thread so the UI always has
// a focused pane. Unread counts for threads no longer in the roster are dropped.
export function applyRoster(state: ThreadsState, threads: readonly RosterThread[]): ThreadsState {
  const next = sortRoster(threads);
  const ids = new Set(next.map((t) => t.threadId));
  const activeThreadId = pickActive(state.activeThreadId, next, ids, state.preferredThreadId);
  return { ...state, threads: next, activeThreadId, unread: pruneUnread(state.unread, ids) };
}

// Upsert one thread (a `thread_joined` — both first-seen AND a label/state/presence refresh).
// Keyed by threadId: replace in place if known, else append. A first thread becomes active so
// the single-thread UX has a focused pane immediately.
export function applyJoined(state: ThreadsState, thread: RosterThread): ThreadsState {
  const index = state.threads.findIndex((t) => t.threadId === thread.threadId);
  const merged = index >= 0 ? state.threads.map((t, i) => (i === index ? thread : t)) : [...state.threads, thread];
  const activeThreadId = state.activeThreadId ?? thread.threadId;
  return { ...state, threads: sortRoster(merged), activeThreadId };
}

// A thread's daemon dropped (`thread_left`). Keep the thread in the roster (so it greys out
// and #10 grades it offline by `lastSeenAt`) rather than removing it — the daemon may
// reconnect, and yanking the active pane mid-read would be jarring. Just flip presence.
export function applyLeft(state: ThreadsState, threadId: ThreadId, lastSeenAt: number): ThreadsState {
  const threads = state.threads.map((t) => (t.threadId === threadId ? { ...t, connected: false, lastSeenAt } : t));
  return { ...state, threads: sortRoster(threads) };
}

// `count` genuinely-new messages arrived for `threadId`. If it's not the active thread, add them to its
// unread badge; the active thread is already on-screen so it never counts. The CALLER only passes new
// messages (not a reconnect/restore), so a refresh doesn't inflate the badge — see useThreadMessages.
export function bumpUnread(state: ThreadsState, threadId: ThreadId, count = 1): ThreadsState {
  if (threadId === state.activeThreadId || count <= 0) return state;
  const unread = new Map(state.unread);
  unread.set(threadId, (unread.get(threadId) ?? 0) + count);
  return { ...state, unread };
}

// Switch the focused thread (pill tap / swipe settle / dropdown select). Clears the target's
// unread badge — switching to a thread is reading it. No-op if it's already active or unknown.
export function switchThread(state: ThreadsState, threadId: ThreadId): ThreadsState {
  if (threadId === state.activeThreadId) return state;
  if (!state.threads.some((t) => t.threadId === threadId)) return state;
  const unread = clearUnread(state.unread, threadId);
  return { ...state, activeThreadId: threadId, unread };
}

export function unreadFor(state: ThreadsState, threadId: ThreadId): number {
  return state.unread.get(threadId) ?? 0;
}

export function activeThread(state: ThreadsState): RosterThread | undefined {
  return state.threads.find((t) => t.threadId === state.activeThreadId);
}

// Offline threads (no live daemon) sort to the END so the switcher list, swipe dots, and pager all lead
// with the actionable ones; everything else keeps its existing (≈ join/creation) order. Stable —
// Array.prototype.sort preserves the prior order within each group.
function sortRoster(threads: readonly RosterThread[]): RosterThread[] {
  return [...threads].sort((a, b) => Number(!a.connected) - Number(!b.connected));
}

// Keep the same active thread across a roster swap when it survives; else restore the saved (preferred)
// thread if it's present, else focus the first CONNECTED thread (so we never default into a
// dormant/offline pane), falling back to the first if none are live.
function pickActive(
  current: ThreadId | null,
  threads: readonly RosterThread[],
  ids: Set<ThreadId>,
  preferred?: ThreadId | null
): ThreadId | null {
  if (current && ids.has(current)) return current;
  if (preferred && ids.has(preferred)) return preferred;
  return (threads.find((t) => t.connected) ?? threads[0])?.threadId ?? null;
}

function pruneUnread(unread: Map<ThreadId, number>, keep: Set<ThreadId>): Map<ThreadId, number> {
  const next = new Map<ThreadId, number>();
  for (const [id, count] of unread) if (keep.has(id)) next.set(id, count);
  return next;
}

function clearUnread(unread: Map<ThreadId, number>, threadId: ThreadId): Map<ThreadId, number> {
  if (!unread.has(threadId)) return unread;
  const next = new Map(unread);
  next.delete(threadId);
  return next;
}
