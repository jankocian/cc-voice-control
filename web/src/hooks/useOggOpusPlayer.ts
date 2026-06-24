import { OggOpusDecoderWebWorker } from "ogg-opus-decoder";
import { useCallback, useEffect, useRef, useState } from "react";
import { setAudioSessionType } from "../lib/audioSession";

type StreamState = {
  decoder: OggOpusDecoderWebWorker;
  closed: boolean;
  nextPlayTime: number;
  pendingDecode: Promise<void>;
  source?: AudioBufferSourceNode;
};

function freeStream(stream: StreamState): void {
  try {
    stream.source?.stop();
  } catch {}
  stream.decoder.free().catch(() => {});
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type OggOpusPlayer = {
  playingId: string | null;
  loadedId: string | null;
  // Total clip duration in seconds. 0 during live streaming (unknown) or when idle.
  duration: number;
  // Returns live playhead position in seconds (reads AudioContext.currentTime).
  getPosition: () => number;
  // Seek within the currently loaded clip. Only works when duration > 0 (full file decoded).
  seekTo: (offsetSeconds: number) => void;
  // Play a complete OGG Opus file (tap-to-play / auto-play of cached clip).
  playFile: (requestId: string, base64: string) => void;
  // Process one incremental OGG Opus chunk from a live stream.
  attachChunk: (requestId: string, base64: string) => void;
  // Signal end of live stream; schedules cleanup after all buffered audio plays out.
  endStream: (requestId: string) => void;
  // Stop active playback (optionally targeting a specific requestId).
  stop: (requestId?: string) => void;
  // Drop a specific stream without stopping others (used by dropAudio).
  drop: (requestId: string) => void;
  // Create/resume AudioContext — must be called within a user gesture.
  unlockContext: () => void;
  hasContext: () => boolean;
  isStreaming: (requestId: string) => boolean;
};

// Manages OGG Opus decoding via WASM + Web Audio API scheduling.
// Owns the streaming lifecycle: chunk-by-chunk live decoding and full-file replay
// both go through the same StreamState, so all cleanup paths are shared.
export function useOggOpusPlayer(onFinished?: (requestId: string) => void): OggOpusPlayer {
  const streamingRef = useRef(new Map<string, StreamState>());
  const audioContextRef = useRef<AudioContext | null>(null);
  const currentPlayingIdRef = useRef<string | null>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(0);

  // Seek/position tracking — only populated by playFile, cleared on stop.
  const decodedBufferRef = useRef<AudioBuffer | null>(null);
  const playStartCtxTimeRef = useRef<number>(0);
  const playStartOffsetRef = useRef<number>(0);

  // Free all active WASM decoders on unmount to avoid WebAssembly memory leaks.
  useEffect(() => {
    const streaming = streamingRef.current;
    return () => {
      for (const s of streaming.values()) freeStream(s);
      streaming.clear();
    };
  }, []);

  // Reset playing state if requestId is the current player.
  const clearCurrent = useCallback((requestId: string): void => {
    if (currentPlayingIdRef.current !== requestId) return;
    currentPlayingIdRef.current = null;
    decodedBufferRef.current = null;
    playStartCtxTimeRef.current = 0;
    playStartOffsetRef.current = 0;
    setPlayingId(null);
    setLoadedId(null);
    setDuration(0);
  }, []);

  // Schedule decoder teardown + onFinished after all audio has played out.
  const scheduleCleanup = useCallback(
    (requestId: string): void => {
      const s = streamingRef.current.get(requestId);
      if (!s) return;
      const ctx = audioContextRef.current;
      const delay = ctx ? Math.max(0, (s.nextPlayTime - ctx.currentTime) * 1000 + 150) : 0;
      setTimeout(() => {
        const current = streamingRef.current.get(requestId);
        if (current) {
          freeStream(current);
          streamingRef.current.delete(requestId);
        }
        clearCurrent(requestId);
        onFinishedRef.current?.(requestId);
      }, delay);
    },
    [clearCurrent]
  );

  const playFile = useCallback(
    (requestId: string, base64: string): void => {
      const ctx = audioContextRef.current;
      if (!ctx || ctx.state === "closed") return;

      // Silence any other active stream — only one voice at a time.
      const active = currentPlayingIdRef.current;
      if (active && active !== requestId) {
        const activeStream = streamingRef.current.get(active);
        if (activeStream) { freeStream(activeStream); streamingRef.current.delete(active); }
      }
      const existing = streamingRef.current.get(requestId);
      if (existing) { freeStream(existing); streamingRef.current.delete(requestId); }

      decodedBufferRef.current = null;
      playStartCtxTimeRef.current = 0;
      playStartOffsetRef.current = 0;
      setDuration(0);

      const decoder = new OggOpusDecoderWebWorker();
      const stream: StreamState = { decoder, closed: true, nextPlayTime: 0, pendingDecode: Promise.resolve() };
      streamingRef.current.set(requestId, stream);
      currentPlayingIdRef.current = requestId;
      setPlayingId(requestId);
      setLoadedId(requestId);

      const bytes = b64ToBytes(base64);
      const pending = decoder.ready
        .then(async () => {
          if (!streamingRef.current.has(requestId)) return;
          setAudioSessionType("ambient");
          const { channelData, samplesDecoded } = await decoder.decodeFile(bytes);
          if (samplesDecoded === 0 || channelData.length === 0) return;
          if (!streamingRef.current.has(requestId)) return;
          const buffer = ctx.createBuffer(channelData.length, samplesDecoded, 48000);
          // @ts-expect-error Float32Array<ArrayBufferLike> vs Float32Array<ArrayBuffer> in lib types
          for (let i = 0; i < channelData.length; i++) buffer.copyToChannel(channelData[i], i);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          const startAt = ctx.currentTime + 0.05;
          // Set stream.source and position refs BEFORE start() so seekTo() sees them immediately.
          stream.source = source;
          stream.nextPlayTime = startAt + buffer.duration;
          decodedBufferRef.current = buffer;
          playStartCtxTimeRef.current = startAt;
          playStartOffsetRef.current = 0;
          setDuration(buffer.duration);
          // onended identity check: if seekTo() replaces stream.source, the old source's
          // onended sees source !== stream.source and skips cleanup — only the newest fires.
          source.onended = () => {
            const current = streamingRef.current.get(requestId);
            if (current?.source !== source) return;
            freeStream(current);
            streamingRef.current.delete(requestId);
            clearCurrent(requestId);
            onFinishedRef.current?.(requestId);
          };
          source.start(startAt);
        })
        .catch(() => {
          const s = streamingRef.current.get(requestId);
          if (s) { freeStream(s); streamingRef.current.delete(requestId); }
          clearCurrent(requestId);
        });

      stream.pendingDecode = pending;
    },
    [clearCurrent]
  );

  const attachChunk = useCallback(
    (requestId: string, base64: string): void => {
      if (!streamingRef.current.has(requestId)) {
        // Silence any other active stream before starting a new live one.
        const active = currentPlayingIdRef.current;
        if (active && active !== requestId) {
          const activeStream = streamingRef.current.get(active);
          if (activeStream) { freeStream(activeStream); streamingRef.current.delete(active); }
        }
        const decoder = new OggOpusDecoderWebWorker();
        streamingRef.current.set(requestId, {
          decoder,
          closed: false,
          nextPlayTime: 0,
          pendingDecode: decoder.ready
        });
        currentPlayingIdRef.current = requestId;
        setPlayingId(requestId);
        setLoadedId(requestId);
      }

      const stream = streamingRef.current.get(requestId);
      if (!stream) return;
      const bytes = b64ToBytes(base64);

      stream.pendingDecode = stream.pendingDecode
        .then(async () => {
          if (!streamingRef.current.has(requestId)) return;
          const { channelData, samplesDecoded } = await stream.decoder.decode(bytes);
          if (samplesDecoded === 0 || channelData.length === 0) return;
          const ctx = audioContextRef.current;
          if (!ctx || ctx.state === "closed") return;
          setAudioSessionType("ambient");
          const buffer = ctx.createBuffer(channelData.length, samplesDecoded, 48000);
          // @ts-expect-error Float32Array<ArrayBufferLike> vs Float32Array<ArrayBuffer> in lib types
          for (let i = 0; i < channelData.length; i++) buffer.copyToChannel(channelData[i], i);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          if (stream.nextPlayTime === 0) stream.nextPlayTime = ctx.currentTime + 0.1;
          const startAt = Math.max(ctx.currentTime, stream.nextPlayTime);
          source.start(startAt);
          stream.source = source;
          stream.nextPlayTime = startAt + buffer.duration;
        })
        .catch(() => {
          const s = streamingRef.current.get(requestId);
          if (s) {
            freeStream(s);
            streamingRef.current.delete(requestId);
          }
          clearCurrent(requestId);
        });
    },
    [clearCurrent]
  );

  const endStream = useCallback(
    (requestId: string): void => {
      const stream = streamingRef.current.get(requestId);
      if (!stream) return;
      stream.closed = true;
      stream.pendingDecode.then(() => scheduleCleanup(requestId));
    },
    [scheduleCleanup]
  );

  const stop = useCallback(
    (requestId?: string): void => {
      const id = requestId ?? currentPlayingIdRef.current;
      if (!id) return;
      const stream = streamingRef.current.get(id);
      if (stream) {
        freeStream(stream);
        streamingRef.current.delete(id);
      }
      clearCurrent(id);
    },
    [clearCurrent]
  );

  const drop = useCallback(
    (requestId: string): void => {
      const stream = streamingRef.current.get(requestId);
      if (stream) {
        freeStream(stream);
        streamingRef.current.delete(requestId);
      }
      clearCurrent(requestId);
    },
    [clearCurrent]
  );

  const getPosition = useCallback((): number => {
    const ctx = audioContextRef.current;
    if (!ctx || playStartCtxTimeRef.current === 0) return playStartOffsetRef.current;
    const pos = playStartOffsetRef.current + (ctx.currentTime - playStartCtxTimeRef.current);
    const dur = decodedBufferRef.current?.duration ?? 0;
    return dur > 0 ? Math.min(Math.max(0, pos), dur) : Math.max(0, pos);
  }, []);

  const seekTo = useCallback(
    (offsetSeconds: number): void => {
      const ctx = audioContextRef.current;
      const buffer = decodedBufferRef.current;
      const requestId = currentPlayingIdRef.current;
      if (!ctx || !buffer || !requestId) return;
      const stream = streamingRef.current.get(requestId);
      if (!stream) return;

      const clamped = Math.min(Math.max(0, offsetSeconds), buffer.duration);
      const oldSource = stream.source;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);

      // Update stream.source BEFORE stopping oldSource so its onended identity check fails.
      stream.source = source;
      playStartCtxTimeRef.current = ctx.currentTime;
      playStartOffsetRef.current = clamped;

      try { oldSource?.stop(); } catch {}

      source.onended = () => {
        const current = streamingRef.current.get(requestId);
        if (current?.source !== source) return;
        freeStream(current);
        streamingRef.current.delete(requestId);
        clearCurrent(requestId);
        onFinishedRef.current?.(requestId);
      };
      source.start(ctx.currentTime, clamped);
    },
    [clearCurrent]
  );

  const unlockContext = useCallback((): void => {
    if (!audioContextRef.current) audioContextRef.current = new AudioContext();
    audioContextRef.current.resume().catch(() => {});
  }, []);

  const hasContext = useCallback(
    (): boolean => audioContextRef.current !== null && audioContextRef.current.state !== "closed",
    []
  );

  const isStreaming = useCallback((requestId: string): boolean => streamingRef.current.has(requestId), []);

  return { playingId, loadedId, duration, getPosition, seekTo, playFile, attachChunk, endStream, stop, drop, unlockContext, hasContext, isStreaming };
}
