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
// `delay` staggers the strong working/speaking equalizer (mirrored, tall-in-middle).
// `soft` staggers the calm ready wave as a left→right travelling ripple, so "ready"
// reads as alive rather than a synchronised breathe.
const BARS = [
  { id: "l3", h: "h-4", delay: "[animation-delay:0ms]", soft: "[animation-delay:0ms]" },
  { id: "l2", h: "h-7", delay: "[animation-delay:120ms]", soft: "[animation-delay:80ms]" },
  { id: "l1", h: "h-10", delay: "[animation-delay:240ms]", soft: "[animation-delay:160ms]" },
  { id: "c", h: "h-14", delay: "[animation-delay:360ms]", soft: "[animation-delay:240ms]" },
  { id: "r1", h: "h-10", delay: "[animation-delay:240ms]", soft: "[animation-delay:320ms]" },
  { id: "r2", h: "h-7", delay: "[animation-delay:120ms]", soft: "[animation-delay:400ms]" },
  { id: "r3", h: "h-4", delay: "[animation-delay:0ms]", soft: "[animation-delay:480ms]" }
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
  const ready = dataState === "ready";
  const active = working || speaking; // strong equalizer animation
  // Colour by state: violet = speaking, green = connected/ready (waiting for you),
  // coral = working/sending (and the calm fallback for any other state).
  const tone = speaking ? "bg-violet" : ready ? "bg-success" : "bg-coral";

  return (
    <div className="relative grid h-20 w-full place-items-center *:col-start-1 *:row-start-1" aria-hidden="true">
      {/* Soft aura that warms up as things get busier. */}
      <div
        className={cn(
          "size-24 rounded-full blur-2xl transition-opacity duration-500",
          speaking ? "bg-violet/15" : ready ? "bg-success/12" : "bg-coral/15",
          recording || active ? "opacity-100" : ready ? "opacity-70" : "opacity-40"
        )}
      />

      {/* Recording → the real mic waveform. */}
      <canvas
        ref={canvasRef}
        className={cn("h-14 w-60 transition-opacity duration-200", visualizerActive ? "opacity-100" : "opacity-0")}
      />

      {/* Connecting / waiting → three travelling dots. */}
      {dots && (
        <div className="flex items-center gap-2.5">
          <span className="size-3 animate-dot-bounce rounded-full bg-coral" />
          <span className="size-3 animate-dot-bounce rounded-full bg-coral [animation-delay:0.18s]" />
          <span className="size-3 animate-dot-bounce rounded-full bg-coral [animation-delay:0.36s]" />
        </div>
      )}

      {/* Otherwise → the equalizer: strong while working/speaking, a gentle green
          breathe while ready (waiting for you to speak), calm/dim at rest. */}
      {!recording && !dots && (
        <div className="flex items-end gap-2">
          {BARS.map((bar) => (
            <span
              key={bar.id}
              className={cn(
                "w-2 origin-center rounded-full",
                bar.h,
                tone,
                active
                  ? cn("animate-bar", bar.delay)
                  : ready
                    ? cn("animate-bar-soft", bar.soft)
                    : "scale-y-[0.35] opacity-50"
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
