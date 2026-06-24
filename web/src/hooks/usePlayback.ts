import { OggOpusDecoderWebWorker } from "ogg-opus-decoder";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setAudioSessionType } from "../lib/audioSession";

const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = "voiceRemote.playbackRate";
// Default when the user hasn't picked a speed — most replies read better slightly faster.
const DEFAULT_RATE = 1.25;

function clampRate(rate: number): number {
  return SPEEDS.indexOf(rate) >= 0 ? rate : DEFAULT_RATE;
}

// A zero-length silent WAV. Played once inside a user gesture, it "unlocks" the
// shared <audio> element so subsequent programmatic autoplay (TTS replies) is
// allowed by the browser's autoplay policy (esp. iOS Safari).
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

function formatRate(rate: number): string {
  return `${rate}x`;
}

type CachedAudio = { audioBase64: string; mimeType: string };

// State for an active foreground streaming TTS session (OGG Opus → WASM decode → Web Audio API).
// Created on the first chunk of a foreground reply; removed when the last decoded audio finishes playing.
// Background streams skip this entirely — they wait for tts_audio(replay:true) then tap-to-play.
type StreamState = {
  decoder: OggOpusDecoderWebWorker;
  closed: boolean; // tts_audio(replay:true) received — all bytes sent by daemon
  nextPlayTime: number; // AudioContext scheduling cursor (seconds)
  pendingDecode: Promise<void>; // chain to serialize async decode calls in arrival order
  source?: AudioBufferSourceNode; // most-recently-started node; stop()ed on abort to silence immediately
};

function freeStream(stream: StreamState): void {
  try {
    stream.source?.stop();
  } catch {}
  stream.decoder.free().catch(() => {});
}

export type Playback = {
  // requestId of the entry currently rendered as "playing" (shows the pause icon),
  // i.e. the loaded clip that is actively playing. null when paused/stopped.
  playingId: string | null;
  // requestId currently loaded into the <audio> element (may be paused). Drives the
  // inline scrubber: only the loaded row reflects live position/duration.
  loadedId: string | null;
  // Live playhead + clip length (seconds) of the loaded entry. 0 when none.
  position: number;
  duration: number;
  // requestIds renderable as playable → render play/replay controls + .playable. Includes
  // both locally-cached audio AND history rows the daemon flags fetchable (tap-to-play
  // before the bytes arrive). See markPlayable.
  playableIds: ReadonlySet<string>;
  // Per-reply audio lifecycle: "pending" (synthesizing) / "failed" (retryable). Absent once playable.
  audioStatus: ReadonlyMap<string, "pending" | "failed">;
  // requestId for which a tap-to-play fetch is in flight (audio requested but not yet arrived).
  pendingPlayId: string | null;
  speaking: boolean;
  playbackRate: number;
  formattedRate: string;
  attachAudio: (requestId: string, audioBase64: string, mimeType: string, replay: boolean) => void;
  // Attach one chunk of a long streaming reply. seq=0 auto-plays on foreground threads; later chunks
  // are queued and played sequentially. Stream ends when tts_audio(replay:true) arrives for the same
  // requestId; tts_status:failed aborts it. background=true suppresses auto-play.
  attachAudioChunk: (
    requestId: string,
    seq: number,
    audioBase64: string,
    mimeType: string,
    background: boolean
  ) => void;
  // Record a daemon `tts_status` for a reply (drives the loading / retry indicator).
  noteAudioStatus: (requestId: string, state: "pending" | "failed") => void;
  // Mark replies the daemon still has audio for (from a `history` event) as playable, even
  // though their bytes aren't cached yet — tapping play fetches them on demand.
  markPlayable: (requestIds: readonly string[]) => void;
  playEntry: (requestId: string) => void;
  replayEntry: (requestId: string) => void;
  // Seek the loaded entry to an absolute time (seconds). No-op if not loaded.
  seekEntry: (requestId: string, seconds: number) => void;
  stopPlayback: () => void;
  cycleSpeed: () => void;
  // Drop cached audio for a pruned message; stops playback if it was playing.
  dropAudio: (requestId: string) => void;
  // Bless the shared <audio> element within a user gesture (call from a tap) so
  // later programmatic autoplay of replies isn't blocked by the browser policy.
  unlock: () => void;
};

