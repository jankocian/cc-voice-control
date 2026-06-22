import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BottomSwitcher, type ThreadRow } from "./components/BottomSwitcher";
import { Hero } from "./components/Hero";
import { MiniControls } from "./components/MiniControls";
import { StepsToggle } from "./components/StepsToggle";
import { ThreadPager } from "./components/ThreadPager";
import { TopBar } from "./components/TopBar";
import { useBridge } from "./hooks/useBridge";
import { useElapsed, useNow } from "./hooks/useElapsed";
import { useFlash } from "./hooks/useFlash";
import { usePlayback } from "./hooks/usePlayback";
import { useThreadMessages } from "./hooks/useThreadMessages";
import { useThreads } from "./hooks/useThreads";
import { useVoiceControls } from "./hooks/useVoiceControls";
import { useWakeLock } from "./hooks/useWakeLock";
import type { RosterEvent, ThreadId } from "./lib/protocol";
import type { SessionCredentials } from "./lib/session";
import { deriveStatus, gradeThread } from "./lib/status";

// How long after tapping "+" we keep following the spawn (focus the next new thread). Long enough for a
// fresh pane's daemon to launch + register; after this an unrelated join won't steal focus.
const SPAWN_FOLLOW_TIMEOUT_MS = 30_000;

export function App({ credentials }: { credentials: SessionCredentials }) {
  const { flash, show: showFlash } = useFlash();

  const threads = useThreads();
  const { activeThreadId } = threads;

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The active page's scroll root + hero sentinel are lifted out of the pager so the condensed bar's
  // IntersectionObserver always watches whichever thread is on screen.
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [heroSentinel, setHeroSentinel] = useState<HTMLDivElement | null>(null);
  const [condensed, setCondensed] = useState(false);

  useWakeLock();

  // recordingRef is the playback auto-play guard (read lazily by usePlayback, created below); the
  // recorder hook keeps it in sync. activeThreadIdRef lets the stable content/audio callbacks read the
  // current active thread.
  const recordingRef = useRef(false);
  const getRecording = useCallback(() => recordingRef.current, []);
  const activeThreadIdRef = useRef<ThreadId | null>(activeThreadId);
  activeThreadIdRef.current = activeThreadId;

  // Spawn-follow: a daemon's spawn_pending arms a one-shot spawnId; the new thread echoes it on its
  // thread_joined and we switch to that exact thread (immune to ordering/ghosts/unrelated reconnects).
  const pendingSpawnIdsRef = useRef<Set<string>>(new Set());
  const switchThreadRef = useRef<(threadId: ThreadId) => void>(() => {});
  const armSpawnFollow = useCallback((spawnId: string) => {
    pendingSpawnIdsRef.current.add(spawnId);
    window.setTimeout(() => pendingSpawnIdsRef.current.delete(spawnId), SPAWN_FOLLOW_TIMEOUT_MS);
  }, []);

  // Audio-on-demand: tapping play on a history row fetches its bytes from the ACTIVE thread's daemon.
  const sendDaemonRef = useRef<
    ((threadId: ThreadId, command: { type: "get_audio"; requestId: string }) => boolean) | null
  >(null);
  const onRequestAudio = useCallback((requestId: string) => {
    const threadId = activeThreadIdRef.current;
    if (threadId) sendDaemonRef.current?.(threadId, { type: "get_audio", requestId });
  }, []);

  const playback = usePlayback({ getRecording, onRequestAudio });
  const { stopPlayback } = playback;

  // Per-thread conversation state + the bridge content reducer.
  const { handleContentEvent, active, activeRuntime, pagerThreads, transcribing, setTranscribingThreadId } =
    useThreadMessages({ threads, playback, showFlash, activeThreadId, activeThreadIdRef, armSpawnFollow });

  // Apply every roster event, and follow a spawn into its EXACT new thread the moment it joins (matched
  // by the one-shot spawnId on its thread_joined — never a ghost or unrelated reconnect).
  const onRoster = useCallback(
    (event: RosterEvent) => {
      threads.applyRosterEvent(event);
      if (
        event.type === "thread_joined" &&
        event.thread.spawnId &&
        pendingSpawnIdsRef.current.has(event.thread.spawnId)
      ) {
        pendingSpawnIdsRef.current.delete(event.thread.spawnId);
        switchThreadRef.current(event.thread.threadId);
      }
    },
    [threads]
  );

  const bridge = useBridge({ secret: credentials.secret, onEvent: handleContentEvent, onRoster });
  const { connected, bridgeReady, sendDaemon } = bridge;
  sendDaemonRef.current = sendDaemon;

  // Tick a wall clock only while the socket is open but the active thread has no daemon — exactly when
  // the status grades reconnecting→offline by elapsed time and "Last active X ago" updates.
  const activeConnected = active?.connected === true;
  const now = useNow(connected && !activeConnected);

  // A dropped socket loses any in-flight send — re-enable the mic.
  useEffect(() => {
    if (!connected) setTranscribingThreadId(null);
  }, [connected, setTranscribingThreadId]);

  // "Read every step": persisted per phone. Tell the active thread's daemon the current mode — re-sent when
  // it (re)connects or the active thread changes, since the daemon defaults to off on a fresh process.
  const [speakSteps, setSpeakSteps] = useState<boolean>(() => {
    try {
      return localStorage.getItem("vc-speak-steps") === "1";
    } catch {
      return false;
    }
  });
  const toggleSteps = useCallback(() => {
    setSpeakSteps((on) => {
      const next = !on;
      try {
        localStorage.setItem("vc-speak-steps", next ? "1" : "0");
      } catch {
        /* private mode — in-memory only */
      }
      return next;
    });
  }, []);
  useEffect(() => {
    if (activeThreadId && activeConnected) sendDaemon(activeThreadId, { type: "set_speak_steps", on: speakSteps });
  }, [speakSteps, activeThreadId, activeConnected, sendDaemon]);

  // Focus a thread (pill / dropdown / swipe settle). Stop the previous thread's audio first so it
  // doesn't keep playing under the new view — the shared player is a singleton across threads.
  const switchThread = useCallback(
    (threadId: ThreadId) => {
      stopPlayback();
      threads.setActive(threadId);
    },
    [stopPlayback, threads]
  );
  switchThreadRef.current = switchThread;

  // The shared mic + working-state controls, acting on the active thread.
  const voice = useVoiceControls({
    canvasRef,
    recordingRef,
    activeThreadIdRef,
    transcribing,
    setTranscribingThreadId,
    sendDaemon,
    bridgeReady,
    stopPlayback,
    showFlash
  });

  // Bless the audio element on the first user gesture so replies autoplay reliably.
  const { unlock } = playback;
  useEffect(() => {
    const onFirstTap = () => unlock();
    window.addEventListener("pointerdown", onFirstTap, { once: true });
    return () => window.removeEventListener("pointerdown", onFirstTap);
  }, [unlock]);

  // Reveal the condensed controls once the active page's hero (its in-flow sentinel) scrolls above the
  // top. The hero lives in the page's scroll flow now (no pinned overlay), so this is the only thing left
  // to wire. Re-runs when the active scroll root / sentinel change (i.e. when the active thread switches).
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
    recording: voice.recording,
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

  const threadPlayback = {
    playingId: playback.playingId,
    loadedId: playback.loadedId,
    position: playback.position,
    duration: playback.duration,
    playableIds: playback.playableIds,
    onPlay: playback.playEntry,
    onReplay: playback.replayEntry,
    onSeek: playback.seekEntry
  };

  // The hero is rendered IN THE FLOW at the top of each pager page (so it scrolls away like a normal
  // header — never a pinned overlay covering the messages/scrollbar). Its status/controls always act on
  // the active thread; only the on-screen page gets the live mic + canvas wired, so the visualizer paints
  // once and a swipe still shows a hero on the incoming page.
  const renderHero = (isActive: boolean) => (
    <Hero
      status={status}
      elapsed={elapsed}
      flash={flash}
      recording={isActive && voice.recording}
      visualizerActive={isActive && voice.visualizerActive}
      canvasRef={isActive ? canvasRef : undefined}
      speedLabel={playback.formattedRate}
      onCycleSpeed={playback.cycleSpeed}
      onMic={voice.onMic}
      onSteer={voice.onSteer}
      onInterrupt={voice.onInterrupt}
      onStopRecording={voice.onStopRecording}
      onCancel={voice.onCancel}
      onStopTask={voice.onStopTask}
    />
  );

  return (
    <div className="flex h-full flex-col bg-canvas px-safe">
      <TopBar>
        <StepsToggle on={speakSteps} onToggle={toggleSteps} />
      </TopBar>

      <div className="relative min-h-0 flex-1">
        <ThreadPager
          threads={pagerThreads}
          activeThreadId={activeThreadId}
          renderHero={renderHero}
          playback={threadPlayback}
          onActivate={switchThread}
          activeScrollRootRef={setScrollRoot}
          activeSentinelRef={setHeroSentinel}
        />

        {/* Condensed, sticky controls — slides in once the active page's hero scrolls away. */}
        <MiniControls
          status={status}
          elapsed={elapsed}
          working={working}
          recording={voice.recording}
          shown={condensed}
          onMic={voice.onMic}
          onSteer={voice.onSteer}
          onInterrupt={voice.onInterrupt}
          onStopRecording={voice.onStopRecording}
          onCancel={voice.onCancel}
          onStopTask={voice.onStopTask}
        />

        {/* Bottom "liquid glass" thread switcher + swipe dots — only when there's more than one thread. */}
        <BottomSwitcher
          rows={switcherRows}
          activeThreadId={activeThreadId}
          onSelect={switchThread}
          onSpawn={voice.onSpawn}
        />
      </div>
    </div>
  );
}
