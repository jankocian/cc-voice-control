import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Controls } from "./components/Controls";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { StatusPanel } from "./components/StatusPanel";
import { type BridgeContentEvent, useBridge } from "./hooks/useBridge";
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
  const [pending, setPending] = useState<RecordedClip | null>(null);

  // The requestId of the most recent reply rendered; sent on sync so the daemon
  // can replay one the phone missed. Held in a ref so useBridge reads it lazily.
  const lastReplyIdRef = useRef<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useWakeLock();

  // ---- recording state shared with playback (auto-play guard) ----------------
  const recordingRef = useRef(false);
  const getRecording = useCallback(() => recordingRef.current, []);

  const playback = usePlayback({ getRecording });
  const { dropAudio, attachAudio, stopPlayback, playEntry, replayEntry } = playback;

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

  // A dropped socket loses any in-flight send — re-enable the mic and drop the
  // pending clip (mirrors the vanilla `close` handler).
  useEffect(() => {
    if (!connected) {
      setTranscribing(false);
      setPending(null);
    }
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

  const onClip = useCallback(
    (clip: RecordedClip) => {
      // While Claude is working, let the user choose: queue behind the turn, or interrupt.
      if (runtime.state === "working") {
        setPending(clip);
        return;
      }
      sendAudio(clip, "queue");
    },
    [runtime.state, sendAudio]
  );

  const onRecorderError = useCallback((error: RecorderError) => showFlash(RECORDER_ERROR_TEXT[error]), [showFlash]);

  const recorder = useRecorder({
    canvasRef,
    onClip,
    onError: onRecorderError,
    onStart: stopPlayback
  });
  recordingRef.current = recorder.recording;

  const toggleRecording = useCallback(() => {
    if (transcribing) return;
    if (recorder.recording) {
      recorder.stop();
      return;
    }
    if (!bridgeReady()) {
      showFlash("Not connected to Claude Code yet");
      return;
    }
    setPending(null); // re-recording discards a clip awaiting a send choice
    void recorder.start();
  }, [transcribing, recorder, bridgeReady, showFlash]);

  const sendPending = useCallback(
    (mode: "queue" | "interrupt") => {
      if (!pending) return;
      const clip = pending;
      setPending(null);
      sendAudio(clip, mode);
    },
    [pending, sendAudio]
  );

  // ---- control buttons -------------------------------------------------------
  const sendControl = useCallback(
    (command: { type: "summary_request" } | { type: "status_request" } | { type: "stop_task" }) => {
      if (!sendDaemon(command)) showFlash(bridgeReady() ? "Couldn't reach Claude Code" : "Not connected yet");
    },
    [sendDaemon, bridgeReady, showFlash]
  );

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

  return (
    <main>
      <Header rateLabel={playback.formattedRate} onCycleSpeed={playback.cycleSpeed} />
      <StatusPanel status={status} />
      <Controls
        canAct={status.canAct}
        recording={recorder.recording}
        transcribing={transcribing}
        visualizerActive={recorder.visualizerActive}
        pending={pending !== null}
        canvasRef={canvasRef}
        onToggleRecord={toggleRecording}
        onQueue={() => sendPending("queue")}
        onInterrupt={() => sendPending("interrupt")}
        onSummary={() => sendControl({ type: "summary_request" })}
        onStatus={() => sendControl({ type: "status_request" })}
        onStop={() => sendControl({ type: "stop_task" })}
      />
      <MessageList
        messages={messages}
        playableIds={playback.playableIds}
        playingId={playback.playingId}
        onPlay={playEntry}
        onReplay={replayEntry}
      />
    </main>
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
