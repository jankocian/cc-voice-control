import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hero } from "./components/Hero";
import { MiniControls } from "./components/MiniControls";
import { type PagerThread, ThreadPager } from "./components/ThreadPager";
import { type ThreadRow, ThreadSwitcher } from "./components/ThreadSwitcher";
import { TopBar } from "./components/TopBar";
import { type BridgeContentEvent, type BridgeRuntime, useBridge } from "./hooks/useBridge";
import { useElapsed, useNow } from "./hooks/useElapsed";
import { useFlash } from "./hooks/useFlash";
import { usePlayback } from "./hooks/usePlayback";
import { type RecordedClip, type RecorderError, useRecorder } from "./hooks/useRecorder";
import { useThreads } from "./hooks/useThreads";
import { useWakeLock } from "./hooks/useWakeLock";
import { FEATURES } from "./lib/features";
import { type Message, makeMessage, messageFromHistory, reconcileMessages } from "./lib/messages";
import type { RosterThread, ThreadId } from "./lib/protocol";
import type { SessionCredentials } from "./lib/session";
import { deriveStatus, gradeThread } from "./lib/status";

const RECORDER_ERROR_TEXT: Record<RecorderError, string> = {
  "not-supported": "This browser cannot record audio",
  "mic-blocked": "Microphone blocked — allow it and try again",
  empty: "Didn't catch that — tap to retry",
  "read-failed": "Could not read the recording"
};

// A thread that has never sent a session_status yet falls back to its roster snapshot for the
// runtime (the daemon folds state/listening into the roster too). currentTask only arrives via
// session_status, so it's undefined until the first one.
const DEFAULT_RUNTIME: BridgeRuntime = { state: "idle", currentTask: undefined, listening: true };

