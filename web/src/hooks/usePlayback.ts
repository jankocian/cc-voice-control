import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { blobFromBase64 } from "../lib/audio";

const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = "voiceRemote.playbackRate";

function clampRate(rate: number): number {
  return SPEEDS.indexOf(rate) >= 0 ? rate : 1;
}

export function formatRate(rate: number): string {
  return `${rate}×`;
}

type CachedAudio = { audioBase64: string; mimeType: string };

export type Playback = {
  // requestId of the entry currently rendered as "playing" (shows the pause icon),
  // i.e. the loaded clip that is actively playing. null when paused/stopped.
  playingId: string | null;
  // requestIds that have audio attached → render play/replay controls + .playable.
  playableIds: ReadonlySet<string>;
  speaking: boolean;
  playbackRate: number;
  formattedRate: string;
  hasAudio: (requestId: string) => boolean;
  attachAudio: (requestId: string, audioBase64: string, mimeType: string, replay: boolean) => void;
  playEntry: (requestId: string) => void;
  replayEntry: (requestId: string) => void;
  stopPlayback: () => void;
  cycleSpeed: () => void;
  // Drop cached audio for a pruned message; stops playback if it was playing.
  dropAudio: (requestId: string) => void;
};

export type UsePlaybackOptions = {
  // Mirrors the vanilla guard: a fresh reply auto-plays only when not recording.
  getRecording: () => boolean;
};

export function usePlayback({ getRecording }: UsePlaybackOptions): Playback {
  const playerRef = useRef<HTMLAudioElement>();
  if (!playerRef.current) playerRef.current = new Audio();
  const player = playerRef.current;

  const audioByRequest = useRef(new Map<string, CachedAudio>());
  const currentPlayingIdRef = useRef<string | null>(null);
  const currentUrlRef = useRef<string | null>(null);

  const [playingId, setPlayingId] = useState<string | null>(null);
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
      currentPlayingIdRef.current = null;
      setPlayingId(null);
    };
    const onError = () => {
      currentPlayingIdRef.current = null;
      setPlayingId(null);
    };
    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ended", onEnded);
    player.addEventListener("error", onError);
    return () => {
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("ended", onEnded);
      player.removeEventListener("error", onError);
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

  const hasAudio = useCallback((requestId: string): boolean => audioByRequest.current.has(requestId), []);

  const dropAudio = useCallback(
    (requestId: string): void => {
      if (requestId === currentPlayingIdRef.current) {
        stopPlayback();
        currentPlayingIdRef.current = null;
        setPlayingId(null);
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
    playableIds,
    speaking,
    playbackRate,
    formattedRate,
    hasAudio,
    attachAudio,
    playEntry,
    replayEntry,
    stopPlayback,
    cycleSpeed,
    dropAudio
  };
}
