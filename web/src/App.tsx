import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BottomSwitcher, type ThreadRow } from "./components/BottomSwitcher";
import { Hero } from "./components/Hero";
import { MiniControls } from "./components/MiniControls";
import { SettingsMenu } from "./components/SettingsMenu";
import { ThreadPager } from "./components/ThreadPager";
import { TopBar } from "./components/TopBar";
import { useBridge } from "./hooks/useBridge";
import { useNow } from "./hooks/useElapsed";
import { useFlash } from "./hooks/useFlash";
import { usePlayback } from "./hooks/usePlayback";
import { useTheme } from "./hooks/useTheme";
import { useThreadMessages } from "./hooks/useThreadMessages";
import { useThreads } from "./hooks/useThreads";
import { useVoiceControls } from "./hooks/useVoiceControls";
import { useWakeLock } from "./hooks/useWakeLock";
import type { RosterEvent, SpeakMode, ThreadId } from "./lib/protocol";
import { readThreadHint, type SessionCredentials } from "./lib/session";
import { deriveStatus, gradeThread } from "./lib/status";

// How long after tapping "+" we keep following the spawn (focus the next new thread). Long enough for a
// fresh pane's daemon to launch + register; after this an unrelated join won't steal focus.
const SPAWN_FOLLOW_TIMEOUT_MS = 30_000;

export function App({ credentials }: { credentials: SessionCredentials }) {
  const { flash, flashTone, show: showFlash } = useFlash();

  // Restore the thread from the URL fragment (#t=<id>) on first load — seeded into the store so the
  // roster snapshot focuses it directly, before the carousel renders (no swipe blip). Read once.
  const threads = useThreads(readThreadHint());
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

  // Autoplay mode (off / final / all), persisted per phone. Tell the active thread's daemon the current
  // mode — re-sent when it (re)connects or the active thread changes, since the daemon defaults to "final"
  // on a fresh process.
  const [speakMode, setSpeakMode] = useState<SpeakMode>(() => {
    try {
      const saved = localStorage.getItem("vc-speak-mode");
      return saved === "off" || saved === "final" || saved === "all" ? saved : "final";
    } catch {
      return "final";
    }
  });
  const changeSpeakMode = useCallback((mode: SpeakMode) => {
    setSpeakMode(mode);
    try {
      localStorage.setItem("vc-speak-mode", mode);
    } catch {
      /* private mode — in-memory only */
    }
  }, []);
  useEffect(() => {
    if (activeThreadId && activeConnected) sendDaemon(activeThreadId, { type: "set_speak_mode", mode: speakMode });
  }, [speakMode, activeThreadId, activeConnected, sendDaemon]);

  // Theme (system / dark / light), persisted in localStorage + applied to <html>; nested in the settings menu.
  const { theme, setTheme } = useTheme();

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

  // Deep link / refresh persistence via the URL fragment (#t=<threadId>). On load we honour it ONCE the
  // wanted thread shows up in the roster (a scanned pane's QR carries its own thread; a refresh restores
  // the last one) — falling through to the connected-default pick otherwise. As the user switches threads
  // we keep the fragment in step (replaceState, so it survives refresh without spamming history).
  const wantedThreadRef = useRef<ThreadId | null>(readThreadHint());
  useEffect(() => {
    const want = wantedThreadRef.current;
    if (!want) return;
    if (threads.threads.some((t) => t.threadId === want)) {
      wantedThreadRef.current = null;
      switchThread(want);
    }
  }, [threads.threads, switchThread]);
  useEffect(() => {
    if (!activeThreadId) return;
    try {
      history.replaceState(null, "", `#t=${encodeURIComponent(activeThreadId)}`);
    } catch {
      /* fragment is a nice-to-have; ignore if blocked */
    }
  }, [activeThreadId]);

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

  const working = status.dataState === "working";
  // Working timer from an ACTUAL timestamp — the active thread's latest user prompt — not a local
  // stopwatch, so it stays correct + stable across thread switches and refreshes instead of restarting
  // at 0. `workingNow` ticks each second while working; clamp ≥0 against small laptop↔phone clock skew.
  const workingNow = useNow(working);
  const workingSince = useMemo(() => {
    if (!working) return 0;
    const msgs = pagerThreads.find((p) => p.threadId === activeThreadId)?.messages;
    return msgs?.find((m) => m.kind === "you")?.timestamp ?? 0;
  }, [working, pagerThreads, activeThreadId]);
  const elapsed = working && workingSince > 0 ? Math.max(0, Math.floor((workingNow - workingSince) / 1000)) : 0;

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
      flashAlert={flashTone === "alert"}
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
        <SettingsMenu
          speakMode={speakMode}
          onSpeakModeChange={changeSpeakMode}
          theme={theme}
          onThemeChange={setTheme}
        />
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
          flash={flash}
          flashAlert={flashTone === "alert"}
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