export function App({ credentials }: { credentials: SessionCredentials }) {
  const { flash, show: showFlash } = useFlash();

  // ---- per-thread state ------------------------------------------------------
  // Messages + the latest session_status runtime are kept per thread; the roster (presence,
  // labels, unread, active) lives in useThreads. The shared mic/player act on the active thread.
  const [messagesByThread, setMessagesByThread] = useState<Map<ThreadId, Message[]>>(new Map());
  const [runtimeByThread, setRuntimeByThread] = useState<Map<ThreadId, BridgeRuntime>>(new Map());
  // The thread whose mic turn is in flight (transcribing) — one at a time, since the mic is shared.
  const [transcribingThreadId, setTranscribingThreadId] = useState<ThreadId | null>(null);

  const threads = useThreads();
  const { activeThreadId } = threads;

  const nextModeRef = useRef<"queue" | "interrupt">("queue");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The active page's scroll root + hero sentinel are lifted out of the pager so the condensed
  // bar's IntersectionObserver always watches whichever thread is on screen.
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [heroSentinel, setHeroSentinel] = useState<HTMLDivElement | null>(null);
  const [condensed, setCondensed] = useState(false);

  useWakeLock();

  // ---- recording state shared with playback (auto-play guard) ----------------
  const recordingRef = useRef(false);
  const getRecording = useCallback(() => recordingRef.current, []);

  // Audio-on-demand: tapping play on a history row fetches its bytes from the ACTIVE thread's
  // daemon (the row being read belongs to the on-screen thread). Read active threadId lazily.
  const activeThreadIdRef = useRef<ThreadId | null>(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const sendDaemonRef = useRef<
    ((threadId: ThreadId, command: { type: "get_audio"; requestId: string }) => boolean) | null
  >(null);
  const onRequestAudio = useCallback((requestId: string) => {
    const threadId = activeThreadIdRef.current;
    if (threadId) sendDaemonRef.current?.(threadId, { type: "get_audio", requestId });
  }, []);

  const playback = usePlayback({ getRecording, onRequestAudio });
  const { dropAudio, attachAudio, markPlayable, stopPlayback, playEntry, replayEntry, seekEntry } = playback;

  // ---- bridge: route every tagged event to its thread ------------------------
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
          if (threadId === activeThreadIdRef.current) setTranscribingThreadId(null);
          updateThreadMessages(setMessagesByThread, threadId, (prev) =>
            reconcileAndPrune(
              prev,
              [makeMessage("You", event.text, event.requestId, { seq: event.seq, timestamp: event.timestamp })],
              dropAudio
            )
          );
          threads.noteActivity(threadId);
          if (threadId === activeThreadIdRef.current) showFlash("Sent to Claude Code ✓");
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
          // Reconnect / refresh / 2nd browser: restore the retained thread. Merge by seq and
          // mark fetchable replies playable (tap-to-play before their bytes are requested).
          // markPlayable is keyed by requestId (globally unique), so flagging another thread's
          // history rows here never bleeds into the active thread's player.
          const restored = event.turns.map(messageFromHistory);
          markPlayable(event.turns.filter((t) => t.hasAudio).map((t) => t.requestId));
          updateThreadMessages(setMessagesByThread, threadId, (prev) => reconcileAndPrune(prev, restored, dropAudio));
          return;
        }
        case "tts_audio":
          // Only auto-play a fresh reply for the thread the user is looking at; a reply on a
          // background thread waits for a tap (the user switches to it to hear it). A replay is
          // already gated to tap-to-play inside attachAudio.
          attachAudio(
            event.requestId,
            event.audioBase64,
            event.mimeType,
            event.replay === true || threadId !== activeThreadIdRef.current
          );
          return;
        case "error":
          if (threadId === activeThreadIdRef.current) setTranscribingThreadId(null);
          // The only error carrying a requestId is a `get_audio` miss (that reply's audio was
          // evicted from the daemon ring). Drop the row so it stops rendering a dead play button.
          if (event.requestId) dropAudio(event.requestId);
          if (threadId === activeThreadIdRef.current) showFlash(event.message);
          return;
      }
    },
    [attachAudio, dropAudio, markPlayable, showFlash, threads]
  );

  const bridge = useBridge({
    secret: credentials.secret,
    onEvent: handleContentEvent,
    onRoster: threads.applyRosterEvent
  });
  const { connected, bridgeReady, sendDaemon } = bridge;

  sendDaemonRef.current = sendDaemon;

  // The active thread's roster entry + runtime drive the hero. Presence (connected/lastSeenAt)
  // comes from the roster; the runtime (state/listening/currentTask) from its session_status,
  // falling back to the roster snapshot before the first status arrives.
  const active = useMemo(
    () => threads.threads.find((t) => t.threadId === activeThreadId),
    [threads.threads, activeThreadId]
  );
  const activeRuntime =
    (activeThreadId && runtimeByThread.get(activeThreadId)) || rosterRuntime(active) || DEFAULT_RUNTIME;

  // Release per-thread state for threads the roster has fully dropped (a snapshot without them; a
  // greyed/offline thread stays in the roster, so its history is kept). Mirrors useThreads' unread
  // prune — without it `messagesByThread`/`runtimeByThread` would grow one entry per pane ever seen
  // over a long-lived socket and never release. Also releases each dropped thread's cached audio.
  useEffect(() => {
    const live = new Set(threads.threads.map((t) => t.threadId));
    setRuntimeByThread((prev) => pruneThreadMap(prev, live));
    setMessagesByThread((prev) =>
      pruneThreadMap(prev, live, (messages) => {
        for (const message of messages) if (message.requestId) dropAudio(message.requestId);
      })
    );
  }, [threads.threads, dropAudio]);

  // Tick a wall clock only while the socket is open but the active thread has no daemon — exactly
  // when the status grades reconnecting→offline by elapsed time and "Last active X ago" updates.
  const activeConnected = active?.connected === true;
  const now = useNow(connected && !activeConnected);

  // A dropped socket loses any in-flight send — re-enable the mic.
  useEffect(() => {
    if (!connected) setTranscribingThreadId(null);
  }, [connected]);

  // Focus a thread (pill / dropdown / swipe settle). Stop the previous thread's audio first so it
  // doesn't keep playing under the new view — the shared player is a singleton across threads.
  const switchThread = useCallback(
    (threadId: ThreadId) => {
      stopPlayback();
      threads.setActive(threadId);
    },
    [stopPlayback, threads]
  );

  // ---- recorder (shared singleton, acts on the active thread) -----------------
  const sendAudio = useCallback(
    (clip: RecordedClip, mode: "queue" | "interrupt") => {
      const threadId = activeThreadIdRef.current;
      if (
        !threadId ||
        !sendDaemon(threadId, { type: "submit_audio", audioBase64: clip.audioBase64, mimeType: clip.mimeType, mode })
      ) {
        showFlash("Lost the connection before sending");
        return;
      }
      setTranscribingThreadId(threadId);
    },
    [sendDaemon, showFlash]
  );

  const onClip = useCallback(
    (clip: RecordedClip) => {
      sendAudio(clip, nextModeRef.current);
      nextModeRef.current = "queue";
    },
    [sendAudio]
  );

  const onRecorderError = useCallback((error: RecorderError) => showFlash(RECORDER_ERROR_TEXT[error]), [showFlash]);

  const recorder = useRecorder({
    canvasRef,
    onClip,
    onError: onRecorderError,
    onStart: stopPlayback
  });
  recordingRef.current = recorder.recording;

  const transcribing = transcribingThreadId !== null && transcribingThreadId === activeThreadId;

  const startRecording = useCallback(
    (mode: "queue" | "interrupt") => {
      if (transcribing) return;
      if (!bridgeReady(activeThreadIdRef.current)) {
        showFlash("Not connected to Claude Code yet");
        return;
      }
      nextModeRef.current = mode;
      void recorder.start();
    },
    [transcribing, bridgeReady, recorder, showFlash]
  );

  const onMic = useCallback(() => startRecording("queue"), [startRecording]);
  const onStopRecording = useCallback(() => recorder.stop(), [recorder]);
  const onCancel = useCallback(() => recorder.cancel(), [recorder]);

  // ---- working-state controls (act on the active thread) ----------------------
  const sendControl = useCallback(
    (command: { type: "status_request" } | { type: "stop_task" }) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId || !sendDaemon(threadId, command)) {
        showFlash(bridgeReady(activeThreadIdRef.current) ? "Couldn't reach Claude Code" : "Not connected yet");
      }
    },
    [sendDaemon, bridgeReady, showFlash]
  );

  const onInterrupt = useCallback(() => startRecording("interrupt"), [startRecording]);
  const onSteer = useCallback(() => startRecording("queue"), [startRecording]);
  const onStopTask = useCallback(() => sendControl({ type: "stop_task" }), [sendControl]);

  // ---- teardown (pagehide) ---------------------------------------------------
  useEffect(() => {
    const onPageHide = () => recorder.teardown();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [recorder]);

  // Bless the audio element on the first user gesture so replies autoplay reliably.
  const { unlock } = playback;
  useEffect(() => {
    const onFirstTap = () => unlock();
    window.addEventListener("pointerdown", onFirstTap, { once: true });
    return () => window.removeEventListener("pointerdown", onFirstTap);
  }, [unlock]);

  // Reveal the condensed controls when the active page's hero (its sentinel) leaves the viewport.
  // Re-runs when the active scroll root / sentinel change (i.e. when the active thread switches).
  useEffect(() => {
    if (!scrollRoot || !heroSentinel) return;
    setCondensed(false);
    const obs = new IntersectionObserver(([entry]) => setCondensed(!entry.isIntersecting), {
      root: scrollRoot,
      threshold: 0
    });
    obs.observe(heroSentinel);
    return () => obs.disconnect();
  }, [scrollRoot, heroSentinel]);

  // ---- derive view -----------------------------------------------------------
  const status = deriveStatus({
    connected,
    // Per-thread presence: the active thread's roster `connected`/`lastSeenAt` feed #10 verbatim.
    daemonConnected: activeConnected,
    daemonLastSeenAt: active?.lastSeenAt ?? null,
    now,
    recording: recorder.recording,
    transcribing,
    speaking: playback.speaking,
    runtimeState: activeRuntime.state,
    currentTask: activeRuntime.currentTask,
    listening: activeRuntime.listening,
    flash
  });

  const elapsed = useElapsed(status.dataState === "working");
  const working = status.dataState === "working";

  // Switcher rows: each roster thread with its unread badge + #10-graded dot tone.
  const switcherRows: ThreadRow[] = useMemo(
    () =>
      threads.threads.map((thread) => ({
        thread,
        unread: threads.unread.get(thread.threadId) ?? 0,
        tone: gradeThread({ connected: thread.connected, state: thread.state, listening: thread.listening })
      })),
    [threads.threads, threads.unread]
  );

  // Pager pages: each thread with its (newest-first) messages. Empty until its history/turns land.
  const pagerThreads: PagerThread[] = useMemo(
    () =>
      threads.threads.map((thread) => ({
        threadId: thread.threadId,
        messages: messagesByThread.get(thread.threadId) ?? EMPTY_MESSAGES
      })),
    [threads.threads, messagesByThread]
  );

  const threadPlayback = {
    playingId: playback.playingId,
    loadedId: playback.loadedId,
    position: playback.position,
    duration: playback.duration,
    playableIds: playback.playableIds,
    onPlay: playEntry,
    onReplay: replayEntry,
    onSeek: seekEntry
  };

  // The shared hero is ONE instance (one mic/canvas/controls), pinned over the top of the pager
  // and acting on the active thread. Each pager page reserves a spacer of its measured height so a
  // thread's messages start below it and scroll up under it (preserving the scroll-away → condensed
  // behaviour), while every thread keeps its own vertical scroll position.
  const heroRef = useRef<HTMLDivElement>(null);
  const [heroHeight, setHeroHeight] = useState(0);
  useEffect(() => {
    const node = heroRef.current;
    if (!node) return;
    const measure = () => setHeroHeight(node.offsetHeight);
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  return (
    <div className="flex h-full flex-col bg-canvas px-safe">
      <TopBar online={status.dataState !== "offline"}>
        {FEATURES.threadTitle && (
          <ThreadSwitcher rows={switcherRows} activeThreadId={activeThreadId} onSelect={switchThread} />
        )}
      </TopBar>

      <div className="relative min-h-0 flex-1">
        <ThreadPager
          threads={pagerThreads}
          activeThreadId={activeThreadId}
          heroHeight={heroHeight}
          playback={threadPlayback}
          onActivate={switchThread}
          activeScrollRootRef={setScrollRoot}
          activeSentinelRef={setHeroSentinel}
        />

        {/* The single shared hero, pinned over the top of the pager so it sits on whichever thread
            is active. One mic/canvas/control cluster; its status is the active thread's. */}
        <div ref={heroRef} className="pointer-events-none absolute inset-x-0 top-0 z-10">
          <div className="pointer-events-auto">
            <Hero
              status={status}
              elapsed={elapsed}
              flash={flash}
              recording={recorder.recording}
              visualizerActive={recorder.visualizerActive}
              canvasRef={canvasRef}
              speedLabel={playback.formattedRate}
              onCycleSpeed={playback.cycleSpeed}
              onMic={onMic}
              onSteer={onSteer}
              onInterrupt={onInterrupt}
              onStopRecording={onStopRecording}
              onCancel={onCancel}
              onStopTask={onStopTask}
            />
          </div>
        </div>

        {/* Condensed, sticky controls — slides in once the active page's hero scrolls away. */}
        <MiniControls
          status={status}
          elapsed={elapsed}
          working={working}
          recording={recorder.recording}
          shown={condensed}
          onMic={onMic}
          onSteer={onSteer}
          onInterrupt={onInterrupt}
          onStopRecording={onStopRecording}
          onCancel={onCancel}
          onStopTask={onStopTask}
        />
      </div>
    </div>
  );
}

// A stable empty array so threads with no messages yet don't churn the pager memo.
const EMPTY_MESSAGES: Message[] = [];

// Fall back to a thread's roster snapshot (state/listening) for its runtime before its first
// session_status arrives. currentTask is only on session_status, so it stays undefined here.
function rosterRuntime(thread: RosterThread | undefined): BridgeRuntime | undefined {
  if (!thread) return undefined;
  return { state: thread.state, listening: thread.listening, currentTask: undefined };
}

// Apply a message-list update to one thread in the per-thread Map (immutably, so React re-renders).
function updateThreadMessages(
  setMap: React.Dispatch<React.SetStateAction<Map<ThreadId, Message[]>>>,
  threadId: ThreadId,
  update: (prev: Message[]) => Message[]
): void {
  setMap((prev) => {
    const next = new Map(prev);
    next.set(threadId, update(prev.get(threadId) ?? []));
    return next;
  });
}

// Reconcile incoming rows into the thread (merge/dedup/order by seq), then drop cached audio for
// any row that fell out of the capped window — preserving the bounded-memory pruning.
function reconcileAndPrune(prev: Message[], incoming: Message[], dropAudio: (requestId: string) => void): Message[] {
  const next = reconcileMessages(prev, incoming);
  const kept = new Set(next.map((m) => m.requestId).filter((id): id is string => id !== undefined));
  for (const message of prev) {
    if (message.requestId && !kept.has(message.requestId)) dropAudio(message.requestId);
  }
  return next;
}

// Drop entries whose threadId is no longer in `live`; returns the same map ref when nothing changed
// (so it never forces a re-render). `onDrop` releases any resource the evicted value held.
function pruneThreadMap<V>(
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
