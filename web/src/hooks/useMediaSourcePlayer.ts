import {
  ADTS,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  ReadableStreamSource,
  StreamTarget
} from "mediabunny";
import { useCallback, useEffect, useRef, useState } from "react";
import { bytesFromBase64 } from "../lib/audio";
import { setAudioSessionType } from "../lib/audioSession";

export type MediaSourcePlayer = {
  playingId: string | null;
  loadedId: string | null;
  duration: number;
  // True when the active reply is paused (loaded, element not advancing).
  paused: boolean;
  getPosition: () => number;
  seekTo: (offsetSeconds: number) => void;
  // Playback speed. Pitch is preserved by the NATIVE element (preservesPitch) — the browser's own
  // time-stretch (the same one YouTube/Safari use). Live + next clips.
  setRate: (rate: number) => void;
  // Play a complete AAC (ADTS) clip — tap-to-play / replay. Runs through the same streaming path.
  playFile: (requestId: string, base64: string) => void;
  // Feed one incremental AAC (ADTS) chunk of a live reply.
  attachChunk: (requestId: string, base64: string) => void;
  // Signal end of the live stream (no more chunks).
  endStream: (requestId: string) => void;
  // Pause / resume the active reply (works mid-stream — the stream keeps buffering while paused).
  togglePause: (requestId: string) => void;
  stop: (requestId?: string) => void;
  drop: (requestId: string) => void;
  unlock: () => void;
  isUnlocked: () => boolean;
  isStreaming: (requestId: string) => boolean;
};

const AAC_MIME = 'audio/mp4; codecs="mp4a.40.2"';
// A minimal silent WAV — played within a user gesture to bless the <audio> element for later autoplay (iOS).
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

type MS = typeof MediaSource;

function pickMediaSource(): MS | null {
  const w = window as unknown as { ManagedMediaSource?: MS; MediaSource?: MS };
  return w.ManagedMediaSource ?? w.MediaSource ?? null;
}

