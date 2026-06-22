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
//
// `size="mini"` renders the SAME states/animations at a compact scale for the condensed
// header bar (no aura, no live canvas) — so the scrolled bar speaks the same language as
// the hero.

// Symmetric "tall in the middle" equalizer. Each bar carries a height and a
// staggered animation delay; arbitrary-value classes are build-time (no inline
// styles), consistent with the design-system rules.
// `delay` staggers the strong working/speaking equalizer (mirrored, tall-in-middle).
// `soft` staggers the calm ready wave as a left→right travelling ripple, so "ready"
// reads as alive rather than a synchronised breathe.
// `mini` is the compact bar height for the condensed header visualizer.
const BARS = [
  { id: "l3", h: "h-4", mini: "h-1.5", delay: "[animation-delay:0ms]", soft: "[animation-delay:0ms]" },
  { id: "l2", h: "h-7", mini: "h-3", delay: "[animation-delay:120ms]", soft: "[animation-delay:80ms]" },
  { id: "l1", h: "h-10", mini: "h-4", delay: "[animation-delay:240ms]", soft: "[animation-delay:160ms]" },
  { id: "c", h: "h-14", mini: "h-5", delay: "[animation-delay:360ms]", soft: "[animation-delay:240ms]" },
  { id: "r1", h: "h-10", mini: "h-4", delay: "[animation-delay:240ms]", soft: "[animation-delay:320ms]" },
  { id: "r2", h: "h-7", mini: "h-3", delay: "[animation-delay:120ms]", soft: "[animation-delay:400ms]" },
  { id: "r3", h: "h-4", mini: "h-1.5", delay: "[animation-delay:0ms]", soft: "[animation-delay:480ms]" }
] as const;

export function StatusVisual({
  status,
  recording,
  visualizerActive,
  canvasRef,
  size = "hero"
}: {
  status: StatusView;
  recording: boolean;
  visualizerActive: boolean;
  // Undefined on an off-screen pager page — only the active page wires the live recording canvas.
  canvasRef?: RefObject<HTMLCanvasElement | null>;
  // "hero" = the big central visual; "mini" = the compact version in the condensed header bar.
  size?: "hero" | "mini";
}) {
  const { dataState, key } = status;
  const mini = size === "mini";
  const dots = !recording && (key === "connecting" || key === "waiting");
  const speaking = dataState === "speaking";
  const working = dataState === "working" || dataState === "sending";
  const ready = dataState === "ready";
  const active = working || speaking; // strong equalizer animation
  // Colour by state: violet = speaking, green = connected/ready (waiting for you),
  // coral = working/sending (and the calm fallback for any other state).
  const tone = speaking ? "bg-violet" : ready ? "bg-success" : "bg-coral";
  // The hero paints the live mic waveform into a canvas while recording; the mini bar has no canvas and
  // shows the (red) equalizer for recording instead. So: hero → equalizer unless recording; mini →
  // equalizer for everything that isn't the travelling dots.
  const showCanvas = !mini;
  const showEqualizer = !dots && (mini || !recording);

  return (
    <div
      className={cn("relative grid place-items-center *:col-start-1 *:row-start-1", mini ? "h-7 w-16" : "h-20 w-full")}
      aria-hidden="true"
    >
      {/* Soft aura that warms up as things get busier (hero only). */}
      {!mini && (
        <div
          className={cn(
            "size-24 rounded-full blur-2xl transition-opacity duration-500",
            speaking ? "bg-violet/15" : ready ? "bg-success/12" : "bg-coral/15",
            recording || active ? "opacity-100" : ready ? "opacity-70" : "opacity-40"
          )}
        />
      )}

      {/* Recording → the real mic waveform (hero only; the mini bar shows the equalizer instead). */}
      {showCanvas && (
        <canvas
          ref={canvasRef}
          className={cn("h-14 w-60 transition-opacity duration-200", visualizerActive ? "opacity-100" : "opacity-0")}
        />
      )}

      {/* Connecting / waiting → three travelling dots. */}
      {dots && (
        <div className={cn("flex items-center", mini ? "gap-1.5" : "gap-2.5")}>
          <span className={cn("animate-dot-bounce rounded-full bg-coral", mini ? "size-2" : "size-3")} />
          <span
            className={cn(
              "animate-dot-bounce rounded-full bg-coral [animation-delay:0.18s]",
              mini ? "size-2" : "size-3"
            )}
          />
          <span
            className={cn(
              "animate-dot-bounce rounded-full bg-coral [animation-delay:0.36s]",
              mini ? "size-2" : "size-3"
            )}
          />
        </div>
      )}

      {/* Otherwise → the equalizer: strong while working/speaking, a gentle green
          breathe while ready (waiting for you to speak), calm/dim at rest. The mini bar
          also uses it for recording (no live canvas there). */}
      {showEqualizer && (
        <div className={cn("flex items-end", mini ? "gap-1" : "gap-2")}>
          {BARS.map((bar) => (
            <span
              key={bar.id}
              className={cn(
                "origin-center rounded-full",
                mini ? "w-1" : "w-2",
                mini ? bar.mini : bar.h,
                recording && mini ? "bg-danger" : tone,
                active || (recording && mini)
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
