import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { blobFromBase64 } from "../lib/audio";
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
  speaking: boolean;
  playbackRate: number;
  formattedRate: string;
  attachAudio: (requestId: string, audioBase64: string, mimeType: string, replay: boolean) => void;
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
  const currentUrlRef = useRef<string | null>(null);

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
  // that audio lands in attachAudio we play it immediately and clear this. A ref (not
  // state) so attachAudio reads the latest value without re-subscribing.
  const pendingPlayIdRef = useRef<string | null>(null);

  player.playbackRate = playbackRate;

  // Reflect the audio element's actual play/pause into render state.
  useEffect(() => {
    const onPlay = () => setPlayingId(currentPlayingIdRef.current);
    // Fully tear down the <audio> element. This is the load-bearing fix for "background
    // music never resumes": on iOS a still-loaded element keeps WebKit's native audio
    // session ACTIVE, which suppresses the resume of the other app (Spotify/Apple Music).
    // Removing the src + calling load() forces the session to deactivate — the reliable
    // trigger for the other app to come back. We then mark the session explicitly mixable
    // ("ambient"); the next reply re-claims "transient-solo" in startPlayback.
    const unload = () => {
      try {
        player.pause();
      } catch {
        /* ignore */
      }
      player.removeAttribute("src");
      try {
        player.load();
      } catch {
        /* ignore */
      }
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }
      currentPlayingIdRef.current = null;
      setPlayingId(null);
      setLoadedId(null);
      setPosition(0);
      setDuration(0);
      setAudioSessionType("ambient");
    };
    const onPause = () => {
      setPlayingId(null);
      // A manual pause keeps the clip loaded (so it can be resumed from the scrubber) but
      // still hands the session back as mixable so background audio isn't held hostage.
      setAudioSessionType("ambient");
    };
    // Natural end / load error → tear the element down so the native session deactivates
    // and any ducked background music resumes. The row falls back to its replay control
    // (still in playableIds); a tap reloads it fresh. A natural end (however the clip was started —
    // autoplay OR a manual tap) fires onAutoReplyFinished, the auto-respond hands-free trigger; App gates
    // it to a real final reply + the setting. A load error never fires it.
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

  // Start (or resume) the loaded clip. Claims the iOS "transient-solo" audio session
  // first, so background music (Spotify) pauses for the reply and auto-resumes when the
  // clip ends/pauses (the pause/ended/error listeners reset the session to "auto").
  const startPlayback = useCallback((): void => {
    setAudioSessionType("transient-solo");
    player.play().catch(() => {});
  }, [player]);

  const playEntry = useCallback(
    (requestId: string): void => {
      if (currentPlayingIdRef.current === requestId) {
        if (player.paused) {
          if (player.ended) player.currentTime = 0;
          startPlayback();
        } else {
          player.pause();
        }
        return;
      }
      if (loadEntry(requestId)) {
        startPlayback();
        return;
      }
      // No cached bytes. If this is a history reply the daemon still has, fetch it on
      // demand: mark it pending so attachAudio plays it the moment it lands. (We're inside
      // the tap gesture, so unlocking the element earlier keeps autoplay allowed.) The
      // unlock already happened on first tap; pending playback resumes the iOS session in
      // attachAudio → playEntry.
      pendingPlayIdRef.current = requestId;
      onRequestAudioRef.current?.(requestId);
    },
    [player, loadEntry, startPlayback]
  );

  const replayEntry = useCallback(
    (requestId: string): void => {
      if (!loadEntry(requestId)) {
        // No cached bytes yet (a history row). Fetch on demand; attachAudio plays it from
        // the start since a freshly-loaded clip begins at 0.
        pendingPlayIdRef.current = requestId;
        onRequestAudioRef.current?.(requestId);
        return;
      }
      player.currentTime = 0;
      player.playbackRate = playbackRate;
      startPlayback();
    },
    [player, loadEntry, playbackRate, startPlayback]
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
      clearAudioStatus(requestId); // audio arrived → no longer pending/failed
      setPlayableIds((prev) => {
        if (prev.has(requestId)) return prev;
        const next = new Set(prev);
        next.add(requestId);
        return next;
      });
      // A tap-to-play we fetched on demand: play it now (this is the user's intent), even
      // though it arrives flagged `replay`. Clearing pending first so a later attach for the
      // same id doesn't re-trigger.
      if (pendingPlayIdRef.current === requestId) {
        pendingPlayIdRef.current = null;
        playEntry(requestId);
        return;
      }
      // Otherwise: auto-play a fresh reply — but ONLY if autoplay is on. With autoplay off the audio is
      // still cached + playable (above), it just waits for a tap. A missed (replayed) one also waits.
      const autoplayOn = getAutoplayRef.current ? getAutoplayRef.current() : true;
      if (!getRecordingRef.current() && !replay && autoplayOn) playEntry(requestId);
    },
    [playEntry, clearAudioStatus]
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
      if (requestId === currentPlayingIdRef.current) {
        stopPlayback();
        currentPlayingIdRef.current = null;
        setPlayingId(null);
        setLoadedId(null);
        setPosition(0);
        setDuration(0);
      }
      if (pendingPlayIdRef.current === requestId) pendingPlayIdRef.current = null;
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
    speaking,
    playbackRate,
    formattedRate,
    attachAudio,
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
