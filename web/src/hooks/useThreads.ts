import { useCallback, useState } from "react";
import type { RosterEvent, RosterThread, ThreadId } from "../lib/protocol";
import {
  applyJoined,
  applyLeft,
  applyRoster,
  bumpUnread,
  initialThreadsState,
  switchThread,
  type ThreadsState
} from "../lib/threads";

export type Threads = {
  threads: RosterThread[];
  activeThreadId: ThreadId | null;
  unread: ReadonlyMap<ThreadId, number>;
  // Fold a roster snapshot / join / leave delta into the thread list (presence + labels).
  applyRosterEvent: (event: RosterEvent) => void;
  // `count` new turns landed for a thread → add to its unread badge unless it's the active one.
  noteActivity: (threadId: ThreadId, count?: number) => void;
  // Focus a thread (pill / dropdown / swipe). Clears its unread badge.
  setActive: (threadId: ThreadId) => void;
};

// React owner of the per-thread store (roster + unread + active). All mutation goes through
// the pure reducers in lib/threads so the rules stay testable; this hook is just the React
// binding + the roster-event dispatch.
// `preferredThreadId` (from the URL fragment) is the thread to restore on first load — seeded into the
// store so the roster snapshot focuses it directly (no post-render switch / swipe blip).
export function useThreads(preferredThreadId?: string | null): Threads {
  const [state, setState] = useState<ThreadsState>(() => ({ ...initialThreadsState, preferredThreadId }));

  const applyRosterEvent = useCallback((event: RosterEvent): void => {
    setState((prev) => {
      switch (event.type) {
        case "thread_roster":
          return applyRoster(prev, event.threads);
        case "thread_joined":
          return applyJoined(prev, event.thread);
        case "thread_left":
          return applyLeft(prev, event.threadId, event.lastSeenAt);
      }
    });
  }, []);

  const noteActivity = useCallback((threadId: ThreadId, count = 1): void => {
    setState((prev) => bumpUnread(prev, threadId, count));
  }, []);

  const setActive = useCallback((threadId: ThreadId): void => {
    setState((prev) => switchThread(prev, threadId));
  }, []);

  return {
    threads: state.threads,
    activeThreadId: state.activeThreadId,
    unread: state.unread,
    applyRosterEvent,
    noteActivity,
    setActive
  };
}
