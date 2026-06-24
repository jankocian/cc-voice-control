import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOggOpusPlayer } from "./useOggOpusPlayer";

const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = "voiceRemote.playbackRate";
const DEFAULT_RATE = 1.25;

function clampRate(rate: number): number {
  return SPEEDS.indexOf(rate) >= 0 ? rate : DEFAULT_RATE;
}

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
  // `background` = landed on a thread you're not viewing; `replay` = the daemon suppressed its autoplay
  // (an older burst reply or a fetched history clip). Either one → cache it, don't auto-play.
  attachAudio: (requestId: string, audioBase64: string, mimeType: string, background: boolean, replay: boolean) => void;
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

  // OGG Opus player: decodes to PCM via WASM, plays through an <audio> element (pitch-preserving speed).
  const {
    playingId,
    loadedId,
    duration,
    getPosition,
    seekTo,
    setRate,
    playFile,
    attachChunk,
    endStream,
    stop: stopWasm,
    drop: dropWasm,
    unlockContext,
    hasContext,
    isStreaming
  } = useOggOpusPlayer(onAutoReplyFinished);

  // Push the playback speed into the OGG engine (the actual TTS path). Runs on mount (applies the
  // stored rate) and on every cycleSpeed change (live-adjusts the clip currently playing).
  useEffect(() => {
    setRate(playbackRate);
  }, [playbackRate, setRate]);

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
  }, [stopWasm]);

  const playEntry = useCallback(
    (requestId: string): void => {
      // Tap the entry that's already playing → stop it (re-tap restarts from the top).
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
    (requestId: string, audioBase64: string, mimeType: string, background: boolean, replay: boolean): void => {
      if (!requestId || !audioBase64) return;
      audioByRequest.current.set(requestId, { audioBase64, mimeType });
      clearAudioStatus(requestId);
      setPlayableIds((prev) => {
        if (prev.has(requestId)) return prev;
        const next = new Set(prev);
        next.add(requestId);
        return next;
      });

      // An explicit tap-to-play wins over everything: play as soon as the audio lands — even mid-stream
      // (the bubble is tappable from history while still synthesizing) and even with autoplay off. Clear
      // the stream marker so a later duplicate (the stream-completing clip, or the get_audio response we
      // requested) doesn't re-handle it.
      if (pendingPlayIdRef.current === requestId) {
        pendingPlayIdRef.current = null;
        setPendingPlayId(null);
        endStream(requestId);
        if (hasContext()) playFile(requestId, audioBase64);
        return;
      }

      // Autoplay requires the LIVE foreground state (a reply on a thread you're not viewing waits for
      // a tap), plus not recording and autoplay on.
      const autoplayOn = getAutoplayRef.current?.() ?? true;
      const shouldAutoplay = !background && !getRecordingRef.current() && autoplayOn && hasContext();

      // A streaming reply: its chunks were only a "synthesizing" signal (we don't play chunks — that
      // needs pitch-shifting Web Audio). The full clip is here now. This is the just-spoken reply, so
      // play it whenever it's foreground — even though the daemon flags the stream-completing clip
      // replay=true (that flag must NOT suppress it here).
      if (isStreaming(requestId)) {
        endStream(requestId);
        if (shouldAutoplay) playFile(requestId, audioBase64);
        return;
      }
      // Fall-through: a non-streamed full clip. `replay` here means the daemon deliberately suppressed
      // its autoplay — an OLDER reply in a burst (only the newest is meant to speak), or a fetched
      // history clip. Honour that: cache it (tap-to-play), don't read it aloud.
      if (!replay && shouldAutoplay) playFile(requestId, audioBase64);
    },
    [clearAudioStatus, isStreaming, endStream, hasContext, playFile]
  );

  const attachAudioChunk = useCallback(
    (requestId: string, seq: number, audioBase64: string, _mimeType: string, background: boolean): void => {
      if (!requestId || !audioBase64) return;
      if (seq === 0) clearAudioStatus(requestId);
      if (background) return; // tts_audio(replay:true) will cache full clip; user taps to play
      attachChunk(requestId);
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
      try {
        localStorage.setItem(RATE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const unlock = useCallback((): void => {
    // Bless the <audio> element within this user gesture so later autoplay isn't blocked (iOS).
    unlockContext();
  }, [unlockContext]);

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
