import type { RefObject } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { blobToBase64, pickMimeType } from "../lib/audio";

export type RecordedClip = { audioBase64: string; mimeType: string };

export type RecorderError =
  | "not-supported" // browser cannot record
  | "mic-blocked" // getUserMedia rejected
  | "empty" // nothing captured
  | "read-failed"; // could not read the blob

export type UseRecorderOptions = {
  canvasRef: RefObject<HTMLCanvasElement>;
  // Called with the finished clip once recording stops and is read.
  onClip: (clip: RecordedClip) => void;
  // Called for the error states the vanilla client flashed.
  onError: (error: RecorderError) => void;
  // Called when recording starts so playback can be stopped (vanilla: stopPlayback()).
  onStart?: () => void;
};

export type Recorder = {
  recording: boolean;
  // true while the visualizer canvas should be shown
  visualizerActive: boolean;
  // Begin capture. Returns false synchronously if prerequisites are missing.
  start: () => Promise<void>;
  stop: () => void;
  // Hard teardown (pagehide): stops stream + visualizer without emitting a clip.
  teardown: () => void;
};

export function useRecorder({ canvasRef, onClip, onError, onStart }: UseRecorderOptions): Recorder {
  const [recording, setRecording] = useState(false);
  const [visualizerActive, setVisualizerActive] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingRef = useRef(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const freqDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef(0);

  const onClipRef = useRef(onClip);
  const onErrorRef = useRef(onError);
  const onStartRef = useRef(onStart);
  onClipRef.current = onClip;
  onErrorRef.current = onError;
  onStartRef.current = onStart;

  const stopStream = useCallback((): void => {
    const stream = mediaStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      mediaStreamRef.current = null;
    }
  }, []);

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
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#4493f8");
    grad.addColorStop(1, "#a371f7");
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
      const AudioCtor =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtor();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
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
    if (audioCtxRef.current) {
      try {
        void audioCtxRef.current.close();
      } catch {
        /* ignore */
      }
      audioCtxRef.current = null;
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
    const recorder = mediaRecorderRef.current;
    const mimeType = recorder?.mimeType || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    stopStream();
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
  }, [stopStream]);

  const stop = useCallback((): void => {
    recordingRef.current = false;
    setRecording(false);
    stopVisualizer();
    const recorder = mediaRecorderRef.current;
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {
      /* ignore */
    }
  }, [stopVisualizer]);

  const start = useCallback(async (): Promise<void> => {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      onErrorRef.current("not-supported");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onErrorRef.current("mic-blocked");
      return;
    }
    mediaStreamRef.current = stream;
    onStartRef.current?.();
    chunksRef.current = [];
    const mime = pickMimeType();
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorder.addEventListener("stop", () => void submitRecording());
    recorder.start();
    recordingRef.current = true;
    setRecording(true);
    startVisualizer();
  }, [startVisualizer, submitRecording]);

  const teardown = useCallback((): void => {
    stopVisualizer();
    stopStream();
  }, [stopVisualizer, stopStream]);

  // Clean up on unmount.
  useEffect(() => teardown, [teardown]);

  return { recording, visualizerActive, start, stop, teardown };
}
