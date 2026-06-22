import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { blobToBase64, pickMimeType } from "../lib/audio";
import { ensureAudioRunning, getAudioContext, wireAudioContextRecovery } from "../lib/audioContext";
import { setAudioSessionType } from "../lib/audioSession";

export type RecordedClip = { audioBase64: string; mimeType: string };

export type RecorderError =
  | "not-supported" // browser cannot record
  | "mic-blocked" // getUserMedia rejected
  | "empty" // nothing captured
  | "read-failed"; // could not read the blob

export type UseRecorderOptions = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  // Called with the finished clip once recording stops and is read.
  onClip: (clip: RecordedClip) => void;
  // Called for recorder error states (surfaced to the user as a transient flash).
  onError: (error: RecorderError) => void;
  // Called when recording starts so playback can be stopped.
  onStart?: () => void;
};

// A held mic track is reusable as long as it's LIVE (readyState "live"). We deliberately do NOT reject a
// momentarily-MUTED track: iOS mutes the track when the page's audio session churns (e.g. a reply plays →
// transient-solo → ambient), and rejecting it would force a fresh getUserMedia — which on iOS Safari
// re-shows the permission prompt EVERY time (permission isn't persisted; the only way to avoid the prompt
// is to keep one stream alive and reuse it). Starting a recording re-claims "play-and-record", which
// re-activates the mic and clears a transient mute, so reuse records real audio. An `ended` track is gone
// for good (re-acquire is unavoidable then).
function trackHealthy(stream: MediaStream | null): boolean {
  const track = stream?.getAudioTracks()[0];
  return !!track && track.readyState === "live";
}

export type Recorder = {
  recording: boolean;
  // true while the visualizer canvas should be shown
  visualizerActive: boolean;
  // Begin capture. Returns false synchronously if prerequisites are missing.
  start: () => Promise<void>;
  // Stop capture and emit the recorded clip (onClip).
  stop: () => void;
  // Stop capture and DISCARD the clip — the user cancelled (no onClip, no error).
  cancel: () => void;
  // Soft backgrounding (pagehide): stop the visualizer + any in-flight recording but HOLD the
  // mic stream so the next record reuses it (no iOS re-prompt). Idle release still applies.
  suspend: () => void;
  // Hard teardown (unmount): stops stream + visualizer without emitting a clip.
  teardown: () => void;
};

// iOS Safari re-prompts for the mic on every getUserMedia, so we HOLD one granted stream and
// reuse it across recordings. To avoid pinning the mic indefinitely after the user walks away,
// release the held stream once it's gone unused for this long (next record re-acquires).
const IDLE_RELEASE_MS = 30 * 60 * 1000;