// ONE playback path. Every reply plays through a single native <audio> element, so speed uses the
// browser's own pitch-preserving time-stretch (preservesPitch) — native quality. AAC (ADTS) bytes are
// remuxed to one continuous fragmented MP4 stream by mediabunny and fed into a ManagedMediaSource /
// MediaSource as they arrive (~1 s first sound), with no re-encode. A complete clip (tap-to-play /
// replay) runs through the very same path — fed in one shot, then closed.
export function useMediaSourcePlayer(onFinished?: (requestId: string) => void): MediaSourcePlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blessedRef = useRef(false);

  // Current playback session.
  const msRef = useRef<MediaSource | null>(null);
  const sbRef = useRef<SourceBuffer | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null); // push ADTS bytes here
  const appendQueueRef = useRef<Uint8Array<ArrayBuffer>[]>([]); // fMP4 fragments awaiting appendBuffer
  const canAppendRef = useRef(true); // ManagedMediaSource gates appends via start/endstreaming
  const inputClosedRef = useRef(false); // the ADTS input stream has been closed (no more chunks)
  const genRef = useRef(0); // bumped per playback so a stale pipeline can't touch the element

  const currentPlayingIdRef = useRef<string | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const rateRef = useRef(1);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);

  const clearCurrent = useCallback((): void => {
    currentPlayingIdRef.current = null;
    streamingIdRef.current = null;
    setPlayingId(null);
    setLoadedId(null);
    setDuration(0);
    setPaused(false);
  }, []);

  const teardown = useCallback((): void => {
    try {
      writerRef.current?.abort();
    } catch {}
    writerRef.current = null;
    const sb = sbRef.current;
    const ms = msRef.current;
    if (sb && ms && ms.readyState === "open") {
      try {
        ms.removeSourceBuffer(sb);
      } catch {}
    }
    sbRef.current = null;
    msRef.current = null;
    appendQueueRef.current = [];
    inputClosedRef.current = false;
    if (objectUrlRef.current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {}
      objectUrlRef.current = null;
    }
    const el = audioRef.current as unknown as { srcObject: MediaSource | null } | null;
    if (el?.srcObject) el.srcObject = null;
  }, []);

  // A playback failure (element error / remux error / unsupported codec / append failure): cancel the
  // pipeline and return to idle so the UI doesn't hang on a "playing" reply. A failed reply is NOT
  // reported as finished (no onFinished) — it must not advance the auto-respond loop like a real end.
  const fail = useCallback((): void => {
    genRef.current++;
    teardown();
    clearCurrent();
  }, [teardown, clearCurrent]);

  const ensureElement = useCallback((): HTMLAudioElement => {
    if (audioRef.current) return audioRef.current;
    const el = new Audio();
    el.preservesPitch = true;
    (el as unknown as { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    el.addEventListener("ended", () => {
      const id = currentPlayingIdRef.current;
      clearCurrent();
      if (id) onFinishedRef.current?.(id);
    });
    el.addEventListener("error", () => {
      if (currentPlayingIdRef.current) fail();
    });
    // Keep `paused` in sync with the element (covers togglePause and any platform-driven pause).
    el.addEventListener("play", () => setPaused(false));
    el.addEventListener("pause", () => {
      if (currentPlayingIdRef.current && !el.ended) setPaused(true);
    });
    el.addEventListener("durationchange", () => {
      if (Number.isFinite(el.duration)) setDuration(el.duration);
    });
    audioRef.current = el;
    return el;
  }, [clearCurrent, fail]);

  // Append the next queued fMP4 fragment when the SourceBuffer is idle and (for ManagedMediaSource) the
  // browser is asking for data; finalize once the input is closed and everything has been appended.
  const pump = useCallback((): void => {
    const sb = sbRef.current;
    const ms = msRef.current;
    if (!sb || !ms) return;
    if (sb.updating || !canAppendRef.current) return;
    const next = appendQueueRef.current.shift();
    if (next) {
      try {
        sb.appendBuffer(next);
      } catch {
        fail(); // QuotaExceeded / invalid state — don't leave the UI stuck on a half-played reply
      }
      return;
    }
    if (inputClosedRef.current && ms.readyState === "open") {
      try {
        ms.endOfStream();
      } catch {}
    }
  }, [fail]);

  const startPlaybackOnce = useCallback((el: HTMLAudioElement): void => {
    if (startedRef.current) return;
    startedRef.current = true;
    el.playbackRate = rateRef.current;
    el.preservesPitch = true;
    el.play().then(
      () => {
        el.playbackRate = rateRef.current; // a fresh source can reset the rate; re-apply once playing
        el.preservesPitch = true;
      },
      () => {}
    );
  }, []);

  // Open a fresh native-element playback: MediaSource + the mediabunny remux pipeline. Returns a writer
  // the caller feeds ADTS bytes into; closing it finalizes the stream.
  const begin = useCallback(
    (requestId: string, streaming: boolean): number => {
      const gen = ++genRef.current;
      teardown();
      startedRef.current = false;
      canAppendRef.current = true;
      inputClosedRef.current = false;
      currentPlayingIdRef.current = requestId;
      streamingIdRef.current = streaming ? requestId : null;
      setPlayingId(requestId);
      setLoadedId(requestId);
      setDuration(0);
      setPaused(false);
      setAudioSessionType("ambient");

      const el = ensureElement();
      const Ctor = pickMediaSource();
      if (!Ctor?.isTypeSupported(AAC_MIME)) {
        clearCurrent(); // no MSE/AAC support — don't strand the UI in a "playing" state
        return gen;
      }
      const ms = new Ctor();
      msRef.current = ms;
      const isManaged = (window as unknown as { ManagedMediaSource?: MS }).ManagedMediaSource === Ctor;
      if (isManaged) {
        canAppendRef.current = false; // append only while the browser is pulling
        // Guard on gen: a torn-down (but not-yet-GC'd) MediaSource must not flip the current session's gate.
        ms.addEventListener("startstreaming", () => {
          if (gen !== genRef.current) return;
          canAppendRef.current = true;
          pump();
        });
        ms.addEventListener("endstreaming", () => {
          if (gen !== genRef.current) return;
          canAppendRef.current = false;
        });
        (el as unknown as { srcObject: MediaSource }).srcObject = ms;
      } else {
        const url = URL.createObjectURL(ms);
        objectUrlRef.current = url;
        el.src = url;
      }
      ms.addEventListener(
        "sourceopen",
        () => {
          if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
          }
          if (gen !== genRef.current || ms.readyState !== "open") return;
          try {
            const sb = ms.addSourceBuffer(AAC_MIME);
            sb.addEventListener("updateend", pump);
            sbRef.current = sb;
            pump();
          } catch {}
        },
        { once: true }
      );

      // ADTS (growing) → mediabunny → one continuous fragmented MP4 stream → appendBuffer queue.
      const adtsStream = new TransformStream<Uint8Array, Uint8Array>();
      writerRef.current = adtsStream.writable.getWriter();
      const input = new Input({ formats: [ADTS], source: new ReadableStreamSource(adtsStream.readable) });
      const target = new StreamTarget(
        new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
          write(chunk) {
            if (gen !== genRef.current) return;
            appendQueueRef.current.push(chunk.data as Uint8Array<ArrayBuffer>);
            pump();
            startPlaybackOnce(el);
          }
        })
      );
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 0.1 }),
        target
      });
      const source = new EncodedAudioPacketSource("aac");
      output.addAudioTrack(source);

      void (async () => {
        try {
          const track = await input.getPrimaryAudioTrack();
          if (!track || gen !== genRef.current) return;
          const decoderConfig = await track.getDecoderConfig();
          if (!decoderConfig || gen !== genRef.current) return;
          await output.start();
          let first = true;
          const sink = new EncodedPacketSink(track);
          for await (const packet of sink.packets()) {
            if (gen !== genRef.current) return;
            await source.add(packet, first ? { decoderConfig } : undefined);
            first = false;
          }
          if (gen !== genRef.current) return;
          await output.finalize();
          // Only NOW are all fragments queued — safe to let pump() call endOfStream (no early-truncation race).
          if (gen !== genRef.current) return;
          inputClosedRef.current = true;
          pump();
        } catch {
          // gen changed → this is a benign abort from a newer playback/stop; same gen → a real remux
          // failure (malformed AAC), so surface it as a failure instead of hanging on a half-played clip.
          if (gen === genRef.current) fail();
        }
      })();

      return gen;
    },
    [clearCurrent, ensureElement, fail, pump, startPlaybackOnce, teardown]
  );

  const attachChunk = useCallback(
    (requestId: string, base64: string): void => {
      if (streamingIdRef.current !== requestId) begin(requestId, true);
      const bytes = bytesFromBase64(base64);
      writerRef.current?.write(bytes).catch(() => {});
    },
    [begin]
  );

  const endStream = useCallback((requestId: string): void => {
    if (currentPlayingIdRef.current !== requestId) return;
    streamingIdRef.current = null;
    // Close the ADTS input; the pipeline finalizes, then flips inputClosed + calls endOfStream.
    writerRef.current?.close().catch(() => {});
  }, []);

  // Full clip: same streaming path, fed in one shot and closed immediately.
  const playFile = useCallback(
    (requestId: string, base64: string): void => {
      begin(requestId, false);
      const bytes = bytesFromBase64(base64);
      const writer = writerRef.current;
      if (!writer) return;
      writer.write(bytes).catch(() => {});
      writer.close().catch(() => {});
    },
    [begin]
  );

  const stop = useCallback(
    (requestId?: string): void => {
      const id = requestId ?? currentPlayingIdRef.current;
      if (!id || currentPlayingIdRef.current !== id) return;
      genRef.current++;
      const el = audioRef.current;
      if (el) {
        try {
          el.pause();
          el.removeAttribute("src");
          el.load();
        } catch {}
      }
      teardown();
      clearCurrent();
    },
    [clearCurrent, teardown]
  );

  const drop = stop;

  const getPosition = useCallback((): number => {
    const el = audioRef.current;
    if (!el || !currentPlayingIdRef.current || !Number.isFinite(el.currentTime)) return 0;
    return el.currentTime;
  }, []);

  const seekTo = useCallback((offsetSeconds: number): void => {
    const el = audioRef.current;
    if (!el || !currentPlayingIdRef.current) return;
    try {
      el.currentTime = Math.max(0, offsetSeconds);
    } catch {}
  }, []);

  const setRate = useCallback((rate: number): void => {
    rateRef.current = rate;
    const el = audioRef.current;
    if (el && currentPlayingIdRef.current) {
      el.playbackRate = rate;
      el.preservesPitch = true;
    }
  }, []);

  // Pause/resume the active reply. During streaming the element pauses but the pipeline keeps buffering,
  // so resuming continues seamlessly. The play/pause event listeners keep `paused` in sync.
  const togglePause = useCallback((requestId: string): void => {
    const el = audioRef.current;
    if (!el || currentPlayingIdRef.current !== requestId) return;
    if (el.paused) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, []);

  const unlock = useCallback((): void => {
    const el = ensureElement();
    if (blessedRef.current) return;
    blessedRef.current = true;
    // Play a short silent clip within the user gesture so later programmatic replies can autoplay (iOS).
    el.src = SILENT_WAV;
    el.play().then(
      () => {
        el.pause();
        el.currentTime = 0;
        el.removeAttribute("src");
      },
      () => {}
    );
  }, [ensureElement]);

  const isUnlocked = useCallback((): boolean => blessedRef.current && audioRef.current !== null, []);

  const isStreaming = useCallback((requestId: string): boolean => streamingIdRef.current === requestId, []);

  useEffect(
    () => () => {
      try {
        audioRef.current?.pause();
      } catch {}
      teardown();
    },
    [teardown]
  );

  return {
    playingId,
    loadedId,
    duration,
    paused,
    getPosition,
    seekTo,
    setRate,
    playFile,
    attachChunk,
    endStream,
    togglePause,
    stop,
    drop,
    unlock,
    isUnlocked,
    isStreaming
  };
}
