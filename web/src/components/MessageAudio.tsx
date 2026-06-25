import { Loader2, RotateCcw } from "lucide-react";
import { InlineAudioPlayer } from "@/components/InlineAudioPlayer";

// The audio controls a row binds to — the playback surface shared by message bubbles AND question-wizard
// sub-questions, so both render the EXACT same player (play/pause, scrubber, replay). Keyed by requestId:
// a message uses its native uuid; a wizard sub-question uses the composite `uuid#index` (one clip each).
export type AudioControls = {
  playingId: string | null;
  loadedId: string | null;
  position: number;
  duration: number;
  // True when the active entry is paused (show the play icon instead of pause).
  paused: boolean;
  playableIds: ReadonlySet<string>;
  // Per-reply audio lifecycle (pending = synthesizing, failed = retryable) for the loading/retry indicator.
  audioStatus: ReadonlyMap<string, "pending" | "failed">;
  // requestId for which a tap-to-play fetch is in flight (loading spinner for steps + history rows).
  pendingPlayId: string | null;
  onPlay: (requestId: string) => void;
  onReplay: (requestId: string) => void;
  onSeek: (requestId: string, seconds: number) => void;
};

// Skeleton player shown while audio is synthesizing — same structural dimensions as InlineAudioPlayer
// so the bubble height never shifts when the real player swaps in.
export function AudioPendingPlayer() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-full bg-violet/40">
        <Loader2 className="size-4 animate-spin text-white" aria-hidden="true" />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="w-9 shrink-0 text-right text-[11px] font-medium tabular-nums text-violet-ink/40">0:00</span>
        <div className="h-1.5 flex-1 rounded-full bg-violet/15" />
        <span className="w-9 shrink-0 text-[11px] font-medium tabular-nums text-violet-ink/40" />
      </div>
      {/* placeholder keeps the same width as the replay button */}
      <div className="size-8 shrink-0" />
    </div>
  );
}

// Shown when synthesis failed — tapping re-requests it (the daemon re-synthesizes on demand).
export function AudioRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onRetry();
      }}
      className="flex items-center gap-1.5 rounded-full text-xs font-medium text-danger transition-colors hover:text-danger/80"
    >
      <RotateCcw className="size-3.5" aria-hidden="true" />
      <span>Voice failed — tap to retry</span>
    </button>
  );
}

// The right audio affordance for `requestId`, given the current playback state: the loading skeleton while
// it synthesizes, the full inline player once it's playable, or a retry on failure. Returns null when the
// row has no audio at all. Used by message bubbles and the question wizard alike, so playback is identical.
export function MessageAudio({ controls, requestId }: { controls: AudioControls; requestId: string }) {
  const status = controls.audioStatus.get(requestId);
  const isFetchPending = controls.pendingPlayId === requestId;
  const loaded = controls.loadedId === requestId;
  if (status === "pending" || isFetchPending) return <AudioPendingPlayer />;
  if (controls.playableIds.has(requestId)) {
    return (
      <InlineAudioPlayer
        playing={controls.playingId === requestId && !controls.paused}
        loaded={loaded}
        position={loaded ? controls.position : 0}
        duration={loaded ? controls.duration : 0}
        onPlayPause={() => controls.onPlay(requestId)}
        onReplay={() => controls.onReplay(requestId)}
        onSeek={(seconds) => controls.onSeek(requestId, seconds)}
      />
    );
  }
  if (status === "failed") return <AudioRetry onRetry={() => controls.onPlay(requestId)} />;
  return null;
}
