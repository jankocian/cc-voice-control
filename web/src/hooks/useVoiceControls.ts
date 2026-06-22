import { type RefObject, useCallback, useEffect, useRef } from "react";
import { toast } from "../components/Toaster";
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
  // The last clip we attempted to send (clip + mode + the thread it was for), retained so a failed send
  // can be re-tried from a toast. A "resend" calls sendAudio again via a ref (sendAudio is defined below).
  const lastSendRef = useRef<{ clip: RecordedClip; mode: "queue" | "interrupt" } | null>(null);
  const resendToastRef = useRef<string | null>(null);
  const sendAudioRef = useRef<(clip: RecordedClip, mode: "queue" | "interrupt") => void>(() => {});

  // A retryable error toast with a "Resend" action — one at a time (replace any prior). Re-sends the last
  // retained clip down the same path (a fresh submit_audio to the then-active thread).
  const raiseResendToast = useCallback(() => {
    if (resendToastRef.current) toast.close(resendToastRef.current);
    resendToastRef.current = toast.add({
      title: "Couldn’t send your voice",
      type: "error",
      timeout: 0,
      actionProps: {
        children: "Resend",
        onClick: () => {
          const last = lastSendRef.current;
          if (last) sendAudioRef.current(last.clip, last.mode);
        }
      }
    });
  }, []);
  // Dismiss a stale resend toast (a new recording / a confirmed send supersedes a prior failure).
  const clearResendToast = useCallback(() => {
    if (resendToastRef.current) toast.close(resendToastRef.current);
    resendToastRef.current = null;
  }, []);

  const sendAudio = useCallback(
    (clip: RecordedClip, mode: "queue" | "interrupt") => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) {
        showFlash("Lost the connection before sending");
        return;
      }
      // Retain the attempt so a failed send (here or a later daemon `error`) can be re-tried.
      lastSendRef.current = { clip, mode };
      if (
        !sendDaemon(threadId, { type: "submit_audio", audioBase64: clip.audioBase64, mimeType: clip.mimeType, mode })
      ) {
        showFlash("Lost the connection before sending");
        raiseResendToast();
        return;
      }
      setTranscribingThreadId(threadId);
    },
    [sendDaemon, showFlash, activeThreadIdRef, setTranscribingThreadId, raiseResendToast]
  );
  sendAudioRef.current = sendAudio;

  const onClip = useCallback(
    (clip: RecordedClip) => {
      clearResendToast(); // a new recording supersedes any stale failed send
      sendAudio(clip, nextModeRef.current);
      nextModeRef.current = "queue";
    },
    [sendAudio, clearResendToast]
  );

  const onRecorderError = useCallback((error: RecorderError) => showFlash(RECORDER_ERROR_TEXT[error]), [showFlash]);

  // Destructure the recorder's STABLE methods + state (the wrapper is recreated when recording state
  // changes) so the callbacks/effects below depend on the methods, not the churning wrapper.
  const { recording, visualizerActive, start, stop, cancel, suspend } = useRecorder({
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

  // On iOS backgrounding, SUSPEND rather than free the mic: a brief background (locking the
  // screen to walk, swapping apps) shouldn't drop the held stream and force a permission
  // re-prompt on the next record. We hold the stream; the next record reuses it if iOS kept the
  // track live, or re-acquires if iOS ended it. The recorder's own unmount cleanup hard-releases.
  useEffect(() => {
    const onPageHide = () => suspend();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [suspend]);

  return {
    recording,
    visualizerActive,
    // A failed in-flight send (a daemon `error` for the active thread) → raise the retry toast; clear it
    // once the turn is confirmed. App routes the thread-messages reducer's send outcome to these.
    raiseResendToast,
    clearResendToast,
    onMic: useCallback(() => startRecording("queue"), [startRecording]),
    onSteer: useCallback(() => startRecording("queue"), [startRecording]),
    onInterrupt: useCallback(() => startRecording("interrupt"), [startRecording]),
    onStopRecording: useCallback(() => stop(), [stop]),
    onCancel: useCallback(() => cancel(), [cancel]),
    onStopTask: useCallback(() => sendControl({ type: "stop_task" }), [sendControl])
  };
}
