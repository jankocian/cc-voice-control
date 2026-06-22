import { Pause, Play, RotateCcw } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";

// Inline audio player embedded inside an agent bubble: play/pause, a scrubber with
// a draggable thumb, current time + duration, and a replay button. Wired to
// usePlayback — `loaded` rows reflect live position/duration; others show 0:00.
//
// The bubble itself is the play/pause target (a tap anywhere on the card toggles — see
// MessageBubble), so each real control here stops propagation: tapping play/scrub/replay does its
// own thing without the card also toggling underneath it.
function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function InlineAudioPlayer({
  playing,
  loaded,
  position,
  duration,
  onPlayPause,
  onReplay,
  onSeek
}: {
  playing: boolean;
  loaded: boolean;
  position: number;
  duration: number;
  onPlayPause: () => void;
  onReplay: () => void;
  onSeek: (seconds: number) => void;
}) {
  const pos = loaded ? position : 0;
  const dur = loaded && duration > 0 ? duration : 0;

  return (
    <div className="flex items-center gap-3">
      {/* Play / pause */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onPlayPause();
        }}
        aria-label={playing ? "Pause" : "Play"}
        className="grid size-9 shrink-0 place-items-center rounded-full bg-violet text-white shadow-soft transition-transform duration-150 ease-soft active:scale-95"
      >
        {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current translate-x-px" />}
      </button>

      {/* Scrubber + times. Stops propagation so a scrub never reads as a card play/pause tap, and
          `data-no-pager` tells the thread carousel's watchDrag to leave a horizontal scrub alone instead
          of paging between threads (stopPropagation alone is too late — Embla's drag listener sits on an
          ancestor and sees the native pointerdown first). */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: not a control — only guards the card tap;
          the slider + buttons inside are the actual controls. */}
      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-no-pager=""
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="w-9 shrink-0 text-right text-[11px] font-medium tabular-nums text-violet-ink/80">
          {fmt(pos)}
        </span>
        <Slider
          value={dur > 0 ? pos : 0}
          max={dur > 0 ? dur : 1}
          min={0}
          step={0.05}
          disabled={!loaded || dur === 0}
          onValueChange={(value) => {
            const next = Array.isArray(value) ? value[0] : value;
            if (typeof next === "number") onSeek(next);
          }}
          className={cn("flex-1", (!loaded || dur === 0) && "opacity-70")}
        />
        {/* Total length only once it's actually known — before that it's a lie (0:00). The width is
            reserved either way so revealing it never nudges the scrubber. */}
        <span className="w-9 shrink-0 text-[11px] font-medium tabular-nums text-violet-ink/60">
          {dur > 0 ? fmt(dur) : ""}
        </span>
      </div>

      {/* Replay */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onReplay();
        }}
        aria-label="Replay from start"
        className="grid size-8 shrink-0 place-items-center rounded-full text-violet-ink/70 transition-colors hover:bg-violet/15 hover:text-violet-ink"
      >
        <RotateCcw className="size-4" />
      </button>
    </div>
  );
}
