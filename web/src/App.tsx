import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BottomSwitcher, type ThreadRow } from "./components/BottomSwitcher";
import { Hero } from "./components/Hero";
import { MiniControls } from "./components/MiniControls";
import { SessionExpired } from "./components/SessionExpired";
import { SettingsMenu } from "./components/SettingsMenu";
import { ThreadPager } from "./components/ThreadPager";
import { Toaster, toast } from "./components/Toaster";
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
import { initialThread, storeActiveThread } from "./lib/active-thread";
import { newestPlayableReply } from "./lib/messages";
import type { RosterEvent, SpeakMode, ThreadId } from "./lib/protocol";
import type { Session } from "./lib/session";
import { deriveStatus, gradeThread, type StatusView } from "./lib/status";
import { cn } from "./lib/utils";

// How long after tapping "+" we keep following the spawn (focus the next new thread). Long enough for a
// fresh pane's daemon to launch + register; after this an unrelated join won't steal focus.
const SPAWN_FOLLOW_TIMEOUT_MS = 30_000;

// How long the user must be idle (no touch / scroll / tap) before a deferred auto-follow is allowed to
// switch threads — so we never yank them away mid-interaction.
const INTERACTION_IDLE_MS = 4_000;

export function App({ session }: { session: Session }) {
  const { flash, flashTone, show: showFlash } = useFlash();

  // Set when /claim is rejected for good — we then show the re-pair screen instead of the live UI
  // (useBridge has already stopped reconnecting). The reason tailors the message: a lapsed session
  // (had a cookie) vs a used/expired one-time link.
  const [expired, setExpired] = useState<"stale" | "expired" | null>(null);
  const onExpired = useCallback((reason: "stale" | "expired") => setExpired(reason), []);

  // The thread to focus on load: the last one we stored (localStorage), or a fresh `?t=` deep link. Resolved
  // ONCE (it consumes the deep link) and seeded into the store so the roster snapshot focuses it directly,
  // before the carousel renders (no swipe blip).
  const initialThreadId = useMemo(() => initialThread(), []);
  const threads = useThreads(initialThreadId);
  const { activeThreadId } = threads;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The app root — interaction listeners attach here to gate auto-follow while the user is active.
  const appRootRef = useRef<HTMLDivElement>(null);

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

  // Spawn progress toast: a persistent "Spawning a new agent…" loader from the tap until the new thread
  // actually joins (resolved below in onRoster) or we time out into a retryable error — so the user has a
  // clear signal during the several-second gap instead of the active thread's pill flickering.
  const spawnToastRef = useRef<string | null>(null);
  const spawnTimerRef = useRef(0);
  const resolveSpawnToast = useCallback(() => {
    if (spawnTimerRef.current) window.clearTimeout(spawnTimerRef.current);
    if (spawnToastRef.current) toast.close(spawnToastRef.current);
    spawnToastRef.current = null;
  }, []);

  // Audio-on-demand: tapping play on a history row fetches its bytes from the ACTIVE thread's daemon.
  const sendDaemonRef = useRef<
    ((threadId: ThreadId, command: { type: "get_audio"; requestId: string }) => boolean) | null
  >(null);
  const onRequestAudio = useCallback((requestId: string) => {
    const threadId = activeThreadIdRef.current;
    if (threadId) sendDaemonRef.current?.(threadId, { type: "get_audio", requestId });
  }, []);

  // Autoplay = a pure client-side play/don't-play toggle (the daemon ALWAYS synthesizes). "off" → a fresh
  // reply is cached + tap-playable but doesn't play by itself. These refs bridge settings/recorder defined
  // below into usePlayback (created here) without reordering the hooks.
  const autoplayEnabledRef = useRef(true);
  const autoRespondRef = useRef(false);
  const transcribingRef = useRef(false);
  const startRecordingRef = useRef<() => void>(() => {});
  const getAutoplay = useCallback(() => autoplayEnabledRef.current, []);
  // Hands-free auto-respond: after the NEWEST final reply finishes playing (autoplayed OR manually tapped),
  // open the mic so the user can answer and just hit stop. `autoRespondRef` is just the toggle (independent
  // of autoplay/auto-follow). Skip if already recording/sending, only fire for a real final reply (never an
  // interim step), and only when it's the latest turn — replaying an older reply has nothing live to answer.
  // Reads `pagerThreadsRef` assigned below — resolved at call time.
  const onAutoReplyFinished = useCallback((requestId: string) => {
    if (!autoRespondRef.current || recordingRef.current || transcribingRef.current) return;
    const msgs = pagerThreadsRef.current.find((p) => p.threadId === activeThreadIdRef.current)?.messages ?? [];
    const msg = msgs.find((m) => m.requestId === requestId);
    if (msg?.kind !== "claude" || msg.interim) return;
    // Only continue the conversation when this reply is the newest turn in the thread (msgs is newest-first).
    // Replaying an older reply shouldn't open the mic — there's nothing live to answer.
    if (msgs[0]?.requestId !== requestId) return;
    startRecordingRef.current();
  }, []);

  const playback = usePlayback({ getRecording, getAutoplay, onRequestAudio, onAutoReplyFinished });
  const { stopPlayback } = playback;

  // Auto-follow: a fresh background reply arms a one-shot follow to that thread; the effect below performs
  // it once nothing's playing / we're not recording/sending (so it never interrupts or steals the mic).
  // `autoFollowRef` (set below) gates it — only arm when the setting is on. Refs let the callback stay stable.
  const [pendingFollow, setPendingFollow] = useState<ThreadId | null>(null);
  // Bumped by the idle-window timer to force the auto-follow effect to re-evaluate after pointer activity
  // (which doesn't itself re-render) has gone quiet.
  const [followTick, setFollowTick] = useState(0);
  const autoFollowRef = useRef(false);
  // Also hold a deferred follow while the user is actively interacting (touch / scroll / tap) — being
  // yanked to another thread mid-interaction is jarring. `lastInteractionAt` is bumped by the listeners
  // wired below; the follow waits until the user has been idle for INTERACTION_IDLE_MS.
  const lastInteractionAtRef = useRef(0);
  const onBackgroundReply = useCallback((threadId: ThreadId) => {
    if (autoFollowRef.current) setPendingFollow(threadId);
  }, []);
  // The in-flight mic send's controller lives in useVoiceControls (created below); App routes the reducer's
  // ack + settled signals into it via this ref, since the reducer is created before the controller it feeds.
  const sendCtlRef = useRef<{ acked: (id: string) => void; settled: (ok: boolean) => void }>({
    acked: () => {},
    settled: () => {}
  });
  const onSendOutcome = useCallback((ok: boolean) => sendCtlRef.current.settled(ok), []);
  const onSendAcked = useCallback((id: string) => sendCtlRef.current.acked(id), []);

  // Per-thread conversation state + the bridge content reducer.
  const { handleContentEvent, active, activeRuntime, pagerThreads, transcribing, setTranscribingThreadId } =
    useThreadMessages({
      threads,
      playback,
      showFlash,
      activeThreadId,
      activeThreadIdRef,
      armSpawnFollow,
      onBackgroundReply,
      onSendOutcome,
      onSendAcked
    });

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
        resolveSpawnToast(); // the new agent is online — dismiss the progress toast
        switchThreadRef.current(event.thread.threadId);
      }
    },
    [threads, resolveSpawnToast]
  );

  const bridge = useBridge({
    sessionId: session.sessionId,
    key: session.key,
    onEvent: handleContentEvent,
    onRoster,
    onExpired
  });
  const { connected, bridgeReady, sendDaemon } = bridge;
  sendDaemonRef.current = sendDaemon;

  // Tick a wall clock only while the socket is open but the active thread has no daemon — exactly when
  // the status grades reconnecting→offline by elapsed time and "Last active X ago" updates.
  const activeConnected = active?.connected === true;
  const now = useNow(connected && !activeConnected);

  // In-flight voice sends are no longer cleared on a drop here — the useVoiceControls retransmit watchdog
  // owns that lifecycle: it re-sends the same requestId until the daemon acks (a brief blip recovers on its
  // own), or gives up into a "Resend" toast. The reconnect nudge below re-sends the instant the daemon's back.

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
  // Autoplay is now purely client-side (the daemon always synthesizes): "off" means don't auto-play, just
  // tap. We still tell the daemon the mode so it knows whether to also auto-read interim STEPS ("all").
  autoplayEnabledRef.current = speakMode !== "off";
  useEffect(() => {
    if (activeThreadId && activeConnected) sendDaemon(activeThreadId, { type: "set_speak_mode", mode: speakMode });
  }, [speakMode, activeThreadId, activeConnected, sendDaemon]);

  // Auto-follow (off / on), persisted per phone. When on, a fresh reply on a background thread auto-switches
  // to it (and plays on land) — but only once nothing's playing and the user isn't recording/sending (the
  // effect below defers until then). Read via a ref in the (stable) background-reply callback.
  const [autoFollow, setAutoFollow] = useState<boolean>(() => {
    try {
      // Default ON: a fresh reply on a background thread follows it automatically (the common want).
      const stored = localStorage.getItem("vc-auto-follow");
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  autoFollowRef.current = autoFollow;
  const changeAutoFollow = useCallback((on: boolean) => {
    setAutoFollow(on);
    try {
      localStorage.setItem("vc-auto-follow", String(on));
    } catch {
      /* private mode — in-memory only */
    }
  }, []);

  // Auto-respond (off / on), persisted, default ON. Independent of autoplay/auto-follow: whenever ANY final
  // reply finishes playing — autoplayed OR manually tapped — the mic opens so you can answer and just hit
  // stop (a hands-free loop). onAutoReplyFinished gates it to a real final reply + not-already-recording.
  const [autoRespond, setAutoRespond] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem("vc-auto-respond");
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  autoRespondRef.current = autoRespond;
  const changeAutoRespond = useCallback((on: boolean) => {
    setAutoRespond(on);
    try {
      localStorage.setItem("vc-auto-respond", String(on));
    } catch {
      /* private mode — in-memory only */
    }
  }, []);

  // Theme (system / dark / light), persisted in localStorage + applied to <html>; nested in the settings menu.
  const { theme, setTheme } = useTheme();

  // Play-on-land needs the freshest pager pages / unread / playEntry inside switchThread without churning
  // its deps every render (which would re-arm the deep-link + spawn-follow refs).
  const pagerThreadsRef = useRef(pagerThreads);
  pagerThreadsRef.current = pagerThreads;
  const unreadRef = useRef(threads.unread);
  unreadRef.current = threads.unread;
  const { playEntry } = playback;
  const playEntryRef = useRef(playEntry);
  playEntryRef.current = playEntry;

  // Focus a thread (pill / dropdown / swipe settle). Stop the previous thread's audio first so it
  // doesn't keep playing under the new view — the shared player is a singleton across threads. Play-on-land:
  // if we're switching to a thread that has a PENDING unread reply, autoplay its newest reply on arrival —
  // captured BEFORE setActive clears the badge. (On first load unread is 0, so a refresh never autoplays.)
  const switchThread = useCallback(
    (threadId: ThreadId) => {
      stopPlayback();
      const hadUnread = (unreadRef.current.get(threadId) ?? 0) > 0;
      threads.setActive(threadId);
      // Play-on-land only when autoplay is on — with autoplay off, landing on the thread shows the reply
      // with a ▶ to tap, it never plays by itself.
      if (!hadUnread || !autoplayEnabledRef.current) return;
      const messages = pagerThreadsRef.current.find((p) => p.threadId === threadId)?.messages ?? [];
      const requestId = newestPlayableReply(messages);
      if (requestId) playEntryRef.current(requestId);
    },
    [stopPlayback, threads]
  );
  switchThreadRef.current = switchThread;

  // Open a new agent (the bottom switcher's "New session"). Routed to the ACTIVE thread's daemon — if it
  // isn't reachable, make that unmissable (red pill). Otherwise raise a persistent progress toast that
  // lives until the new thread joins (resolveSpawnToast in onRoster) or times out into a retryable error.
  const handleSpawnRef = useRef<() => void>(() => {});
  const handleSpawn = useCallback(() => {
    const threadId = activeThreadIdRef.current;
    if (!threadId || !sendDaemon(threadId, { type: "spawn_thread" })) {
      showFlash("Start a new session from a connected thread", "alert");
      return;
    }
    resolveSpawnToast(); // clear any prior one
    spawnToastRef.current = toast.add({ title: "Spawning a new agent…", type: "loading", timeout: 0 });
    spawnTimerRef.current = window.setTimeout(() => {
      const id = spawnToastRef.current;
      if (!id) return;
      toast.update(id, {
        type: "error",
        title: "Couldn’t spawn a new agent",
        description: "It didn’t come online in time.",
        timeout: 0,
        // Close THIS error toast before retrying — Toast.Action doesn't auto-close, and handleSpawn opens a
        // fresh loading toast, so without this the stale error would linger beside it.
        actionProps: {
          children: "Try again",
          onClick: () => {
            toast.close(id);
            handleSpawnRef.current();
          }
        }
      });
      spawnToastRef.current = null; // detach: the error toast now persists until dismissed / retried
    }, SPAWN_FOLLOW_TIMEOUT_MS);
  }, [sendDaemon, showFlash, resolveSpawnToast]);
  handleSpawnRef.current = handleSpawn;

  // Honour the resolved initial thread ONCE it shows up in the roster (the restored/deep-linked thread may
  // not be present on the first render) — falling through to the connected-default pick otherwise.
  const wantedThreadRef = useRef<ThreadId | null>(initialThreadId);
  useEffect(() => {
    const want = wantedThreadRef.current;
    if (!want) return;
    if (threads.threads.some((t) => t.threadId === want)) {
      wantedThreadRef.current = null;
      switchThread(want);
    }
  }, [threads.threads, switchThread]);
  // Persist the selected thread to localStorage so a refresh / PWA relaunch restores it. The URL is left
  // untouched (no replaceState) — a static URL is what keeps the page safe to pin as a standalone PWA.
  useEffect(() => {
    if (activeThreadId) storeActiveThread(activeThreadId);
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
  // Let the thread-messages reducer drive the in-flight send lifecycle (ack + settled) on the controller.
  sendCtlRef.current = { acked: voice.onSendAcked, settled: voice.onSendSettled };

  // Reconnect reconciliation: the instant the active thread's daemon comes back online, re-send any
  // un-acked in-flight voice clip — a brief laptop network blip drops the in-flight submit_audio at the
  // relay (the daemon never sees it), so re-sending on reconnect is what makes it land. Deduped by requestId.
  const retryInflightRef = useRef<() => void>(() => {});
  retryInflightRef.current = voice.retryInflightNow;
  const prevActiveConnectedRef = useRef(activeConnected);
  useEffect(() => {
    if (activeConnected && !prevActiveConnectedRef.current) retryInflightRef.current();
    prevActiveConnectedRef.current = activeConnected;
  }, [activeConnected]);

  // The flip side of the nudge: while we're disconnected from the in-flight send's daemon, an ALREADY-ACKED
  // send has lost its only remaining spinner-clear (the watchdog stopped on ack; the daemon owing us
  // prompt_status/history is gone). Release the spinner so the mic frees up — un-acked sends are untouched
  // (the watchdog still owns them). onConnectionLost is a no-op unless there's an acked in-flight send.
  useEffect(() => {
    if (!connected || !activeConnected) voice.onConnectionLost();
  }, [connected, activeConnected, voice.onConnectionLost]);
  // Bridge the recorder + transcribing state into the (earlier-defined) auto-respond callback.
  transcribingRef.current = transcribing;
  startRecordingRef.current = voice.onMic;

  // Track recent user interaction (touch / scroll / tap) so a deferred auto-follow can hold off until the
  // user is idle. Passive listeners on the app root; capture-phase for `scroll` (it doesn't bubble).
  useEffect(() => {
    const root = appRootRef.current;
    if (!root) return;
    const bump = () => {
      lastInteractionAtRef.current = Date.now();
    };
    const opts = { passive: true } as const;
    root.addEventListener("pointerdown", bump, opts);
    root.addEventListener("pointermove", bump, opts);
    root.addEventListener("touchstart", bump, opts);
    root.addEventListener("wheel", bump, opts);
    root.addEventListener("scroll", bump, { passive: true, capture: true });
    return () => {
      root.removeEventListener("pointerdown", bump);
      root.removeEventListener("pointermove", bump);
      root.removeEventListener("touchstart", bump);
      root.removeEventListener("wheel", bump);
      root.removeEventListener("scroll", bump, { capture: true } as EventListenerOptions);
    };
  }, []);

  // Auto-follow: perform the armed follow once nothing's playing, we're not recording/sending, AND the
  // user has been idle for INTERACTION_IDLE_MS — so it waits politely for the current reply to finish,
  // never steals the mic mid-turn, and never yanks the user away while they're touching/scrolling.
  // switchThread plays the followed thread's pending reply on land. Stays armed (deferred) until all
  // blocking clears. Pointer activity doesn't re-render, so when only the idle window is left we re-arm a
  // short timer that bumps `followTick` to re-evaluate after it elapses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: followTick is an intentional re-run trigger
  useEffect(() => {
    if (!pendingFollow || playback.speaking || voice.recording || transcribing) return;
    const idleFor = Date.now() - lastInteractionAtRef.current;
    if (idleFor < INTERACTION_IDLE_MS) {
      const timer = window.setTimeout(() => setFollowTick((t) => t + 1), INTERACTION_IDLE_MS - idleFor);
      return () => window.clearTimeout(timer);
    }
    const target = pendingFollow;
    setPendingFollow(null);
    if (target !== activeThreadId) switchThread(target);
  }, [pendingFollow, followTick, playback.speaking, voice.recording, transcribing, activeThreadId, switchThread]);

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
    paused: playback.paused,
    playableIds: playback.playableIds,
    audioStatus: playback.audioStatus,
    pendingPlayId: playback.pendingPlayId,
    onPlay: playback.playEntry,
    onReplay: playback.replayEntry,
    onSeek: playback.seekEntry,
    // Question wizard: submit every collected answer, or step back one sub-question. Both target the active
    // thread (only its card is interactive — see MessageThread `live`).
    onQuestionConfirm: (toolUseId: string) => {
      if (activeThreadId) sendDaemon(activeThreadId, { type: "confirm_question", toolUseId });
    },
    onQuestionRedo: (toolUseId: string) => {
      if (activeThreadId) sendDaemon(activeThreadId, { type: "redo_answer", toolUseId });
    }
  };

  // An off-screen slide shows ITS OWN thread's calm status (connection/runtime only), derived from that
  // thread's roster entry. The live overlays — recording / speaking / the working timer / a flash — belong
  // to the ACTIVE thread alone (the mic + player are shared singletons), so they must never bleed onto
  // another slide's pill (the "shared state across slides" we're guarding against).
  const inactiveThreadStatus = (threadId: ThreadId): StatusView => {
    const t = threads.threads.find((r) => r.threadId === threadId);
    return deriveStatus({
      connected,
      daemonConnected: t?.connected === true,
      daemonLastSeenAt: t?.lastSeenAt ?? null,
      now,
      recording: false,
      transcribing: false,
      speaking: false,
      runtimeState: t?.state ?? "idle",
      currentTask: undefined,
      listening: t?.listening === true,
      flash: null
    });
  };

  // The hero is rendered IN THE FLOW at the top of each pager page (so it scrolls away like a normal
  // header — never a pinned overlay). Only the ACTIVE page gets the live mic/canvas + the active status;
  // off-screen pages show their own thread's at-rest status so the pill never mirrors the active thread.
  const renderHero = (isActive: boolean, threadId: ThreadId) => (
    <Hero
      status={isActive ? status : inactiveThreadStatus(threadId)}
      elapsed={isActive ? elapsed : 0}
      flash={isActive ? flash : null}
      flashAlert={isActive && flashTone === "alert"}
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

  const settings = (
    <SettingsMenu
      speakMode={speakMode}
      onSpeakModeChange={changeSpeakMode}
      autoFollow={autoFollow}
      onAutoFollowChange={changeAutoFollow}
      autoRespond={autoRespond}
      onAutoRespondChange={changeAutoRespond}
      theme={theme}
      onThemeChange={setTheme}
    />
  );

  if (expired) return <SessionExpired reason={expired} />;

  return (
    <div ref={appRootRef} className="flex h-full flex-col bg-canvas px-safe">
      <Toaster />

      {/* One fixed-height, glass header slot shared by the nav and the condensed control bar: the nav
          slides OUT and the condensed bar slides IN to REPLACE it (not an overlay below it) once the
          active page's hero scrolls away — so scrolled reading gets the whole screen. */}
      <div className="relative shrink-0 pt-safe">
        <TopBar
          className={cn(
            "transition-[transform,opacity] duration-300 ease-soft",
            condensed ? "pointer-events-none -translate-y-2 opacity-0" : "translate-y-0 opacity-100"
          )}
        >
          {settings}
        </TopBar>
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
      </div>

      <div className="relative min-h-0 flex-1">
        {pagerThreads.length === 0 ? (
          // No threads yet (fresh load, malformed/stale link, daemon not joined) — the carousel would
          // render nothing, so show the hero + status standalone instead of a blank screen.
          <div className="flex h-full flex-col overflow-y-auto pb-safe">
            {/* isActive → uses the active `status`; threadId is unused here (no thread yet). */}
            {renderHero(true, activeThreadId ?? "")}
            <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 pb-16 text-center">
              <p className="text-sm font-medium text-ink-soft">{status.title}</p>
              {status.detail && <p className="text-xs text-ink-faint">{status.detail}</p>}
            </div>
          </div>
        ) : (
          <ThreadPager
            threads={pagerThreads}
            activeThreadId={activeThreadId}
            renderHero={renderHero}
            playback={threadPlayback}
            onActivate={switchThread}
            activeScrollRootRef={setScrollRoot}
            activeSentinelRef={setHeroSentinel}
          />
        )}

        {/* Bottom "liquid glass" thread switcher + swipe dots — only when there's more than one thread. */}
        <BottomSwitcher
          rows={switcherRows}
          activeThreadId={activeThreadId}
          onSelect={switchThread}
          onSpawn={handleSpawn}
        />
      </div>
    </div>
  );
}
