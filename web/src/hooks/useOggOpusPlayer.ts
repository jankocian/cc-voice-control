import { OggOpusDecoder } from "ogg-opus-decoder";
import { useCallback, useEffect, useRef, useState } from "react";
import { bytesFromBase64 } from "../lib/audio";
import { setAudioSessionType } from "../lib/audioSession";

// A zero-length silent WAV. Played once inside a user gesture, it "unlocks" the shared <audio>
// element so later programmatic playback (autoplayed replies) is allowed by the browser's autoplay
// policy (esp. iOS Safari).
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

// Encode decoded PCM (Float32 channels @ 48 kHz from the Opus decoder) into a 16-bit PCM WAV blob.
// We play through an <audio> element rather than Web Audio because HTMLMediaElement.playbackRate
// preserves pitch (preservesPitch) — AudioBufferSourceNode.playbackRate does not (it chipmunks).
// iOS Safari can't decode OGG Opus in <audio> natively, so we decode to PCM (main-thread WASM, which
// the page CSP allows) and hand the element a universally-supported WAV.
function pcmToWavBlob(channels: Float32Array[], frames: number, sampleRate: number): Blob {
  const numCh = Math.max(1, channels.length);
  const blockAlign = numCh * 2; // 16-bit
  const dataSize = frames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numCh; c++) {
      let s = channels[c]?.[f] ?? 0;
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

export type OggOpusPlayer = {
  playingId: string | null;
  loadedId: string | null;
  // Total clip duration in seconds (from the <audio> element). 0 when idle / not yet loaded.
  duration: number;
  // Live playhead position in seconds (reads the <audio> element's currentTime).
  getPosition: () => number;
  // Seek within the currently loaded clip.
  seekTo: (offsetSeconds: number) => void;
  // Set playback speed. Pitch is preserved (HTMLMediaElement.preservesPitch). Applies live + to the
  // next clip.
  setRate: (rate: number) => void;
  // Play a complete OGG Opus clip (tap-to-play / autoplay of a fresh reply / replay).
  playFile: (requestId: string, base64: string) => void;
  // Note that a live stream's chunks are arriving for this reply. We don't play the chunks (that
  // would need pitch-shifting Web Audio); we just mark it streaming so the full clip auto-plays when
  // it lands (see usePlayback.attachAudio). seq is unused but kept for call-site symmetry.
  attachChunk: (requestId: string) => void;
  // Clear the streaming marker for a reply (its full clip has arrived / it was dropped).
  endStream: (requestId: string) => void;
  // Stop active playback (optionally targeting a specific requestId).
  stop: (requestId?: string) => void;
  // Drop a specific reply (stop if it's playing, forget its streaming marker).
  drop: (requestId: string) => void;
  // Bless the <audio> element within a user gesture so later autoplay isn't blocked.
  unlockContext: () => void;
  hasContext: () => boolean;
  isStreaming: (requestId: string) => boolean;
};

// Plays OGG Opus TTS through a single <audio> element: decode to PCM via the main-thread WASM
// decoder, wrap as WAV, and let the element play it. Speed changes go through playbackRate with
// preservesPitch, so "1.5x" is faster WITHOUT the chipmunk pitch shift.
export function useOggOpusPlayer(onFinished?: (requestId: string) => void): OggOpusPlayer {
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  if (!audioElRef.current) {
    const a = new Audio();
    a.preload = "auto";
    audioElRef.current = a;
  }
  const audioEl = audioElRef.current;

  const currentUrlRef = useRef<string | null>(null);
  const currentPlayingIdRef = useRef<string | null>(null);
  // Replies whose live stream is in flight; their full clip auto-plays when it lands.
  const streamingRef = useRef(new Set<string>());
  const rateRef = useRef<number>(1);
  // Bumped on every playFile/stop so a slow decode that's been superseded discards its result.
  const decodeTokenRef = useRef(0);
  const unlockedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(0);

  const revokeUrl = useCallback((): void => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
  }, []);

  // Tear down playback state. fireFinished=true notifies onFinished (a clip ended naturally).
  const finish = useCallback(
    (fireFinished: boolean): void => {
      const endedId = currentPlayingIdRef.current;
      try {
        audioEl.pause();
      } catch {
        /* ignore */
      }
      revokeUrl();
      currentPlayingIdRef.current = null;
      setPlayingId(null);
      setLoadedId(null);
      setDuration(0);
      if (fireFinished && endedId) onFinishedRef.current?.(endedId);
    },
    [audioEl, revokeUrl]
  );

  // Wire the element's lifecycle events once. We share this element with the silent-WAV unlock, so
  // only react to ended/error of the REAL clip (currentSrc matches the blob we're playing) — never to
  // the unlock blessing's events, which would otherwise tear down a clip mid-decode.
  useEffect(() => {
    const a = audioEl;
    const isCurrentClip = () => currentUrlRef.current !== null && a.currentSrc === currentUrlRef.current;
    const onEnded = () => {
      if (isCurrentClip()) finish(true);
    };
    const onError = () => {
      if (isCurrentClip()) finish(false);
    };
    const onDuration = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) setDuration(a.duration);
    };
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);
    a.addEventListener("loadedmetadata", onDuration);
    a.addEventListener("durationchange", onDuration);
    return () => {
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onError);
      a.removeEventListener("loadedmetadata", onDuration);
      a.removeEventListener("durationchange", onDuration);
      decodeTokenRef.current++; // invalidate any in-flight decode
      try {
        a.pause();
      } catch {
        /* ignore */
      }
      revokeUrl();
    };
  }, [audioEl, finish, revokeUrl]);

  const playFile = useCallback(
    (requestId: string, base64: string): void => {
      const token = ++decodeTokenRef.current;
      // Supersede whatever is playing and show this reply as active immediately.
      streamingRef.current.delete(requestId);
      try {
        audioEl.pause();
      } catch {
        /* ignore */
      }
      revokeUrl();
      currentPlayingIdRef.current = requestId;
      setPlayingId(requestId);
      setLoadedId(requestId);
      setDuration(0);

      void (async () => {
        const decoder = new OggOpusDecoder();
        try {
          await decoder.ready;
          if (token !== decodeTokenRef.current) return;
          const { channelData, samplesDecoded } = await decoder.decodeFile(bytesFromBase64(base64));
          if (token !== decodeTokenRef.current) return;
          if (!samplesDecoded || channelData.length === 0) {
            if (currentPlayingIdRef.current === requestId) finish(false);
            return;
          }
          const url = URL.createObjectURL(pcmToWavBlob(channelData, samplesDecoded, 48000));
          currentUrlRef.current = url;
          setAudioSessionType("ambient");
          const a = audioEl;
          a.muted = false; // in case an unlock blessing left it muted (race on the very first tap)
          a.src = url;
          a.preservesPitch = true;
          a.playbackRate = rateRef.current;
          await a.play().catch(() => {
            // Autoplay blocked (not unlocked yet) or interrupted — drop back to idle.
            if (token === decodeTokenRef.current) finish(false);
          });
        } catch {
          if (token === decodeTokenRef.current && currentPlayingIdRef.current === requestId) finish(false);
        } finally {
          decoder.free();
        }
      })();
    },
    [audioEl, finish, revokeUrl]
  );

  const attachChunk = useCallback((requestId: string): void => {
    // The full clip auto-plays on arrival; here we only remember a stream is in flight.
    streamingRef.current.add(requestId);
  }, []);

  const endStream = useCallback((requestId: string): void => {
    streamingRef.current.delete(requestId);
  }, []);

  const stop = useCallback(
    (requestId?: string): void => {
      const id = requestId ?? currentPlayingIdRef.current;
      if (!id) return;
      streamingRef.current.delete(id);
      if (currentPlayingIdRef.current === id) {
        decodeTokenRef.current++; // cancel any in-flight decode for this id
        finish(false);
      }
    },
    [finish]
  );

  const drop = useCallback(
    (requestId: string): void => {
      streamingRef.current.delete(requestId);
      if (currentPlayingIdRef.current === requestId) {
        decodeTokenRef.current++;
        finish(false);
      }
    },
    [finish]
  );

  const getPosition = useCallback((): number => {
    const t = audioEl.currentTime;
    return Number.isFinite(t) ? t : 0;
  }, [audioEl]);

  const seekTo = useCallback(
    (offsetSeconds: number): void => {
      const dur = audioEl.duration;
      const max = Number.isFinite(dur) && dur > 0 ? dur : offsetSeconds;
      audioEl.currentTime = Math.min(Math.max(0, offsetSeconds), max);
    },
    [audioEl]
  );

  const setRate = useCallback(
    (rate: number): void => {
      rateRef.current = rate;
      audioEl.preservesPitch = true;
      audioEl.playbackRate = rate;
    },
    [audioEl]
  );

  const unlockContext = useCallback((): void => {
    if (unlockedRef.current || currentPlayingIdRef.current) return;
    unlockedRef.current = true;
    const a = audioEl;
    try {
      a.muted = true;
      a.src = SILENT_WAV;
      // Runs on both resolve and reject. If a real clip's playFile took over the element in the same
      // gesture (currentPlayingIdRef set), leave its playback alone — don't pause/unset/unmute it.
      const settle = () => {
        if (currentPlayingIdRef.current) return;
        a.pause();
        try {
          a.currentTime = 0;
        } catch {
          /* ignore */
        }
        a.muted = false;
        a.removeAttribute("src");
      };
      const result = a.play();
      if (result && typeof result.then === "function") result.then(settle, settle);
      else settle();
    } catch {
      a.muted = false;
    }
  }, [audioEl]);

  const hasContext = useCallback((): boolean => unlockedRef.current, []);

  const isStreaming = useCallback((requestId: string): boolean => streamingRef.current.has(requestId), []);

  return {
    playingId,
    loadedId,
    duration,
    getPosition,
    seekTo,
    setRate,
    playFile,
    attachChunk,
    endStream,
    stop,
    drop,
    unlockContext,
    hasContext,
    isStreaming
  };
}
