import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PagerThread } from "../components/ThreadPager";
import { echoMessage, type Message, mergeEchoes, messageFromHistory, unresolvedEchoes } from "../lib/messages";
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

// Cap optimistic echoes retained per thread (normally 0–1 in flight; this just bounds a pathological run
// where echoes somehow never reconcile).
const MAX_ECHOES = 4;

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
  onSendOutcome
}: Deps) {
  // Destructure the STABLE pieces of `threads` (the wrapper object is recreated each render, but its
  // list + callbacks are stable), so the callbacks/effects below don't churn every render.
  const { threads: threadsList, noteActivity } = threads;
  const [messagesByThread, setMessagesByThread] = useState<Map<ThreadId, Message[]>>(new Map());
  // Optimistic "sending…" placeholders per thread, from stt_echo — shown instantly until the projection
  // includes the real turn (then dropped, see the history case). Local-only; never authoritative.
  const [echoesByThread, setEchoesByThread] = useState<Map<ThreadId, Message[]>>(new Map());
  const echoSeqRef = useRef(0);
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

  const { dropAudio, attachAudio, markPlayable, noteAudioStatus } = playback;

  // Mirror the App callbacks in refs so the stable content handler can call them without becoming a
  // dependency (App recreates them as its state changes).
  const onBackgroundReplyRef = useRef(onBackgroundReply);
  onBackgroundReplyRef.current = onBackgroundReply;
  const onSendOutcomeRef = useRef(onSendOutcome);
  onSendOutcomeRef.current = onSendOutcome;

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
        case "stt_echo": {
          // The user's just-spoken words, transcribed — show them instantly as a "sending…" placeholder,
          // before the inject→transcript→projection round-trip lands. Reconciled away by the next history
          // snapshot (see below). Local-only, so it can never orphan or duplicate the real row.
          const echo = echoMessage(`echo-${++echoSeqRef.current}`, event.text, Date.now());
          setEchoesByThread((prev) => {
            const next = new Map(prev);
            next.set(threadId, [...(prev.get(threadId) ?? []), echo].slice(-MAX_ECHOES));
            return next;
          });
          return;
        }
        case "history": {
          // The daemon's projected thread — the SINGLE source of transcript content. It re-projects on
          // every turn event (and on sync), so this snapshot is the complete, ordered, deduped thread; we
          // replace with it (and mark fetchable replies tap-to-play). markPlayable is keyed by native
          // uuid (globally unique), so flagging another thread's rows never bleeds here.
          const restored = event.turns.map(messageFromHistory);
          markPlayable(event.turns.filter((t) => t.hasAudio).map((t) => t.requestId));
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
          updateThreadMessages(setMessagesByThread, threadId, (prev) => buildThreadAndPrune(restored, prev, dropAudio));
          // Drop any optimistic echo now reflected by a real (projected) user turn — the projection is the
          // source of truth, so once it shows the turn the placeholder is redundant.
          setEchoesByThread((prev) => {
            const cur = prev.get(threadId);
            if (!cur || cur.length === 0) return prev;
            const kept = unresolvedEchoes(cur, restored);
            if (kept.length === cur.length) return prev;
            const next = new Map(prev);
            if (kept.length === 0) next.delete(threadId);
            else next.set(threadId, kept);
            return next;
          });
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
    [attachAudio, dropAudio, markPlayable, noteAudioStatus, showFlash, noteActivity, activeThreadIdRef, armSpawnFollow]
  );

  // Release per-thread state for threads the roster fully dropped (a snapshot without them; a
  // greyed/offline thread stays in the roster, so its history is kept). Without it the maps would grow
  // one entry per pane ever seen. Also releases each dropped thread's cached audio.
  useEffect(() => {
    const live = new Set(threadsList.map((t) => t.threadId));
    setRuntimeByThread((prev) => pruneThreadMap(prev, live));
    setEchoesByThread((prev) => pruneThreadMap(prev, live));
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
        // Merge in any optimistic echoes (mergeEchoes returns the same array ref when there are none, so a
        // thread without echoes keeps EMPTY_MESSAGES and doesn't churn the pager).
        messages: mergeEchoes(
          messagesByThread.get(thread.threadId) ?? EMPTY_MESSAGES,
          echoesByThread.get(thread.threadId) ?? EMPTY_MESSAGES
        )
      })),
    [threadsList, messagesByThread, echoesByThread]
  );

  const transcribing = transcribingThreadId !== null && transcribingThreadId === activeThreadId;

  return { handleContentEvent, active, activeRuntime, pagerThreads, transcribing, setTranscribingThreadId };
}
