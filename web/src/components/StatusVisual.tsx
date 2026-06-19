import type { RefObject } from "react";
import type { StatusView } from "@/lib/status";
import { cn } from "@/lib/utils";

// The hero's central state visual — replaces the (removed) WebGL orb. It actually
// reflects what's happening, reusing the same language as the controls:
//   • recording          → the live mic waveform (painted into the canvas)
//   • connecting/waiting  → three travelling dots
//   • working / sending   → an animated equalizer (coral)
//   • speaking            → an animated equalizer (violet)
//   • ready / idle        → the equalizer at rest (calm, dimmed)
//
// Every child shares one grid cell (col/row-start-1) so they stack centered.

// Symmetric "tall in the middle" equalizer. Each bar carries a height and a
// staggered animation delay; arbitrary-value classes are build-time (no inline
// styles), consistent with the design-system rules.
const BARS = [
  { id: "l3", h: "h-4", delay: "[animation-delay:0ms]" },
  { id: "l2", h: "h-7", delay: "[animation-delay:120ms]" },
  { id: "l1", h: "h-10", delay: "[animation-delay:240ms]" },
  { id: "c", h: "h-14", delay: "[animation-delay:360ms]" },
  { id: "r1", h: "h-10", delay: "[animation-delay:240ms]" },
  { id: "r2", h: "h-7", delay: "[animation-delay:120ms]" },
  { id: "r3", h: "h-4", delay: "[animation-delay:0ms]" }
] as const;

export function StatusVisual({
  status,
  recording,
  visualizerActive,
  canvasRef
}: {
  status: StatusView;
  recording: boolean;
  visualizerActive: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const { dataState, key } = status;
  const dots = !recording && (key === "connecting" || key === "waiting");
  const speaking = dataState === "speaking";
  const working = dataState === "working" || dataState === "sending";
  const live = working || speaking; // equalizer animates
  const tone = speaking ? "bg-violet" : "bg-coral";

  return (
    <div className="relative grid h-28 w-full place-items-center *:col-start-1 *:row-start-1" aria-hidden="true">
      {/* Soft aura that warms up as things get busier. */}
      <div
        className={cn(
          "size-32 rounded-full blur-2xl transition-opacity duration-500",
          speaking ? "bg-violet/15" : "bg-coral/15",
          recording || live ? "opacity-100" : "opacity-40"
        )}
      />

      {/* Recording → the real mic waveform. */}
      <canvas
        ref={canvasRef}
        className={cn("h-16 w-60 transition-opacity duration-200", visualizerActive ? "opacity-100" : "opacity-0")}
      />

      {/* Connecting / waiting → three travelling dots. */}
      {dots && (
        <div className="flex items-center gap-2.5">
          <span className="size-3 animate-dot-bounce rounded-full bg-coral" />
          <span className="size-3 animate-dot-bounce rounded-full bg-coral [animation-delay:0.18s]" />
          <span className="size-3 animate-dot-bounce rounded-full bg-coral [animation-delay:0.36s]" />
        </div>
      )}

      {/* Otherwise → the equalizer (animated while working/speaking, calm at rest). */}
      {!recording && !dots && (
        <div className="flex items-end gap-2">
          {BARS.map((bar) => (
            <span
              key={bar.id}
              className={cn(
                "w-2 origin-center rounded-full",
                bar.h,
                tone,
                live ? cn("animate-bar", bar.delay) : "scale-y-[0.35] opacity-50"
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
