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

// Retransmit schedule for an un-acked submit_audio: how long to wait for the daemon's receipt ack before
// re-sending the SAME requestId. One entry per transmit (initial + 2 retries); spacing grows so a brief
// blip recovers fast (≈3s) while a longer outage gets two more tries before we give up (~21s total) and
// surface a manual "Resend". The daemon dedups by requestId, so every retransmit is harmless if it arrives.
const ACK_WAIT_MS = [3000, 6000, 12000];

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
  // The last clip the user recorded (clip + mode), retained so the "Resend" toast can start a fresh
  // delivery round after automatic retries are exhausted. A "resend" calls sendAudio via a ref (defined below).
  const lastSendRef = useRef<{ clip: RecordedClip; mode: "queue" | "interrupt" } | null>(null);
  const resendToastRef = useRef<string | null>(null);
  const sendAudioRef = useRef<(clip: RecordedClip, mode: "queue" | "interrupt") => void>(() => {});

  // The in-flight voice send + its retransmit watchdog. submit_audio can be silently dropped at the relay
  // during a brief network blip (the daemon never sees it — see submit_ack in the protocol), so we re-send
  // the SAME requestId until the daemon acks receipt; it dedups by requestId, so a retransmit never
  // duplicates the prompt. `acked` stops the loop (the turn then lands via the usual prompt_status/history).
  const inflightRef = useRef<{
    clip: RecordedClip;
    mode: "queue" | "interrupt";
    threadId: ThreadId;
    requestId: string;
    attempt: number; // 0-based; indexes ACK_WAIT_MS
    acked: boolean;
  } | null>(null);
  const retryTimerRef = useRef(0);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = 0;
  }, []);

  // Dismiss a stale resend toast (a new recording / a confirmed send supersedes a prior failure).
  const clearResendToast = useCallback(() => {
    if (resendToastRef.current) toast.close(resendToastRef.current);
    resendToastRef.current = null;
  }, []);
  // A retryable error toast with a "Resend" action — one at a time (replace any prior). Tapping it starts a
  // brand-new delivery round (fresh requestId) for the retained clip.
  const raiseResendToast = useCallback(() => {
    if (resendToastRef.current) toast.close(resendToastRef.current);
    resendToastRef.current = toast.add({
      title: "Couldn’t send your voice",
      description: "Your laptop seems unreachable.",
      type: "error",
      timeout: 0,
      actionProps: {
        children: "Resend",
        onClick: () => {
          // Dismiss this error toast first (Toast.Action doesn't auto-close) so the retry doesn't leave a
          // stale "couldn't send" showing while it's actually re-sending; a fresh failure re-raises it.
          clearResendToast();
          const last = lastSendRef.current;
          if (last) sendAudioRef.current(last.clip, last.mode);
        }
      }
    });
  }, [clearResendToast]);

  // Put one copy of the in-flight clip on the wire (same requestId every time). A false return just means
  // the bridge can't take it right now (socket/thread down) — the watchdog drives the next attempt anyway.
  const sendOnce = useCallback((): boolean => {
    const f = inflightRef.current;
    if (!f) return false;
    return sendDaemon(f.threadId, {
      type: "submit_audio",
      requestId: f.requestId,
      audioBase64: f.clip.audioBase64,
      mimeType: f.clip.mimeType,
      mode: f.mode
    });
  }, [sendDaemon]);

  // Give up on the in-flight send: drop it + the spinner, raise the actionable "Resend" toast.
  const giveUp = useCallback(() => {
    clearRetryTimer();
    inflightRef.current = null;
    setTranscribingThreadId(null);
    raiseResendToast();
  }, [clearRetryTimer, setTranscribingThreadId, raiseResendToast]);

  // Transmit the current attempt and arm the ack watchdog. On timeout: advance to the next attempt (its
  // wait grows per ACK_WAIT_MS), or give up once the schedule is spent. Acked sends short-circuit the tick.
  const transmit = useCallback(() => {
    const f = inflightRef.current;
    if (!f) return;
    sendOnce();
    setTranscribingThreadId(f.threadId);
    clearRetryTimer();
    retryTimerRef.current = window.setTimeout(
      () => {
        const cur = inflightRef.current;
        if (!cur || cur.acked) return;
        cur.attempt += 1;
        if (cur.attempt >= ACK_WAIT_MS.length) giveUp();
        else transmit();
      },
      ACK_WAIT_MS[Math.min(f.attempt, ACK_WAIT_MS.length - 1)]
    );
  }, [sendOnce, setTranscribingThreadId, clearRetryTimer, giveUp]);

  const sendAudio = useCallback(
    (clip: RecordedClip, mode: "queue" | "interrupt") => {
      lastSendRef.current = { clip, mode };
      const threadId = activeThreadIdRef.current;
      if (!threadId) {
        // Nothing to address (no active thread) — surface "Resend" so the clip isn't silently lost.
        giveUp();
        return;
      }
      clearRetryTimer();
      inflightRef.current = { clip, mode, threadId, requestId: crypto.randomUUID(), attempt: 0, acked: false };
      transmit();
    },
    [activeThreadIdRef, clearRetryTimer, transmit, giveUp]
  );
  sendAudioRef.current = sendAudio;

  // The daemon acked receipt (matched by requestId, so a stale ack from an earlier send is ignored) → stop
  // retransmitting; the turn now lands via the normal prompt_status/history path.
  const onSendAcked = useCallback(
    (requestId: string) => {
      const f = inflightRef.current;
      if (f && f.requestId === requestId && !f.acked) {
        f.acked = true;
        clearRetryTimer();
      }
    },
    [clearRetryTimer]
  );

  // The in-flight turn settled — the spoken turn landed (ok) or the daemon errored (!ok). Drop the
  // in-flight state + watchdog, then clear the "Resend" toast on success or raise it on failure. (The
  // spinner itself is cleared by the reducer's success/error path that triggered this.)
  const onSendSettled = useCallback(
    (ok: boolean) => {
      clearRetryTimer();
      inflightRef.current = null;
      if (ok) clearResendToast();
      else raiseResendToast();
    },
    [clearRetryTimer, clearResendToast, raiseResendToast]
  );

  // Reconnect reconciliation: re-send an un-acked in-flight clip the instant the daemon is reachable again
  // (App calls this on the active thread's offline→online transition). The watchdog keeps running, so this
  // is a bonus immediate attempt; the daemon dedups it if the original actually arrived.
  const retryInflightNow = useCallback(() => {
    const f = inflightRef.current;
    if (f && !f.acked) sendOnce();
  }, [sendOnce]);

  // Clear the retransmit timer if the component unmounts mid-send.
  useEffect(() => () => clearRetryTimer(), [clearRetryTimer]);

  const onClip = useCallback(
    (clip: RecordedClip) => {
      clearResendToast(); // a new recording supersedes any stale failed send
      sendAudio(clip, nextModeRef.current);
      nextModeRef.current = "queue";
    },
    [sendAudio, clearResendToast]
  );

  // A blocked mic (getUserMedia denied — often with NO permission dialog, e.g. the hands-free auto-respond
  // re-acquire, which iOS rejects outside a user gesture) needs a VISIBLE, self-explaining cue, not just a
  // hero flash that's scrolled away mid-conversation. Raise a 5s toast pointing at the fix; one at a time.
  const micToastRef = useRef<string | null>(null);
  const raiseMicBlockedToast = useCallback(() => {
    if (micToastRef.current) toast.close(micToastRef.current);
    micToastRef.current = toast.add({
      title: "Can’t open the microphone",
      description: "Allow mic access for this site in Safari, or add the app to your Home Screen.",
      type: "error",
      timeout: 5000
    });
  }, []);
  // A blocked mic → the toast (visible, actionable); other recorder errors stay transient hero flashes.
  const onRecorderError = useCallback(
    (error: RecorderError) => {
      if (error === "mic-blocked") raiseMicBlockedToast();
      else showFlash(RECORDER_ERROR_TEXT[error]);
    },
    [showFlash, raiseMicBlockedToast]
  );

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
    // The thread-messages reducer drives the in-flight send lifecycle through these: `onSendAcked` (daemon
    // got the audio) stops the retransmit watchdog; `onSendSettled` (turn landed / daemon errored) finalizes
    // + toasts; `retryInflightNow` is the reconnect nudge (App calls it on the daemon coming back online).
    onSendAcked,
    onSendSettled,
    retryInflightNow,
    onMic: useCallback(() => startRecording("queue"), [startRecording]),
    onSteer: useCallback(() => startRecording("queue"), [startRecording]),
    onInterrupt: useCallback(() => startRecording("interrupt"), [startRecording]),
    onStopRecording: useCallback(() => stop(), [stop]),
    onCancel: useCallback(() => cancel(), [cancel]),
    onStopTask: useCallback(() => sendControl({ type: "stop_task" }), [sendControl])
  };
}
