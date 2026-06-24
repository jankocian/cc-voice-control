import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PagerThread } from "../components/ThreadPager";
import {
  buildThread,
  type Message,
  messageFromHistory,
  unreconciledOptimistic,
  upsertOptimistic
} from "../lib/messages";
import type { RosterThread, ThreadId } from "../lib/protocol";
import {
  buildThreadAndPrune,
  DEFAULT_RUNTIME,
  EMPTY_MESSAGES,
  pruneThreadMap,
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
  // A FRESH reply (not a replay) landed on a BACKGROUND thread → App may auto-follow it (auto-follow setting).
  onBackgroundReply: (threadId: ThreadId) => void;
  // The outcome of the active thread's in-flight mic turn: confirmed (the spoken turn landed) or failed (a
  // daemon `error` while transcribing) → App drives the "Resend" toast.
  onSendOutcome: (ok: boolean) => void;
  // The daemon acked receipt of a submit_audio (by requestId) → the retransmit watchdog can stop.
  onSendAcked: (requestId: string) => void;
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
  armSpawnFollow,
  onBackgroundReply,
  onSendOutcome,
  onSendAcked
}: Deps) {
  // Destructure the STABLE pieces of `threads` (the wrapper object is recreated each render, but its
  // list + callbacks are stable), so the callbacks/effects below don't churn every render.
  const { threads: threadsList, noteActivity } = threads;
  const [messagesByThread, setMessagesByThread] = useState<Map<ThreadId, Message[]>>(new Map());
  const [runtimeByThread, setRuntimeByThread] = useState<Map<ThreadId, BridgeRuntime>>(new Map());
  // The thread whose mic turn is in flight (transcribing) — one at a time, since the mic is shared.
  const [transcribingThreadId, setTranscribingThreadId] = useState<ThreadId | null>(null);
  // Mirror it in a ref so the stable content handler can read it without becoming a dependency.
  const transcribingRef = useRef<ThreadId | null>(null);
  transcribingRef.current = transcribingThreadId;
  // Newest message timestamp last COUNTED per thread, so unread bumps only for genuinely-new messages —
  // not for the full-thread restore each thread gets on (re)connect (which used to make every background
  // thread read "1" after a refresh).
  const seenNewestRef = useRef<Map<ThreadId, number>>(new Map());

  const { dropAudio, attachAudio, attachAudioChunk, markPlayable, noteAudioStatus } = playback;

  // Mirror the App callbacks in refs so the stable content handler can call them without becoming a
  // dependency (App recreates them as its state changes).
  const onBackgroundReplyRef = useRef(onBackgroundReply);
  onBackgroundReplyRef.current = onBackgroundReply;
  const onSendOutcomeRef = useRef(onSendOutcome);
  onSendOutcomeRef.current = onSendOutcome;
  const onSendAckedRef = useRef(onSendAcked);
  onSendAckedRef.current = onSendAcked;

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
        case "history": {
          // The daemon's projected thread — the SINGLE source of transcript content. It re-projects on
          // every turn event (and on sync), so this snapshot is the complete, ordered, deduped thread; we
          // replace with it (and mark fetchable replies tap-to-play). markPlayable is keyed by native
          // uuid (globally unique), so flagging another thread's rows never bleeds here.
          const restored = event.turns.map(messageFromHistory);
          // Every Claude row is tap-to-playable, whether or not the daemon pre-synthesized it: tapping
          // fetches the audio on demand (get_audio → the daemon synthesizes from the same projection). So
          // a reply can never show as text with no way to hear it — audio follows the one source of truth.
          markPlayable(event.turns.filter((t) => t.role === "claude").map((t) => t.requestId));
          // The mic turn lands when the user's spoken message appears as the newest row: clear the
          // "transcribing…" indicator + confirm it reached Claude. A terminal-typed turn (we weren't
          // transcribing) or an incoming reply (newest row is Claude's) correctly does neither.
          if (transcribingRef.current === threadId && event.turns.length > 0) {
            const newest = event.turns.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
            if (newest.role === "user") {
              setTranscribingThreadId(null);
              onSendOutcomeRef.current(true); // the spoken turn landed → clear any pending "Resend"
              showFlash("Sent to Claude Code ✓");
            }
          }
          // Keep any optimistic prompt rows whose native row hasn't landed yet (still in flight), so the
          // just-sent message doesn't blink out between the optimistic echo and its transcript row arriving.
          updateThreadMessages(setMessagesByThread, threadId, (prev) =>
            buildThreadAndPrune([...restored, ...unreconciledOptimistic(prev, restored)], prev, dropAudio)
          );
          // Unread: baseline a thread the first time we see it (a reconnect/restore is not new activity),
          // then add only what's genuinely new since the last we counted. We track the newest timestamp of
          // ANY row (so the "since" boundary advances past your own just-sent turn + interim steps), but
          // only COUNT incoming final replies — your own messages and dim narration steps are never unread.
          // noteActivity no-ops for the active thread, so it never accrues unread while on-screen.
          const newestTs = restored.reduce((max, m) => (m.timestamp > max ? m.timestamp : max), 0);
          const prevTs = seenNewestRef.current.get(threadId);
          seenNewestRef.current.set(threadId, newestTs);
          if (prevTs !== undefined && newestTs > prevTs) {
            const freshReplies = restored.reduce(
              (n, m) => (m.kind === "claude" && !m.interim && m.timestamp > prevTs ? n + 1 : n),
              0
            );
            noteActivity(threadId, freshReplies);
          }
          return;
        }
        case "prompt_status": {
          // The daemon transcribed ("queued") or the agent received ("accepted") one of the user's prompts.
          // Show it as an optimistic "you" row right away (clock → one check) — reconciled to the native
          // "logged" row when `history` next includes it. This is the real-event feedback that replaces the
          // old blind stt_echo, so a typed or spoken message is visible the instant Claude takes it.
          updateThreadMessages(setMessagesByThread, threadId, (prev) =>
            buildThread(upsertOptimistic(prev, event.text, event.state, Date.now()))
          );
          // "accepted" = Claude received it. For a PHONE voice turn (we were transcribing) end the spinner,
          // clear any pending "Resend", and confirm; a terminal-typed message just shows its bubble. We keep
          // the spinner through "queued" so a failed injection still raises "Resend" via the error path —
          // which keys on the transcribing flag being set.
          if (event.state === "accepted" && transcribingRef.current === threadId) {
            setTranscribingThreadId(null);
            onSendOutcomeRef.current(true);
            if (threadId === activeThreadIdRef.current) showFlash("Sent to Claude Code ✓");
          }
          return;
        }
        case "submit_ack":
          // The daemon has the audio — stop the retransmit watchdog (matched by requestId). The turn still
          // lands via prompt_status/history; this only ends the "did it even arrive?" retry loop.
          onSendAckedRef.current(event.requestId);
          return;
        case "tts_audio": {
          // Only auto-play a fresh reply for the thread the user is looking at; a reply on a background
          // thread waits for a tap. A replay is already gated to tap-to-play inside attachAudio.
          const background = threadId !== activeThreadIdRef.current;
          attachAudio(event.requestId, event.audioBase64, event.mimeType, event.replay === true || background);
          // A genuinely-fresh reply on a background thread → let App auto-follow it (auto-follow setting);
          // a replay (a fetched history clip) is the user's own action, never a follow trigger.
          if (background && event.replay !== true) onBackgroundReplyRef.current(threadId);
          return;
        }
        case "tts_audio_chunk": {
          const background = threadId !== activeThreadIdRef.current;
          attachAudioChunk(event.requestId, event.seq, event.audioBase64, event.mimeType, background);
          return;
        }
        case "tts_status":
          // Loading / failed indicator for a reply's audio (cleared when its tts_audio lands).
          noteAudioStatus(event.requestId, event.state);
          return;
        case "spawn_pending":
          // A daemon (the "+" or the spawn skill) opened a new session with this id; the new thread
          // echoes it in its thread_joined → App follows it.
          armSpawnFollow(event.spawnId);
          return;
        case "error":
          if (threadId === activeThreadIdRef.current) {
            const wasTranscribing = transcribingRef.current === threadId;
            setTranscribingThreadId(null);
            // A failed in-flight mic turn (no audio requestId) → offer a "Resend" instead of just a flash.
            if (wasTranscribing && !event.requestId) onSendOutcomeRef.current(false);
          }
          // The only error carrying a requestId is a `get_audio` miss (its reply audio was evicted) —
          // drop the row so it stops rendering a dead play button.
          if (event.requestId) dropAudio(event.requestId);
          if (threadId === activeThreadIdRef.current) showFlash(event.message);
          return;
      }
    },
    [
      attachAudio,
      attachAudioChunk,
      dropAudio,
      markPlayable,
      noteAudioStatus,
      showFlash,
      noteActivity,
      activeThreadIdRef,
      armSpawnFollow
    ]
  );

  // Release per-thread state for threads the roster fully dropped (a snapshot without them; a
  // greyed/offline thread stays in the roster, so its history is kept). Without it the maps would grow
  // one entry per pane ever seen. Also releases each dropped thread's cached audio.
  useEffect(() => {
    const live = new Set(threadsList.map((t) => t.threadId));
    for (const id of seenNewestRef.current.keys()) if (!live.has(id)) seenNewestRef.current.delete(id);
    setRuntimeByThread((prev) => pruneThreadMap(prev, live));
    setMessagesByThread((prev) =>
      pruneThreadMap(prev, live, (messages) => {
        for (const message of messages) if (message.requestId) dropAudio(message.requestId);
      })
    );
  }, [threadsList, dropAudio]);

  // The active thread's roster entry + runtime (its session_status, falling back to the roster snapshot
  // before the first status arrives).
  const active: RosterThread | undefined = useMemo(
    () => threadsList.find((t) => t.threadId === activeThreadId),
    [threadsList, activeThreadId]
  );
  const activeRuntime =
    (activeThreadId && runtimeByThread.get(activeThreadId)) || rosterRuntime(active) || DEFAULT_RUNTIME;

  // Pager pages: each thread with its (newest-first) messages. Empty until its history/turns land.
  const pagerThreads: PagerThread[] = useMemo(
    () =>
      threadsList.map((thread) => ({
        threadId: thread.threadId,
        messages: messagesByThread.get(thread.threadId) ?? EMPTY_MESSAGES
      })),
    [threadsList, messagesByThread]
  );

  const transcribing = transcribingThreadId !== null && transcribingThreadId === activeThreadId;

  return { handleContentEvent, active, activeRuntime, pagerThreads, transcribing, setTranscribingThreadId };
}