export function useRecorder({ canvasRef, onClip, onError, onStart }: UseRecorderOptions): Recorder {
  const [recording, setRecording] = useState(false);
  const [visualizerActive, setVisualizerActive] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingRef = useRef(false);
  // Set by cancel(): the next `stop` event drops its clip instead of submitting.
  const canceledRef = useRef(false);
  // Idle timer: releases the held mic stream after IDLE_RELEASE_MS of no recording.
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The AudioContext is the shared, app-wide singleton (see lib/audioContext) — never
  // created or closed here, only resumed. `sourceRef` is the per-recording mic node we
  // connect/disconnect around the shared analyser.
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef(0);

  const onClipRef = useRef(onClip);
  const onErrorRef = useRef(onError);
  const onStartRef = useRef(onStart);
  onClipRef.current = onClip;
  onErrorRef.current = onError;
  onStartRef.current = onStart;

  const clearIdleTimer = useCallback((): void => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const stopStream = useCallback((): void => {
    clearIdleTimer();
    const stream = mediaStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      mediaStreamRef.current = null;
    }
  }, [clearIdleTimer]);

  // Arm the idle release so a held-but-unused stream is let go (and its mic indicator cleared)
  // instead of pinned forever; the next record re-acquires. Reset on every record.
  const scheduleIdleRelease = useCallback((): void => {
    clearIdleTimer();
    idleTimerRef.current = setTimeout(() => {
      if (!recordingRef.current) stopStream();
    }, IDLE_RELEASE_MS);
  }, [clearIdleTimer, stopStream]);

  // ---- visualizer (mic-reactive bars) ---------------------------------------

  const sizeCanvas = useCallback((): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  }, [canvasRef]);

  const drawWave = useCallback((): void => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    const freqData = freqDataRef.current;
    if (!recordingRef.current || !analyser || !canvas || !freqData) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    rafRef.current = requestAnimationFrame(drawWave);
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    analyser.getByteFrequencyData(freqData);
    const bars = 40;
    const gap = Math.max(2, w / bars / 3);
    const barW = (w - gap * (bars - 1)) / bars;
    const mid = h / 2;
    // Read the accent tokens off the canvas so the visualizer stays on-palette
    // without hard-coded hex (canvas fillStyle needs literal color strings).
    const styles = getComputedStyle(canvas);
    const warm = styles.getPropertyValue("--color-coral").trim() || "#fb7a45";
    const cool = styles.getPropertyValue("--color-violet").trim() || "#8e7df0";
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, warm);
    grad.addColorStop(1, cool);
    ctx.fillStyle = grad;
    const step = Math.max(1, Math.floor(freqData.length / bars));
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += freqData[i * step + j] || 0;
      const level = sum / step / 255;
      const barH = Math.max(barW, level * h * 0.92);
      const x = i * (barW + gap);
      ctx.beginPath();
      ctx.roundRect(x, mid - barH / 2, barW, barH, barW / 2);
      ctx.fill();
    }
  }, [canvasRef]);

  const startVisualizer = useCallback((): void => {
    setVisualizerActive(true);
    const stream = mediaStreamRef.current;
    if (!stream) return;
    try {
      // Reuse the shared context (already resumed inside the record gesture by start()).
      // A fresh per-recording context would risk being born suspended/interrupted on iOS
      // and paint a flat waveform.
      const audioCtx = getAudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      source.connect(analyser);
      analyserRef.current = analyser;
      freqDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      // Defer one frame so the canvas (rendered by `visualizerActive`) has layout size.
      requestAnimationFrame(() => {
        sizeCanvas();
        drawWave();
      });
    } catch {
      // visualizer is decorative; recording still works without it
    }
  }, [sizeCanvas, drawWave]);

  const stopVisualizer = useCallback((): void => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    // Disconnect the per-recording mic node but leave the SHARED context open (closing it
    // would defeat the keep-one-context-alive strategy and break the next recording).
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        /* ignore */
      }
      sourceRef.current = null;
    }
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {
        /* ignore */
      }
    }
    analyserRef.current = null;
    freqDataRef.current = null;
    setVisualizerActive(false);
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, [canvasRef]);

  // ---- capture --------------------------------------------------------------

  const submitRecording = useCallback(async (): Promise<void> => {
    const canceled = canceledRef.current;
    canceledRef.current = false;
    const recorder = mediaRecorderRef.current;
    const mimeType = recorder?.mimeType || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    // Keep the mic track alive for the next recording (no stopStream → no iOS re-prompt),
    // but arm the idle release so it isn't held forever once the user stops talking to us.
    scheduleIdleRelease();
    // Do NOT drop to "auto" here: on iOS, leaving the recording category ENDS the held mic track,
    // so the next record re-runs getUserMedia → a fresh permission prompt (the exact symptom). We hold
    // "play-and-record" so the track stays live for reuse. The cost is background music stays ducked
    // between a recording and its reply; the reply's TTS (transient-solo) resumes it, and the idle
    // release / pagehide / unmount hand the session back to "auto" so music isn't held hostage for long.
    // ponytail: iOS couples mic-alive with record-mode — can't both avoid re-prompts AND resume music
    // between recordings; the user chose no-reprompt. Needs on-device verification.
    // Cancelled by the user — drop the clip silently (no clip, no error flash).
    if (canceled) return;
    if (!blob.size) {
      onErrorRef.current("empty");
      return;
    }
    let audioBase64: string;
    try {
      audioBase64 = await blobToBase64(blob);
    } catch {
      onErrorRef.current("read-failed");
      return;
    }
    onClipRef.current({ audioBase64, mimeType });
  }, [scheduleIdleRelease]);

  // Drop our recording-time Media Session handlers (so a later reply's <audio> keeps the normal
  // play/pause from media keys). Safe where the API is missing.
  const clearMediaSession = useCallback((): void => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      for (const action of ["play", "pause", "stop"] as const) ms.setActionHandler(action, null);
      ms.playbackState = "none";
    } catch {
      /* unsupported action — ignore */
    }
  }, []);

  const stop = useCallback((): void => {
    recordingRef.current = false;
    setRecording(false);
    stopVisualizer();
    clearMediaSession();
    const recorder = mediaRecorderRef.current;
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {
      /* ignore */
    }
  }, [stopVisualizer, clearMediaSession]);

  // Claim the Media Session while recording so a headphone / lock-screen play/pause button finishes the
  // turn (stop → send) hands-free. We set ourselves "playing" + map play/pause/stop to stop(). iOS only
  // routes the hardware button to whichever page is the active now-playing target, so this is best-effort
  // there (needs on-device verification); it's a clean no-op where the API is absent.
  const armMediaSession = useCallback((): void => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      const finish = () => stop();
      for (const action of ["play", "pause", "stop"] as const) ms.setActionHandler(action, finish);
      ms.playbackState = "playing";
    } catch {
      /* unsupported action — ignore */
    }
  }, [stop]);

  // Abort the current recording without emitting a clip. The `stop` event still
  // fires (and runs submitRecording), but canceledRef makes it discard the audio.
  const cancel = useCallback((): void => {
    if (!recordingRef.current) return;
    canceledRef.current = true;
    recordingRef.current = false;
    setRecording(false);
    stopVisualizer();
    clearMediaSession();
    const recorder = mediaRecorderRef.current;
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {
      /* ignore */
    }
  }, [stopVisualizer, clearMediaSession]);

  // Soft backgrounding (pagehide): don't release the mic — keeping the held stream means the
  // next record can reuse it with no iOS re-prompt (ensureMic re-acquires only if iOS actually
  // ended the track). We do cancel any in-flight recording (a clip captured across a background
  // boundary is unreliable) and arm the idle release so a long background eventually lets go.
  const suspend = useCallback((): void => {
    if (recordingRef.current) cancel();
    setAudioSessionType("auto");
    if (mediaStreamRef.current) scheduleIdleRelease();
  }, [cancel, scheduleIdleRelease]);

  // Re-acquire the mic from scratch. The old track is stopped first: iOS mutes the prior
  // track of the same kind when you call getUserMedia again, and that mute is unrecoverable.
  const acquireMic = useCallback(async (): Promise<MediaStream> => {
    stopStream();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaStreamRef.current = stream;
    // If the source is permanently lost mid-recording (interruption relinquishes the
    // device), stop cleanly and keep what we captured — iOS won't reliably resume the
    // same MediaRecorder across the boundary. We bail on `ended` only; a transient `mute`
    // may auto-recover, and stopping on it would cut otherwise-good recordings short.
    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (recordingRef.current) stop();
    });
    return stream;
  }, [stopStream, stop]);

  // Reuse the held mic stream when its track is still healthy — this is the whole point on iOS,
  // where a fresh getUserMedia re-prompts for permission. Only re-acquire (one retry, since the
  // device may hand back a still-muted track right after a screen lock) when there's no stream or
  // the current one died (ended/muted).
  const ensureMic = useCallback(async (): Promise<MediaStream> => {
    const held = mediaStreamRef.current;
    if (held && trackHealthy(held)) return held;
    let stream = await acquireMic();
    if (!trackHealthy(stream)) stream = await acquireMic();
    return stream;
  }, [acquireMic]);

  const start = useCallback(async (): Promise<void> => {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      onErrorRef.current("not-supported");
      return;
    }
    // Claim the recording category BEFORE getUserMedia. Without play-and-record the Audio
    // Session spec ends the mic track on the next interruption; setting it here is what
    // lets recording survive (and recover after) a screen lock. No-op off iOS.
    setAudioSessionType("play-and-record");
    // Resume the shared context inside this tap gesture so the visualiser isn't a flat
    // line after returning from a lock (a backgrounded context comes back suspended).
    try {
      await ensureAudioRunning();
    } catch {
      /* visualiser is decorative; recording proceeds regardless */
    }
    // Reset the idle release: we're recording now, so don't let go of the stream.
    clearIdleTimer();
    let stream: MediaStream;
    try {
      stream = await ensureMic();
    } catch {
      setAudioSessionType("auto");
      onErrorRef.current("mic-blocked");
      return;
    }
    if (!trackHealthy(stream)) {
      stopStream();
      setAudioSessionType("auto");
      onErrorRef.current("mic-blocked");
      return;
    }
    onStartRef.current?.();
    chunksRef.current = [];
    const mime = pickMimeType();
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorder.addEventListener("stop", () => void submitRecording());
    // Timeslice so chunks flush periodically — iOS may stop the recorder abruptly on an
    // interruption, and regularly-flushed chunks mean we keep the audio up to that point.
    recorder.start(250);
    recordingRef.current = true;
    setRecording(true);
    startVisualizer();
    armMediaSession(); // headphone / lock-screen play-pause → stop + send
  }, [ensureMic, stopStream, clearIdleTimer, startVisualizer, submitRecording, armMediaSession]);

  const teardown = useCallback((): void => {
    stopVisualizer();
    stopStream();
    // Release the recording category on hard teardown so background audio isn't left paused.
    setAudioSessionType("auto");
  }, [stopVisualizer, stopStream]);

  // Keep the shared AudioContext warm across gestures / foreground returns so the first
  // record tap after a screen lock finds a live context instead of a flat one.
  useEffect(() => {
    wireAudioContextRecovery();
  }, []);

  // Clean up on unmount.
  useEffect(() => teardown, [teardown]);

  return { recording, visualizerActive, start, stop, cancel, suspend, teardown };
}
