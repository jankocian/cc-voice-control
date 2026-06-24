import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOggOpusPlayer } from "./useOggOpusPlayer";

const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = "voiceRemote.playbackRate";
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

export type Playback = {
  // requestId of the entry currently rendered as "playing" (shows the pause icon).
  playingId: string | null;
  // requestId currently loaded (may be paused). Drives the inline scrubber.
  loadedId: string | null;
  // Live playhead + clip length (seconds) of the loaded entry. 0 when none.
  position: number;
  duration: number;
  // requestIds renderable as playable → render play/replay controls. Includes both
  // locally-cached audio AND history rows the daemon flags fetchable (tap-to-play).
  playableIds: ReadonlySet<string>;
  // Per-reply audio lifecycle: "pending" (synthesizing) / "failed" (retryable). Absent once playable.
  audioStatus: ReadonlyMap<string, "pending" | "failed">;
  // requestId for which a tap-to-play fetch is in flight (audio requested but not yet arrived).
  pendingPlayId: string | null;
  speaking: boolean;
  playbackRate: number;
  formattedRate: string;
  attachAudio: (requestId: string, audioBase64: string, mimeType: string, replay: boolean) => void;
  // Attach one chunk of a live streaming reply. seq=0 auto-plays on foreground threads.
  // background=true suppresses decode — waits for tts_audio(replay:true) then tap-to-play.
  attachAudioChunk: (
    requestId: string,
    seq: number,
    audioBase64: string,
    mimeType: string,
    background: boolean
  ) => void;
  // Record a daemon `tts_status` for a reply (drives the loading / retry indicator).
  noteAudioStatus: (requestId: string, state: "pending" | "failed") => void;
  // Mark replies the daemon still has audio for (from a `history` event) as playable,
  // even though their bytes aren't cached yet — tapping play fetches them on demand.
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
  // Whether autoplay is enabled. When off, a fresh reply is cached + marked playable but doesn't auto-play.
  getAutoplay?: () => boolean;
  // Fetch a reply's audio on demand (tap-to-play on a history row without cached bytes).
  // App wires this to `sendDaemon({ type: "get_audio", requestId })`; the daemon answers
  // with a `tts_audio` (replay), which lands in attachAudio and plays immediately.
  onRequestAudio?: (requestId: string) => void;
  // Fired with the ended clip's requestId when a clip finishes naturally (not a pause).
  // Drives the auto-respond loop; App checks the requestId is a FINAL reply + setting before mic.
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

  const [position, setPosition] = useState(0);
  const [playableIds, setPlayableIds] = useState<ReadonlySet<string>>(new Set());
  // Per-reply audio lifecycle from the daemon: "pending" while synthesizing, "failed" on error.
  const [audioStatus, setAudioStatus] = useState<ReadonlyMap<string, "pending" | "failed">>(new Map());
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

  // requestId of a tap-to-play whose audio we've requested but don't have yet.
  const pendingPlayIdRef = useRef<string | null>(null);
  const [pendingPlayId, setPendingPlayId] = useState<string | null>(null);

  // OGG Opus player: decodes chunks via WASM + schedules PCM through Web Audio API.
  const {
    playingId,
    loadedId,
    duration,
    getPosition,
    seekTo,
    playFile,
    attachChunk,
    endStream,
    stop: stopWasm,
    drop: dropWasm,
    unlockContext,
    hasContext,
    isStreaming
  } = useOggOpusPlayer(onAutoReplyFinished);

  player.playbackRate = playbackRate;

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

  // Update position every 200ms while playing. Resets to 0 when idle.
  useEffect(() => {
    if (!playingId) {
      setPosition(0);
      return;
    }
    const id = setInterval(() => setPosition(getPosition()), 200);
    return () => clearInterval(id);
  }, [playingId, getPosition]);

  const clearAudioStatus = useCallback((requestId: string): void => {
    setAudioStatus((prev) => {
      if (!prev.has(requestId)) return prev;
      const next = new Map(prev);
      next.delete(requestId);
      return next;
    });
  }, []);

  const noteAudioStatus = useCallback(
    (requestId: string, state: "pending" | "failed"): void => {
      if (!requestId) return;
      if (state === "failed") dropWasm(requestId); // abort active stream if any
      setAudioStatus((prev) => {
        if (prev.get(requestId) === state) return prev;
        const next = new Map(prev);
        next.set(requestId, state);
        return next;
      });
    },
    [dropWasm]
  );

  const stopPlayback = useCallback((): void => {
    stopWasm();
    try {
      player.pause();
    } catch {
      /* ignore */
    }
  }, [player, stopWasm]);

  const playEntry = useCallback(
    (requestId: string): void => {
      // Tap while playing → stop (Web Audio API can't pause; re-tap to restart).
      if (playingId === requestId) {
        stopWasm(requestId);
        return;
      }
      const audio = audioByRequest.current.get(requestId);
      if (audio && hasContext()) {
        playFile(requestId, audio.audioBase64);
        return;
      }
      // No cached bytes: request from daemon. We're in a tap gesture so AudioContext is unlocked.
      pendingPlayIdRef.current = requestId;
      setPendingPlayId(requestId);
      onRequestAudioRef.current?.(requestId);
    },
    [playingId, playFile, stopWasm, hasContext]
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
      if (hasContext()) playFile(requestId, audio.audioBase64);
    },
    [hasContext, playFile]
  );

  // Seek is only available when the full clip is decoded (duration > 0).
  // Scrubbing during live streaming is disabled — InlineAudioPlayer gates on duration === 0.
  const seekEntry = useCallback(
    (requestId: string, seconds: number): void => {
      if (requestId !== playingId || duration === 0) return;
      seekTo(seconds);
      setPosition(seconds);
    },
    [playingId, duration, seekTo]
  );

  const attachAudio = useCallback(
    (requestId: string, audioBase64: string, mimeType: string, replay: boolean): void => {
      if (!requestId || !audioBase64) return;
      audioByRequest.current.set(requestId, { audioBase64, mimeType });
      clearAudioStatus(requestId);
      setPlayableIds((prev) => {
        if (prev.has(requestId)) return prev;
        const next = new Set(prev);
        next.add(requestId);
        return next;
      });

      // For a streaming reply, tts_audio(replay:true) is the end-of-stream signal.
      if (isStreaming(requestId)) {
        endStream(requestId);
        return;
      }
      // Pending tap-to-play: audio arrived, play immediately.
      if (pendingPlayIdRef.current === requestId) {
        pendingPlayIdRef.current = null;
        setPendingPlayId(null);
        if (hasContext()) playFile(requestId, audioBase64);
        return;
      }
      // Auto-play a fresh reply when autoplay is on and not recording.
      const autoplayOn = getAutoplayRef.current?.() ?? true;
      if (!getRecordingRef.current() && !replay && autoplayOn && hasContext()) {
        playFile(requestId, audioBase64);
      }
    },
    [clearAudioStatus, isStreaming, endStream, hasContext, playFile]
  );

  const attachAudioChunk = useCallback(
    (requestId: string, seq: number, audioBase64: string, _mimeType: string, background: boolean): void => {
      if (!requestId || !audioBase64) return;
      if (seq === 0) clearAudioStatus(requestId);
      if (background) return; // tts_audio(replay:true) will cache full clip; user taps to play
      attachChunk(requestId, audioBase64);
    },
    [clearAudioStatus, attachChunk]
  );

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
    // Create/resume the AudioContext — must be called within a user gesture on iOS.
    unlockContext();
    // Skip if already unlocked, or a clip is playing (don't stomp it; stay unlatched for a later idle tap).
    if (unlockedRef.current || playingId) return;
    unlockedRef.current = true;
    try {
      player.muted = true;
      player.src = SILENT_WAV;
      const result = player.play();
      const settle = () => {
        player.pause();
        player.currentTime = 0;
        player.muted = false;
        player.removeAttribute("src");
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
  }, [player, unlockContext, playingId]);

  const dropAudio = useCallback(
    (requestId: string): void => {
      dropWasm(requestId);
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
    [dropWasm, clearAudioStatus]
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