export type UsePlaybackOptions = {
  // A fresh reply auto-plays only when not recording.
  getRecording: () => boolean;
  // Whether autoplay is enabled (Autoplay setting ≠ "off"). When off, a fresh reply is still cached +
  // marked playable (the daemon always synthesizes), it just doesn't play by itself — the user taps it.
  getAutoplay?: () => boolean;
  // Fetch a reply's audio on demand (tap-to-play on a history row whose bytes aren't
  // cached). App wires this to `sendDaemon({ type: "get_audio", requestId })`; the daemon
  // answers with a `tts_audio` (replay), which lands in attachAudio and plays immediately.
  onRequestAudio?: (requestId: string) => void;
  // Fired with the ended clip's requestId whenever a clip finishes on its own (natural end, not a pause) —
  // however it was started, autoplay OR a manual tap. Drives the independent "auto-respond" loop; App
  // checks the requestId is a FINAL reply (not an interim step) + the setting before opening the mic.
  onAutoReplyFinished?: (requestId: string) => void;
};

export function usePlayback({
  getRecording,
  getAutoplay,
  onRequestAudio,
  onAutoReplyFinished
}: UsePlaybackOptions): Playback {
  const playerRef = useRef<HTMLAudioElement | null>(null);
  if (!playerRef.current) playerRef.current = new Audio();
  const player = playerRef.current;

  const audioByRequest = useRef(new Map<string, CachedAudio>());
  const currentPlayingIdRef = useRef<string | null>(null);

  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playableIds, setPlayableIds] = useState<ReadonlySet<string>>(new Set());
  // Per-reply audio lifecycle from the daemon: "pending" while it synthesizes, "failed" on error → the
  // message shows a loading indicator / retry until the audio lands (which clears the entry).
  const [audioStatus, setAudioStatus] = useState<ReadonlyMap<string, "pending" | "failed">>(new Map());
  const clearAudioStatus = useCallback((requestId: string): void => {
    setAudioStatus((prev) => {
      if (!prev.has(requestId)) return prev;
      const next = new Map(prev);
      next.delete(requestId);
      return next;
    });
  }, []);
  const noteAudioStatus = useCallback((requestId: string, state: "pending" | "failed"): void => {
    if (!requestId) return;
    if (state === "failed") {
      // Abort any active stream for this requestId (daemon signalled mid-stream failure).
      const stream = streamingRef.current.get(requestId);
      if (stream) {
        freeStream(stream);
        streamingRef.current.delete(requestId);
        if (currentPlayingIdRef.current === requestId) {
          currentPlayingIdRef.current = null;
          setPlayingId(null);
          setLoadedId(null);
          setPosition(0);
          setDuration(0);
        }
      }
    }
    setAudioStatus((prev) => {
      if (prev.get(requestId) === state) return prev;
      const next = new Map(prev);
      next.set(requestId, state);
      return next;
    });
  }, []);
  const [playbackRate, setPlaybackRate] = useState<number>(() => {
    let stored = NaN;
    try {
      stored = Number.parseFloat(localStorage.getItem(RATE_KEY) ?? "");
    } catch {
      /* ignore */
    }
    return clampRate(stored);
  });

  const getRecordingRef = useRef(getRecording);
  getRecordingRef.current = getRecording;

  const getAutoplayRef = useRef(getAutoplay);
  getAutoplayRef.current = getAutoplay;

  const onRequestAudioRef = useRef(onRequestAudio);
  onRequestAudioRef.current = onRequestAudio;

  const onAutoReplyFinishedRef = useRef(onAutoReplyFinished);
  onAutoReplyFinishedRef.current = onAutoReplyFinished;

  // The requestId of a tap-to-play whose audio we've requested but don't have yet. When
  // that audio lands in attachAudio we play it immediately and clear this. The ref is
  // the fast-path gate for attachAudio; the state drives the loading spinner in the UI.
  const pendingPlayIdRef = useRef<string | null>(null);
  const [pendingPlayId, setPendingPlayId] = useState<string | null>(null);

  // Foreground streaming TTS state: one entry per requestId while WASM-decoding OGG chunks.
  const streamingRef = useRef(new Map<string, StreamState>());
  // Web Audio API context for streaming playback. Created + resumed on first user gesture (unlock()).
  const audioContextRef = useRef<AudioContext | null>(null);

  player.playbackRate = playbackRate;

  // Reflect the audio element's actual play/pause into render state.
  useEffect(() => {
    const onPlay = () => setPlayingId(currentPlayingIdRef.current);
    // Reset playback state when a clip stops (natural end, error, or drop). We deliberately do NOT
    // tear the element down with load(): that only ever existed to "force the iOS session to
    // deactivate so background music resumes" — a resume iOS WebKit never actually delivers — and
    // slamming load() at the end produced an audible click. Under the mixing model the reply plays
    // as an "ambient" (mixable) clip that never paused the music, so there is nothing to resume and
    // nothing to tear down; just revoke the blob URL and clear state.
    const unload = () => {
      try {
        player.pause();
      } catch {
        /* ignore */
      }
      currentPlayingIdRef.current = null;
      setPlayingId(null);
      setLoadedId(null);
      setPosition(0);
      setDuration(0);
    };
    const onPause = () => {
      setPlayingId(null);
    };
    // Natural end / load error → reset playback state; the row falls back to its replay control
    // (still in playableIds), so a tap reloads it fresh. A natural end fires onAutoReplyFinished,
    // the auto-respond hands-free trigger. Streaming replies manage their own end via AudioContext
    // scheduling + setTimeout cleanup in attachAudioChunk/attachAudio, not through this handler.
    const onEnded = () => {
      const endedId = currentPlayingIdRef.current;
      unload();
      if (endedId) onAutoReplyFinishedRef.current?.(endedId);
    };
    const onError = () => unload();
    const onTime = () => setPosition(player.currentTime || 0);
    const onMeta = () => setDuration(Number.isFinite(player.duration) ? player.duration : 0);
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ended", onEnded);
    player.addEventListener("error", onError);
    player.addEventListener("timeupdate", onTime);
    player.addEventListener("loadedmetadata", onMeta);
    player.addEventListener("durationchange", onMeta);
    return () => {
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("ended", onEnded);
      player.removeEventListener("error", onError);
      player.removeEventListener("timeupdate", onTime);
      player.removeEventListener("loadedmetadata", onMeta);
      player.removeEventListener("durationchange", onMeta);
    };
  }, [player]);

  // Pause the unlock element on teardown.
  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {
        /* ignore */
      }
    };
  }, [player]);

  // Decode a complete OGG Opus clip (full base64 buffer) via WASM + Web Audio API and play it
  // immediately. Reuses the same StreamState/cleanup path as live streaming so all TTS goes
  // through one playback mechanism regardless of whether it arrived as chunks or a full buffer.
  const playOggCached = useCallback((requestId: string, base64: string): void => {
    const ctx = audioContextRef.current;
    if (!ctx || ctx.state === "closed") return;

    // Stop any existing stream for this id (user tapped again while playing).
    const existing = streamingRef.current.get(requestId);
    if (existing) {
      existing.decoder.free().catch(() => {});
      streamingRef.current.delete(requestId);
    }

    const decoder = new OggOpusDecoderWebWorker();
    const stream: StreamState = {
      decoder,
      closed: true, // full file — no more chunks expected
      nextPlayTime: 0,
      pendingDecode: Promise.resolve()
    };
    streamingRef.current.set(requestId, stream);
    currentPlayingIdRef.current = requestId;
    setPlayingId(requestId);
    setLoadedId(requestId);

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const decoded = decoder.ready
      .then(async () => {
        if (!streamingRef.current.has(requestId)) return;
        setAudioSessionType("ambient");
        const { channelData, samplesDecoded } = await decoder.decodeFile(bytes);
        if (samplesDecoded === 0 || channelData.length === 0) return;
        if (!streamingRef.current.has(requestId)) return;
        const buffer = ctx.createBuffer(channelData.length, samplesDecoded, 48000);
        for (let i = 0; i < channelData.length; i++) buffer.copyToChannel(channelData[i], i);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        const startAt = ctx.currentTime + 0.05;
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
        if (currentPlayingIdRef.current === requestId) {
          currentPlayingIdRef.current = null;
          setPlayingId(null);
          setLoadedId(null);
        }
      });

    stream.pendingDecode = decoded;
    decoded.then(() => {
      const s = streamingRef.current.get(requestId);
      if (!s) return;
      const delay = Math.max(0, (s.nextPlayTime - ctx.currentTime) * 1000 + 150);
      setTimeout(() => {
        const current = streamingRef.current.get(requestId);
        if (current) {
          freeStream(current);
          streamingRef.current.delete(requestId);
        }
        if (currentPlayingIdRef.current === requestId) {
          currentPlayingIdRef.current = null;
          setPlayingId(null);
          setLoadedId(null);
          setPosition(0);
          setDuration(0);
        }
        onAutoReplyFinishedRef.current?.(requestId);
      }, delay);
    });
  }, []);

  const playEntry = useCallback(
    (requestId: string): void => {
      // Tap while playing → stop (Web Audio API can't pause; re-tap to restart).
      if (currentPlayingIdRef.current === requestId) {
        const stream = streamingRef.current.get(requestId);
        if (stream) {
          freeStream(stream);
          streamingRef.current.delete(requestId);
        }
        currentPlayingIdRef.current = null;
        setPlayingId(null);
        setLoadedId(null);
        setPosition(0);
        setDuration(0);
        return;
      }
      const audio = audioByRequest.current.get(requestId);
      if (audio && audioContextRef.current) {
        playOggCached(requestId, audio.audioBase64);
        return;
      }
      // No cached bytes: fetch on demand. We're inside a tap gesture so AudioContext is unlocked.
      pendingPlayIdRef.current = requestId;
      setPendingPlayId(requestId);
      onRequestAudioRef.current?.(requestId);
    },
    [playOggCached]
  );

  const replayEntry = useCallback(
    (requestId: string): void => {
      const audio = audioByRequest.current.get(requestId);
      if (!audio) {
        pendingPlayIdRef.current = requestId;
        setPendingPlayId(requestId);
        onRequestAudioRef.current?.(requestId);
        return;
      }
      if (audioContextRef.current) playOggCached(requestId, audio.audioBase64);
    },
    [playOggCached]
  );

  const seekEntry = useCallback(
    (requestId: string, seconds: number): void => {
      // Only the loaded entry can be seeked; loading-on-seek would race the scrub.
      if (currentPlayingIdRef.current !== requestId) return;
      const clamped = Math.max(0, Math.min(seconds, player.duration || seconds));
      player.currentTime = clamped;
      setPosition(clamped);
    },
    [player]
  );

  const stopPlayback = useCallback((): void => {
    // Stop any active WASM stream (Web Audio API audio isn't silenced by player.pause()).
    const id = currentPlayingIdRef.current;
    if (id) {
      const stream = streamingRef.current.get(id);
      if (stream) {
        freeStream(stream);
        streamingRef.current.delete(id);
      }
      currentPlayingIdRef.current = null;
      setPlayingId(null);
      setLoadedId(null);
      setPosition(0);
      setDuration(0);
    }
    try {
      player.pause();
    } catch {
      /* ignore */
    }
  }, [player]);

  const attachAudio = useCallback(
    (requestId: string, audioBase64: string, mimeType: string, replay: boolean): void => {
      if (!requestId || !audioBase64) return;
      audioByRequest.current.set(requestId, { audioBase64, mimeType });
      clearAudioStatus(requestId); // audio arrived → no longer pending/failed
      setPlayableIds((prev) => {
        if (prev.has(requestId)) return prev;
        const next = new Set(prev);
        next.add(requestId);
        return next;
      });

      // For a streaming reply, tts_audio(replay:true) is the end-of-stream signal from the daemon.
      // Mark closed + schedule cleanup after all buffered audio finishes playing.
      const stream = streamingRef.current.get(requestId);
      if (stream) {
        stream.closed = true;
        // After all pending decode calls resolve, compute how long until the last scheduled audio
        // ends and fire cleanup + onAutoReplyFinished at that point.
        stream.pendingDecode.then(() => {
          const s = streamingRef.current.get(requestId);
          if (!s) return; // already cleaned up (e.g. dropAudio)
          const ctx = audioContextRef.current;
          const delay = ctx ? Math.max(0, (s.nextPlayTime - ctx.currentTime) * 1000 + 150) : 0;
          setTimeout(() => {
            const current = streamingRef.current.get(requestId);
            if (current) {
              freeStream(current);
              streamingRef.current.delete(requestId);
            }
            if (currentPlayingIdRef.current === requestId) {
              currentPlayingIdRef.current = null;
              setPlayingId(null);
              setLoadedId(null);
              setPosition(0);
              setDuration(0);
            }
            onAutoReplyFinishedRef.current?.(requestId);
          }, delay);
        });
        // Full OGG now cached for tap-to-play. Skip normal auto-play — the stream is already playing.
        return;
      }

      // A tap-to-play we fetched on demand: play it now (user's intent).
      if (pendingPlayIdRef.current === requestId) {
        pendingPlayIdRef.current = null;
        setPendingPlayId(null);
        if (audioContextRef.current) playOggCached(requestId, audioBase64);
        return;
      }
      // Auto-play a fresh reply — only if autoplay is on. With autoplay off the clip is still cached +
      // playable; it just waits for a tap. A replayed (missed) reply also just waits.
      const autoplayOn = getAutoplayRef.current ? getAutoplayRef.current() : true;
      if (!getRecordingRef.current() && !replay && autoplayOn && audioContextRef.current) {
        playOggCached(requestId, audioBase64);
      }
    },
    [playOggCached, clearAudioStatus]
  );

  // Receive one OGG Opus byte chunk. Background threads skip decoding; foreground threads decode via
  // WASM and schedule the resulting PCM through the Web Audio API so playback starts within ~1 s.
  const attachAudioChunk = useCallback(
    (requestId: string, seq: number, audioBase64: string, _mimeType: string, background: boolean): void => {
      if (!requestId || !audioBase64) return;
      if (seq === 0) clearAudioStatus(requestId);
      if (background) return; // tts_audio(replay:true) will cache full clip; user taps to play

      // Initialize WASM decoder on first chunk. decoder.ready is awaited inside pendingDecode.
      if (!streamingRef.current.has(requestId)) {
        const decoder = new OggOpusDecoderWebWorker();
        streamingRef.current.set(requestId, {
          decoder,
          closed: false,
          nextPlayTime: 0,
          pendingDecode: decoder.ready
        });
        // Show playing indicator immediately so the UI reflects the stream starting.
        currentPlayingIdRef.current = requestId;
        setPlayingId(requestId);
        setLoadedId(requestId);
      }

      const stream = streamingRef.current.get(requestId);
      if (!stream) return;

      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      // Chain onto pendingDecode so chunks decode in arrival order regardless of WASM async timing.
      stream.pendingDecode = stream.pendingDecode
        .then(async () => {
          if (!streamingRef.current.has(requestId)) return; // stream was dropped (dropAudio / failure)
          const { channelData, samplesDecoded } = await stream.decoder.decode(bytes);
          if (samplesDecoded === 0 || channelData.length === 0) return;

          const ctx = audioContextRef.current;
          if (!ctx || ctx.state === "closed") return;

          setAudioSessionType("ambient");
          const buffer = ctx.createBuffer(channelData.length, samplesDecoded, 48000 /* Opus always 48 kHz */);
          for (let i = 0; i < channelData.length; i++) buffer.copyToChannel(channelData[i], i);

          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);

          // Schedule: first chunk gets a small lead time to absorb any subsequent jitter.
          if (stream.nextPlayTime === 0) stream.nextPlayTime = ctx.currentTime + 0.1;
          const startAt = Math.max(ctx.currentTime, stream.nextPlayTime);
          source.start(startAt);
          stream.source = source;
          stream.nextPlayTime = startAt + buffer.duration;
        })
        .catch(() => {
          // Decode error: abort this stream silently (daemon will re-synthesize on get_audio).
          const s = streamingRef.current.get(requestId);
          if (s) {
            freeStream(s);
            streamingRef.current.delete(requestId);
          }
          if (currentPlayingIdRef.current === requestId) {
            currentPlayingIdRef.current = null;
            setPlayingId(null);
            setLoadedId(null);
          }
        });
    },
    [clearAudioStatus]
  );

  // History rows (hasAudio) become playable before their bytes are fetched, so the inline
  // player renders as tap-to-play. Tapping triggers the on-demand fetch above.
  const markPlayable = useCallback((requestIds: readonly string[]): void => {
    setPlayableIds((prev) => {
      let next: Set<string> | null = null;
      for (const id of requestIds) {
        if (!id || prev.has(id)) continue;
        next ??= new Set(prev);
        next.add(id);
      }
      return next ?? prev;
    });
  }, []);

  const cycleSpeed = useCallback((): void => {
    setPlaybackRate((prev) => {
      const next = SPEEDS[(SPEEDS.indexOf(prev) + 1) % SPEEDS.length];
      player.playbackRate = next;
      try {
        localStorage.setItem(RATE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [player]);

  const unlockedRef = useRef(false);
  const unlock = useCallback((): void => {
    // Create/resume the AudioContext for Web Audio API streaming (required within a user gesture on iOS).
    if (!audioContextRef.current) audioContextRef.current = new AudioContext();
    audioContextRef.current.resume().catch(() => {});

    if (unlockedRef.current) return;
    // Only unlock when idle (don't stomp an actively-loaded clip). Latch AFTER this guard — if the first
    // gesture lands while a clip is playing, we skip THIS time but stay un-latched so a later idle gesture
    // can still bless the element (otherwise autoplay would be permanently blocked).
    if (currentPlayingIdRef.current) return;
    unlockedRef.current = true;
    try {
      player.muted = true;
      player.src = SILENT_WAV;
      const result = player.play();
      const settle = () => {
        player.pause();
        player.currentTime = 0;
        player.muted = false;
        if (!currentPlayingIdRef.current) player.removeAttribute("src");
      };
      if (result && typeof result.then === "function") {
        result.then(settle).catch(() => {
          player.muted = false;
        });
      } else {
        settle();
      }
    } catch {
      player.muted = false;
    }
  }, [player]);

  const dropAudio = useCallback(
    (requestId: string): void => {
      // Free WASM decoder and clear stream state before anything else so pending decode
      // callbacks see the entry gone and bail out without scheduling more audio.
      const stream = streamingRef.current.get(requestId);
      if (stream) {
        freeStream(stream);
        streamingRef.current.delete(requestId);
      }
      if (requestId === currentPlayingIdRef.current) {
        stopPlayback();
        currentPlayingIdRef.current = null;
        setPlayingId(null);
        setLoadedId(null);
        setPosition(0);
        setDuration(0);
      }
      if (pendingPlayIdRef.current === requestId) {
        pendingPlayIdRef.current = null;
        setPendingPlayId(null);
      }
      audioByRequest.current.delete(requestId);
      clearAudioStatus(requestId);
      setPlayableIds((prev) => {
        if (!prev.has(requestId)) return prev;
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    },
    [stopPlayback, clearAudioStatus]
  );

  const speaking = playingId !== null;

  const formattedRate = useMemo(() => formatRate(playbackRate), [playbackRate]);

  return {
    playingId,
    loadedId,
    position,
    duration,
    playableIds,
    audioStatus,
    pendingPlayId,
    speaking,
    playbackRate,
    formattedRate,
    attachAudio,
    attachAudioChunk,
    noteAudioStatus,
    markPlayable,
    playEntry,
    replayEntry,
    seekEntry,
    stopPlayback,
    cycleSpeed,
    dropAudio,
    unlock
  };
}
