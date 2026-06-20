import { useCallback, useEffect, useRef, useState } from "react";
import { BottomTabBar } from "./components/BottomTabBar";
import { Hero } from "./components/Hero";
import { MessageThread } from "./components/MessageThread";
import { MiniControls } from "./components/MiniControls";
import { TopBar } from "./components/TopBar";
import { type BridgeContentEvent, useBridge } from "./hooks/useBridge";
import { useElapsed } from "./hooks/useElapsed";
import { useFlash } from "./hooks/useFlash";
import { usePlayback } from "./hooks/usePlayback";
import { type RecordedClip, type RecorderError, useRecorder } from "./hooks/useRecorder";
import { useWakeLock } from "./hooks/useWakeLock";
import { FEATURES } from "./lib/features";
import { type Message, makeMessage, messageFromHistory, reconcileMessages } from "./lib/messages";
import type { SessionCredentials } from "./lib/session";
import { deriveStatus } from "./lib/status";

const RECORDER_ERROR_TEXT: Record<RecorderError, string> = {
  "not-supported": "This browser cannot record audio",
  "mic-blocked": "Microphone blocked — allow it and try again",
  empty: "Didn't catch that — tap to retry",
  "read-failed": "Could not read the recording"
};

export function App({ credentials }: { credentials: SessionCredentials }) {
  const { flash, show: showFlash } = useFlash();

  const [messages, setMessages] = useState<Message[]>([]);
  const [transcribing, setTranscribing] = useState(false);

  // The mode the *next* finished clip should submit with. "queue" for a normal
  // push-to-talk turn; "interrupt" when the user tapped Interrupt while the agent
  // works (also reused for Steer — see the working-state handlers below).
  const nextModeRef = useRef<"queue" | "interrupt">("queue");

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Scroll container + a sentinel at the end of the hero: once the hero scrolls out
  // of view we reveal a condensed, sticky control bar (<MiniControls>) so the mic /
  // stop stay reachable while reading the message history.
  const scrollRef = useRef<HTMLDivElement>(null);
  const heroSentinelRef = useRef<HTMLDivElement>(null);
  const [condensed, setCondensed] = useState(false);

  useWakeLock();

  // ---- recording state shared with playback (auto-play guard) ----------------
  const recordingRef = useRef(false);
  const getRecording = useCallback(() => recordingRef.current, []);

  // Audio-on-demand: tapping play on a history row calls back here to fetch its bytes.
  // sendDaemon comes from the bridge below (declared after playback), so we read it lazily
  // through a ref to break the playback↔bridge cycle.
  const sendDaemonRef = useRef<((command: { type: "get_audio"; requestId: string }) => boolean) | null>(null);
  const onRequestAudio = useCallback((requestId: string) => {
    sendDaemonRef.current?.({ type: "get_audio", requestId });
  }, []);

  const playback = usePlayback({ getRecording, onRequestAudio });
  const { dropAudio, attachAudio, markPlayable, stopPlayback, playEntry, replayEntry, seekEntry } = playback;

  // ---- bridge ----------------------------------------------------------------
  const handleContentEvent = useCallback(
    (event: BridgeContentEvent) => {
      switch (event.type) {
        case "transcript":
          setTranscribing(false);
          setMessages((prev) =>
            reconcileAndPrune(
              prev,
              [makeMessage("You", event.text, event.requestId, { seq: event.seq, timestamp: event.timestamp })],
              dropAudio
            )
          );
          showFlash("Sent to Claude Code ✓");
          return;
        case "claude_reply": {
          const message = makeMessage("Claude Code", event.text, event.requestId, {
            seq: event.seq,
            timestamp: event.timestamp
          });
          setMessages((prev) => reconcileAndPrune(prev, [message], dropAudio));
          return;
        }
        case "history": {
          // Reconnect / refresh / 2nd browser: restore the retained thread. Merge by seq and
          // mark fetchable replies playable (tap-to-play before their bytes are requested).
          const restored = event.turns.map(messageFromHistory);
          markPlayable(event.turns.filter((t) => t.hasAudio).map((t) => t.requestId));
          setMessages((prev) => reconcileAndPrune(prev, restored, dropAudio));
          return;
        }
        case "tts_audio":
          attachAudio(event.requestId, event.audioBase64, event.mimeType, event.replay === true);
          return;
        case "error":
          setTranscribing(false);
          // The only error carrying a requestId is a `get_audio` miss (that reply's audio was
          // evicted from the daemon ring). Drop the row so it stops rendering a dead, re-missing
          // play button and any pending tap-to-play is cleared.
          if (event.requestId) dropAudio(event.requestId);
          showFlash(event.message);
          return;
      }
    },
    [attachAudio, dropAudio, markPlayable, showFlash]
  );

  const bridge = useBridge({
    secret: credentials.secret,
    onEvent: handleContentEvent
  });
  const { connected, daemonConnected, runtime, bridgeReady, sendDaemon } = bridge;

  // Publish sendDaemon to the lazy ref the audio-on-demand callback reads (breaks the
  // playback↔bridge declaration cycle without re-creating either on every render).
  sendDaemonRef.current = sendDaemon;

  // A dropped socket loses any in-flight send — re-enable the mic.
  useEffect(() => {
    if (!connected) setTranscribing(false);
  }, [connected]);

  // ---- recorder --------------------------------------------------------------
  const sendAudio = useCallback(
    (clip: RecordedClip, mode: "queue" | "interrupt") => {
      const ok = sendDaemon({ type: "submit_audio", audioBase64: clip.audioBase64, mimeType: clip.mimeType, mode });
      if (!ok) {
        showFlash("Lost the connection before sending");
        return;
      }
      setTranscribing(true);
    },
    [sendDaemon, showFlash]
  );

  // Submit with the mode chosen when recording started (queue by default; interrupt
  // when Interrupt/Steer kicked off the recording during a working turn).
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

  // Start a recording with a target submit mode. Returns false if not ready.
  const startRecording = useCallback(
    (mode: "queue" | "interrupt") => {
      if (transcribing) return;
      if (!bridgeReady()) {
        showFlash("Not connected to Claude Code yet");
        return;
      }
      nextModeRef.current = mode;
      void recorder.start();
    },
    [transcribing, bridgeReady, recorder, showFlash]
  );

  // Idle mic: start a normal push-to-talk turn (queue mode).
  const onMic = useCallback(() => startRecording("queue"), [startRecording]);

  // While recording, the center FAB is a red stop-square: stop capture and send.
  const onStopRecording = useCallback(() => recorder.stop(), [recorder]);

  // Cancel (✕) while recording: abort capture without sending anything.
  const onCancel = useCallback(() => recorder.cancel(), [recorder]);

  // ---- working-state controls ------------------------------------------------
  const sendControl = useCallback(
    (command: { type: "summary_request" } | { type: "status_request" } | { type: "stop_task" }) => {
      if (!sendDaemon(command)) showFlash(bridgeReady() ? "Couldn't reach Claude Code" : "Not connected yet");
    },
    [sendDaemon, bridgeReady, showFlash]
  );

  // Interrupt: record a message that interrupts the running turn (Esc + run now).
  const onInterrupt = useCallback(() => startRecording("interrupt"), [startRecording]);

  // Steer (the working-state center mic): record a guiding message queued behind
  // the running turn.
  // TODO: there is no dedicated "steer" event in the bridge protocol
  // (src/shared/protocol.ts). Queue-mode submit is the closest existing behaviour;
  // wire a real steering event here if/when the daemon gains one.
  const onSteer = useCallback(() => startRecording("queue"), [startRecording]);

  // Stop the running task (the working, non-recording UI has no clip in flight).
  const onStopTask = useCallback(() => sendControl({ type: "stop_task" }), [sendControl]);

  // ---- teardown (pagehide) ---------------------------------------------------
  useEffect(() => {
    const onPageHide = () => recorder.teardown();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [recorder]);

  // Bless the audio element on the first user gesture so replies autoplay reliably
  // (browser autoplay policy / iOS Safari block programmatic play() otherwise).
  const { unlock } = playback;
  useEffect(() => {
    const onFirstTap = () => unlock();
    window.addEventListener("pointerdown", onFirstTap, { once: true });
    return () => window.removeEventListener("pointerdown", onFirstTap);
  }, [unlock]);

  // Reveal the condensed controls when the hero (its sentinel) leaves the viewport.
  useEffect(() => {
    const root = scrollRef.current;
    const target = heroSentinelRef.current;
    if (!root || !target) return;
    const obs = new IntersectionObserver(([entry]) => setCondensed(!entry.isIntersecting), { root, threshold: 0 });
    obs.observe(target);
    return () => obs.disconnect();
  }, []);

  // ---- derive view -----------------------------------------------------------
  const status = deriveStatus({
    connected,
    daemonConnected,
    recording: recorder.recording,
    transcribing,
    speaking: playback.speaking,
    runtimeState: runtime.state,
    currentTask: runtime.currentTask,
    listening: runtime.listening,
    flash
  });

  const elapsed = useElapsed(status.dataState === "working");

  const working = status.dataState === "working";

  return (
    <div className="flex h-full flex-col bg-canvas px-safe">
      <TopBar online={status.dataState !== "offline"} />

      <div className="relative min-h-0 flex-1">
        <main ref={scrollRef} className="flex h-full flex-col overflow-y-auto pb-safe">
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

          {/* Sentinel: when this leaves the top, the condensed bar appears. */}
          <div ref={heroSentinelRef} aria-hidden="true" className="h-px w-full shrink-0" />

          <MessageThread
            messages={messages}
            playback={{
              playingId: playback.playingId,
              loadedId: playback.loadedId,
              position: playback.position,
              duration: playback.duration,
              playableIds: playback.playableIds,
              onPlay: playEntry,
              onReplay: replayEntry,
              onSeek: seekEntry
            }}
          />
        </main>

        {/* Condensed, sticky controls — slides in once the hero scrolls away. */}
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

      {FEATURES.threadNav && <BottomTabBar />}
    </div>
  );
}

// Reconcile incoming rows into the thread (merge/dedup/order by seq), then drop cached
// audio for any row that fell out of the capped window — preserving the vanilla client's
// bounded-memory pruning now that reconcileMessages owns the MAX_LOG cap.
function reconcileAndPrune(prev: Message[], incoming: Message[], dropAudio: (requestId: string) => void): Message[] {
  const next = reconcileMessages(prev, incoming);
  const kept = new Set(next.map((m) => m.requestId).filter((id): id is string => id !== undefined));
  for (const message of prev) {
    if (message.requestId && !kept.has(message.requestId)) dropAudio(message.requestId);
  }
  return next;
}
