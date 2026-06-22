import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { ThreadId } from "../lib/protocol";
import type { useBridge } from "./useBridge";
import { type RecordedClip, type RecorderError, useRecorder } from "./useRecorder";

const RECORDER_ERROR_TEXT: Record<RecorderError, string> = {
  "not-supported": "This browser cannot record audio",
  "mic-blocked": "Microphone blocked — allow it and try again",
  empty: "Didn't catch that — tap to retry",
  "read-failed": "Could not read the recording"
};

type Bridge = ReturnType<typeof useBridge>;

type Deps = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  // App owns recordingRef (usePlayback's auto-play guard reads it, and is created before this hook); we
  // keep it in sync with the recorder.
  recordingRef: RefObject<boolean>;
  activeThreadIdRef: RefObject<ThreadId | null>;
  transcribing: boolean;
  setTranscribingThreadId: (id: ThreadId | null) => void;
  sendDaemon: Bridge["sendDaemon"];
  bridgeReady: Bridge["bridgeReady"];
  stopPlayback: () => void;
  showFlash: (message: string, tone?: "info" | "alert") => void;
};

// The shared mic + working-state commands, all acting on the active thread. Owns the recorder
// (a singleton), the next-turn mode, and the spawn trigger; returns the handler bag the hero/mini
// controls bind to, plus the live recording flags.
export function useVoiceControls({
  canvasRef,
  recordingRef,
  activeThreadIdRef,
  transcribing,
  setTranscribingThreadId,
  sendDaemon,
  bridgeReady,
  stopPlayback,
  showFlash
}: Deps) {
  const nextModeRef = useRef<"queue" | "interrupt">("queue");

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
    [sendDaemon, showFlash, activeThreadIdRef, setTranscribingThreadId]
  );

  const onClip = useCallback(
    (clip: RecordedClip) => {
      sendAudio(clip, nextModeRef.current);
      nextModeRef.current = "queue";
    },
    [sendAudio]
  );

  const onRecorderError = useCallback((error: RecorderError) => showFlash(RECORDER_ERROR_TEXT[error]), [showFlash]);

  // Destructure the recorder's STABLE methods + state (the wrapper is recreated when recording state
  // changes) so the callbacks/effects below depend on the methods, not the churning wrapper.
  const { recording, visualizerActive, start, stop, cancel, teardown } = useRecorder({
    canvasRef,
    onClip,
    onError: onRecorderError,
    onStart: stopPlayback
  });
  recordingRef.current = recording;

  const startRecording = useCallback(
    (mode: "queue" | "interrupt") => {
      if (transcribing) return;
      if (!bridgeReady(activeThreadIdRef.current)) {
        showFlash("Not connected to Claude Code yet");
        return;
      }
      nextModeRef.current = mode;
      void start();
    },
    [transcribing, bridgeReady, start, showFlash, activeThreadIdRef]
  );

  const sendControl = useCallback(
    (command: { type: "status_request" } | { type: "stop_task" }) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId || !sendDaemon(threadId, command)) {
        showFlash(bridgeReady(activeThreadIdRef.current) ? "Couldn't reach Claude Code" : "Not connected yet");
      }
    },
    [sendDaemon, bridgeReady, showFlash, activeThreadIdRef]
  );

  // Free the mic/stream when the page is hidden (iOS backgrounding).
  useEffect(() => {
    const onPageHide = () => teardown();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [teardown]);

  return {
    recording,
    visualizerActive,
    onMic: useCallback(() => startRecording("queue"), [startRecording]),
    onSteer: useCallback(() => startRecording("queue"), [startRecording]),
    onInterrupt: useCallback(() => startRecording("interrupt"), [startRecording]),
    onStopRecording: useCallback(() => stop(), [stop]),
    onCancel: useCallback(() => cancel(), [cancel]),
    onStopTask: useCallback(() => sendControl({ type: "stop_task" }), [sendControl])
  };
}
