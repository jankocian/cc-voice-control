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
  showFlash: (message: string) => void;
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

  const recorder = useRecorder({ canvasRef, onClip, onError: onRecorderError, onStart: stopPlayback });
  recordingRef.current = recorder.recording;

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
    [transcribing, bridgeReady, recorder, showFlash, activeThreadIdRef]
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

  // The "+" affordance emits spawn_thread on the ACTIVE thread's daemon (it has the cmux trust to open
  // another pane, at the active pane's cwd, inheriting its permission mode). The daemon arms the follow
  // (spawn_pending) only once the workspace actually opens, so the phone follows a real spawn.
  const onSpawn = useCallback(() => {
    const threadId = activeThreadIdRef.current;
    if (!threadId || !sendDaemon(threadId, { type: "spawn_thread" })) {
      showFlash("Start voice in a pane first");
      return;
    }
    showFlash("Opening a new session…");
  }, [sendDaemon, showFlash, activeThreadIdRef]);

  // Free the mic/stream when the page is hidden (iOS backgrounding).
  useEffect(() => {
    const onPageHide = () => recorder.teardown();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [recorder]);

  return {
    recording: recorder.recording,
    visualizerActive: recorder.visualizerActive,
    onMic: useCallback(() => startRecording("queue"), [startRecording]),
    onSteer: useCallback(() => startRecording("queue"), [startRecording]),
    onInterrupt: useCallback(() => startRecording("interrupt"), [startRecording]),
    onStopRecording: useCallback(() => recorder.stop(), [recorder]),
    onCancel: useCallback(() => recorder.cancel(), [recorder]),
    onStopTask: useCallback(() => sendControl({ type: "stop_task" }), [sendControl]),
    onSpawn
  };
}
