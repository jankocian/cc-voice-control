import { useCallback, useMemo, useState } from "react";
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
  // A content turn landed for a thread → bump its unread badge unless it's the active one.
  noteActivity: (threadId: ThreadId) => void;
  // Focus a thread (pill / dropdown / swipe). Clears its unread badge.
  setActive: (threadId: ThreadId) => void;
};

// React owner of the per-thread store (roster + unread + active). All mutation goes through
// the pure reducers in lib/threads so the rules stay testable; this hook is just the React
// binding + the roster-event dispatch.
export function useThreads(): Threads {
  const [state, setState] = useState<ThreadsState>(initialThreadsState);

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

  const noteActivity = useCallback((threadId: ThreadId): void => {
    setState((prev) => bumpUnread(prev, threadId));
  }, []);

  const setActive = useCallback((threadId: ThreadId): void => {
    setState((prev) => switchThread(prev, threadId));
  }, []);

  const unread = useMemo(() => state.unread, [state.unread]);

  return {
    threads: state.threads,
    activeThreadId: state.activeThreadId,
    unread,
    applyRosterEvent,
    noteActivity,
    setActive
  };
}
