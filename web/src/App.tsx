import { useCallback, useEffect, useRef, useState } from "react";
import { BottomTabBar } from "./components/BottomTabBar";
import { Hero } from "./components/Hero";
import { MessageThread } from "./components/MessageThread";
import { TopBar } from "./components/TopBar";
import { type BridgeContentEvent, useBridge } from "./hooks/useBridge";
import { useElapsed } from "./hooks/useElapsed";
import { useFlash } from "./hooks/useFlash";
import { usePlayback } from "./hooks/usePlayback";
import { type RecordedClip, type RecorderError, useRecorder } from "./hooks/useRecorder";
import { useWakeLock } from "./hooks/useWakeLock";
import { MAX_LOG, type Message, makeMessage } from "./lib/messages";
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

  // The requestId of the most recent reply rendered; sent on sync so the daemon
  // can replay one the phone missed. Held in a ref so useBridge reads it lazily.
  const lastReplyIdRef = useRef<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useWakeLock();

  // ---- recording state shared with playback (auto-play guard) ----------------
  const recordingRef = useRef(false);
  const getRecording = useCallback(() => recordingRef.current, []);

  const playback = usePlayback({ getRecording });
  const { dropAudio, attachAudio, stopPlayback, playEntry, replayEntry, seekEntry } = playback;

  // ---- bridge ----------------------------------------------------------------
  const handleContentEvent = useCallback(
    (event: BridgeContentEvent) => {
      switch (event.type) {
        case "transcript":
          setTranscribing(false);
          setMessages((prev) => pruneAndAdd(prev, makeMessage("You", event.text), dropAudio));
          showFlash("Sent to Claude Code ✓");
          return;
        case "claude_reply": {
          const message = makeMessage("Claude Code", event.text, event.requestId);
          if (event.requestId) lastReplyIdRef.current = event.requestId;
          setMessages((prev) => pruneAndAdd(prev, message, dropAudio));
          return;
        }
        case "tts_audio":
          attachAudio(event.requestId, event.audioBase64, event.mimeType, event.replay === true);
          return;
        case "error":
          setTranscribing(false);
          showFlash(event.message);
          return;
      }
    },
    [attachAudio, dropAudio, showFlash]
  );

  const getLastReplyId = useCallback(() => lastReplyIdRef.current, []);

  const bridge = useBridge({
    sessionId: credentials.sessionId,
    token: credentials.token,
    onEvent: handleContentEvent,
    getLastReplyId
  });
  const { connected, daemonConnected, runtime, bridgeReady, sendDaemon } = bridge;

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

  // Push-to-talk: tap to start (queue mode), tap to stop+send.
  const toggleRecording = useCallback(() => {
    if (transcribing) return;
    if (recorder.recording) {
      recorder.stop();
      return;
    }
    startRecording("queue");
  }, [transcribing, recorder, startRecording]);

  // ---- working-state controls ------------------------------------------------
  const sendControl = useCallback(
    (command: { type: "summary_request" } | { type: "status_request" } | { type: "stop_task" }) => {
      if (!sendDaemon(command)) showFlash(bridgeReady() ? "Couldn't reach Claude Code" : "Not connected yet");
    },
    [sendDaemon, bridgeReady, showFlash]
  );

  // Interrupt: record a message that interrupts the running turn (Esc + run now).
  // Tap again while recording to send it.
  const onInterrupt = useCallback(() => {
    if (recorder.recording) {
      recorder.stop();
      return;
    }
    startRecording("interrupt");
  }, [recorder, startRecording]);

  // Steer: record a guiding message queued behind the running turn.
  // TODO: there is no dedicated "steer" event in the bridge protocol
  // (src/shared/protocol.ts). Queue-mode submit is the closest existing behaviour;
  // wire a real steering event here if/when the daemon gains one.
  const onSteer = useCallback(() => {
    if (recorder.recording) {
      recorder.stop();
      return;
    }
    startRecording("queue");
  }, [recorder, startRecording]);

  // Stop: the existing stop_task event.
  const onStop = useCallback(() => {
    if (recorder.recording) recorder.stop();
    sendControl({ type: "stop_task" });
  }, [recorder, sendControl]);

  // ---- teardown (pagehide) ---------------------------------------------------
  useEffect(() => {
    const onPageHide = () => recorder.teardown();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [recorder]);

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

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TopBar online={status.dataState !== "offline"} />

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Hero
          status={status}
          elapsed={elapsed}
          recording={recorder.recording}
          visualizerActive={recorder.visualizerActive}
          canvasRef={canvasRef}
          speedLabel={playback.formattedRate}
          onToggleRecord={toggleRecording}
          onCycleSpeed={playback.cycleSpeed}
          onInterrupt={onInterrupt}
          onSteer={onSteer}
          onStop={onStop}
        />

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

      <BottomTabBar />
    </div>
  );
}

// Prepend (newest first) then prune to MAX_LOG, dropping cached audio for evicted
// rows. Mirrors the vanilla addLog + pruneLog (bounded memory).
function pruneAndAdd(prev: Message[], message: Message, dropAudio: (requestId: string) => void): Message[] {
  const next = [message, ...prev];
  while (next.length > MAX_LOG) {
    const removed = next.pop();
    if (removed?.requestId) dropAudio(removed.requestId);
  }
  return next;
}
