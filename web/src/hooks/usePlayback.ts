import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { blobFromBase64 } from "../lib/audio";

const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = "voiceRemote.playbackRate";

function clampRate(rate: number): number {
  return SPEEDS.indexOf(rate) >= 0 ? rate : 1;
}

// A zero-length silent WAV. Played once inside a user gesture, it "unlocks" the
// shared <audio> element so subsequent programmatic autoplay (TTS replies) is
// allowed by the browser's autoplay policy (esp. iOS Safari).
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

export function formatRate(rate: number): string {
  return `${rate}x`;
}

type CachedAudio = { audioBase64: string; mimeType: string };

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
  // requestIds that have audio attached → render play/replay controls + .playable.
  playableIds: ReadonlySet<string>;
  speaking: boolean;
  playbackRate: number;
  formattedRate: string;
  hasAudio: (requestId: string) => boolean;
  attachAudio: (requestId: string, audioBase64: string, mimeType: string, replay: boolean) => void;
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
  // Mirrors the vanilla guard: a fresh reply auto-plays only when not recording.
  getRecording: () => boolean;
};

export function usePlayback({ getRecording }: UsePlaybackOptions): Playback {
  const playerRef = useRef<HTMLAudioElement | null>(null);
  if (!playerRef.current) playerRef.current = new Audio();
  const player = playerRef.current;

  const audioByRequest = useRef(new Map<string, CachedAudio>());
  const currentPlayingIdRef = useRef<string | null>(null);
  const currentUrlRef = useRef<string | null>(null);

  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playableIds, setPlayableIds] = useState<ReadonlySet<string>>(new Set());
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

  player.playbackRate = playbackRate;

  // Reflect the audio element's actual play/pause into render state. The vanilla
  // client toggled the .playing class on play and cleared it on pause/ended/error.
  useEffect(() => {
    const onPlay = () => setPlayingId(currentPlayingIdRef.current);
    const onPause = () => setPlayingId(null);
    const onEnded = () => {
      // Keep the row loaded (scrubber stays visible) but reset the playhead so a
      // tap on play restarts; only the "playing" pause-icon state clears.
      setPlayingId(null);
      setPosition(0);
    };
    const onError = () => {
      currentPlayingIdRef.current = null;
      setPlayingId(null);
      setLoadedId(null);
    };
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

  // Release the object URL + pause on teardown.
  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {
        /* ignore */
      }
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }
    };
  }, [player]);

  const loadEntry = useCallback(
    (requestId: string): boolean => {
      const audio = audioByRequest.current.get(requestId);
      if (!audio) return false;
      if (currentPlayingIdRef.current !== requestId) {
        player.pause();
        currentPlayingIdRef.current = requestId;
        setLoadedId(requestId);
        setPosition(0);
        setDuration(0);
        if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = URL.createObjectURL(blobFromBase64(audio.audioBase64, audio.mimeType));
        player.src = currentUrlRef.current;
        player.playbackRate = playbackRate;
      }
      return true;
    },
    [player, playbackRate]
  );

  const playEntry = useCallback(
    (requestId: string): void => {
      if (currentPlayingIdRef.current === requestId) {
        if (player.paused) {
          if (player.ended) player.currentTime = 0;
          player.play().catch(() => {});
        } else {
          player.pause();
        }
        return;
      }
      if (loadEntry(requestId)) player.play().catch(() => {});
    },
    [player, loadEntry]
  );

  const replayEntry = useCallback(
    (requestId: string): void => {
      if (!loadEntry(requestId)) return;
      player.currentTime = 0;
      player.playbackRate = playbackRate;
      player.play().catch(() => {});
    },
    [player, loadEntry, playbackRate]
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
      setPlayableIds((prev) => {
        if (prev.has(requestId)) return prev;
        const next = new Set(prev);
        next.add(requestId);
        return next;
      });
      // Auto-play a fresh reply; a missed (replayed) one waits for a tap.
      if (!getRecordingRef.current() && !replay) playEntry(requestId);
    },
    [playEntry]
  );

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
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    // Only unlock when idle (don't stomp an actively-loaded clip).
    if (currentPlayingIdRef.current) return;
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

  const hasAudio = useCallback((requestId: string): boolean => audioByRequest.current.has(requestId), []);

  const dropAudio = useCallback(
    (requestId: string): void => {
      if (requestId === currentPlayingIdRef.current) {
        stopPlayback();
        currentPlayingIdRef.current = null;
        setPlayingId(null);
        setLoadedId(null);
        setPosition(0);
        setDuration(0);
      }
      audioByRequest.current.delete(requestId);
      setPlayableIds((prev) => {
        if (!prev.has(requestId)) return prev;
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    },
    [stopPlayback]
  );

  const speaking = playingId !== null;

  const formattedRate = useMemo(() => formatRate(playbackRate), [playbackRate]);

  return {
    playingId,
    loadedId,
    position,
    duration,
    playableIds,
    speaking,
    playbackRate,
    formattedRate,
    hasAudio,
    attachAudio,
    playEntry,
    replayEntry,
    seekEntry,
    stopPlayback,
    cycleSpeed,
    dropAudio,
    unlock
  };
}
