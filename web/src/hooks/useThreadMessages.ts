import { type RefObject, useCallback, useEffect, useMemo, useState } from "react";
import type { PagerThread } from "../components/ThreadPager";
import { type Message, makeMessage, messageFromHistory } from "../lib/messages";
import type { RosterThread, ThreadId } from "../lib/protocol";
import {
  DEFAULT_RUNTIME,
  EMPTY_MESSAGES,
  pruneThreadMap,
  reconcileAndPrune,
  rosterRuntime,
  updateThreadMessages
} from "../lib/thread-messages";
import type { BridgeContentEvent, BridgeRuntime } from "./useBridge";
import type { usePlayback } from "./usePlayback";
import type { useThreads } from "./useThreads";

type Deps = {
  threads: ReturnType<typeof useThreads>;
  playback: ReturnType<typeof usePlayback>;
  showFlash: (message: string) => void;
  activeThreadId: ThreadId | null;
  // Read lazily so the content handler (a stable callback) always sees the current active thread.
  activeThreadIdRef: RefObject<ThreadId | null>;
  // A daemon's spawn_pending arms the follow; the matching thread_joined (handled in App) switches to it.
  armSpawnFollow: (spawnId: string) => void;
};

// Owns the per-thread conversation state — messages + the latest session_status runtime, plus the
// "which thread's mic turn is transcribing" flag — and the reducer that routes each tagged bridge
// event into it. Returns the derived views App renders (pager pages, the active thread + its runtime).
export function useThreadMessages({
  threads,
  playback,
  showFlash,
  activeThreadId,
  activeThreadIdRef,
  armSpawnFollow
}: Deps) {
  const [messagesByThread, setMessagesByThread] = useState<Map<ThreadId, Message[]>>(new Map());
  const [runtimeByThread, setRuntimeByThread] = useState<Map<ThreadId, BridgeRuntime>>(new Map());
  // The thread whose mic turn is in flight (transcribing) — one at a time, since the mic is shared.
  const [transcribingThreadId, setTranscribingThreadId] = useState<ThreadId | null>(null);

  const { dropAudio, attachAudio, markPlayable } = playback;

  const handleContentEvent = useCallback(
    (threadId: ThreadId, event: BridgeContentEvent) => {
      switch (event.type) {
        case "session_status":
          setRuntimeByThread((prev) =>
            new Map(prev).set(threadId, {
              listening: event.state.listening === true,
              state: event.state.state,
              currentTask: event.memory?.currentTask
            })
          );
          return;
        case "transcript":
          // A mirrored turn is one the user TYPED in the terminal (not sent from the phone), so it
          // doesn't touch the phone's recording state or flash "Sent ✓" — it just joins the history.
          if (!event.mirrored && threadId === activeThreadIdRef.current) {
            setTranscribingThreadId(null);
            showFlash("Sent to Claude Code ✓");
          }
          updateThreadMessages(setMessagesByThread, threadId, (prev) =>
            reconcileAndPrune(
              prev,
              [makeMessage("You", event.text, event.requestId, { seq: event.seq, timestamp: event.timestamp })],
              dropAudio
            )
          );
          threads.noteActivity(threadId);
          return;
        case "claude_reply": {
          const message = makeMessage("Claude Code", event.text, event.requestId, {
            seq: event.seq,
            timestamp: event.timestamp
          });
          updateThreadMessages(setMessagesByThread, threadId, (prev) => reconcileAndPrune(prev, [message], dropAudio));
          threads.noteActivity(threadId);
          return;
        }
        case "history": {
          // Reconnect / refresh / 2nd browser: restore the retained thread. Merge by seq and mark
          // fetchable replies playable (tap-to-play before their bytes are requested). markPlayable is
          // keyed by requestId (globally unique), so flagging another thread's rows never bleeds here.
          const restored = event.turns.map(messageFromHistory);
          markPlayable(event.turns.filter((t) => t.hasAudio).map((t) => t.requestId));
          updateThreadMessages(setMessagesByThread, threadId, (prev) => reconcileAndPrune(prev, restored, dropAudio));
          return;
        }
        case "tts_audio":
          // Only auto-play a fresh reply for the thread the user is looking at; a reply on a background
          // thread waits for a tap. A replay is already gated to tap-to-play inside attachAudio.
          attachAudio(
            event.requestId,
            event.audioBase64,
            event.mimeType,
            event.replay === true || threadId !== activeThreadIdRef.current
          );
          return;
        case "spawn_pending":
          // A daemon (the "+" or the spawn skill) opened a new session with this id; the new thread
          // echoes it in its thread_joined → App follows it.
          armSpawnFollow(event.spawnId);
          return;
        case "error":
          if (threadId === activeThreadIdRef.current) setTranscribingThreadId(null);
          // The only error carrying a requestId is a `get_audio` miss (its reply audio was evicted) —
          // drop the row so it stops rendering a dead play button.
          if (event.requestId) dropAudio(event.requestId);
          if (threadId === activeThreadIdRef.current) showFlash(event.message);
          return;
      }
    },
    [attachAudio, dropAudio, markPlayable, showFlash, threads, activeThreadIdRef, armSpawnFollow]
  );

  // Release per-thread state for threads the roster fully dropped (a snapshot without them; a
  // greyed/offline thread stays in the roster, so its history is kept). Without it the maps would grow
  // one entry per pane ever seen. Also releases each dropped thread's cached audio.
  useEffect(() => {
    const live = new Set(threads.threads.map((t) => t.threadId));
    setRuntimeByThread((prev) => pruneThreadMap(prev, live));
    setMessagesByThread((prev) =>
      pruneThreadMap(prev, live, (messages) => {
        for (const message of messages) if (message.requestId) dropAudio(message.requestId);
      })
    );
  }, [threads.threads, dropAudio]);

  // The active thread's roster entry + runtime (its session_status, falling back to the roster snapshot
  // before the first status arrives).
  const active: RosterThread | undefined = useMemo(
    () => threads.threads.find((t) => t.threadId === activeThreadId),
    [threads.threads, activeThreadId]
  );
  const activeRuntime =
    (activeThreadId && runtimeByThread.get(activeThreadId)) || rosterRuntime(active) || DEFAULT_RUNTIME;

  // Pager pages: each thread with its (newest-first) messages. Empty until its history/turns land.
  const pagerThreads: PagerThread[] = useMemo(
    () =>
      threads.threads.map((thread) => ({
        threadId: thread.threadId,
        messages: messagesByThread.get(thread.threadId) ?? EMPTY_MESSAGES
      })),
    [threads.threads, messagesByThread]
  );

  const transcribing = transcribingThreadId !== null && transcribingThreadId === activeThreadId;

  return { handleContentEvent, active, activeRuntime, pagerThreads, transcribing, setTranscribingThreadId };
}
