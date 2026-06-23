import type { RefObject } from "react";
import type { StatusView } from "@/lib/status";
import { cn } from "@/lib/utils";

// The hero's central state visual — replaces the (removed) WebGL orb. It actually
// reflects what's happening, reusing the same language as the controls:
//   • recording          → the live mic waveform (painted into the canvas)
//   • connecting/waiting  → three travelling dots
//   • working / sending   → an animated equalizer (coral)
//   • speaking            → an animated equalizer (violet)
//   • awaiting            → the "your turn" dot-wave, amber (Claude needs you: a question/permission)
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
  const connectingDots = !recording && (key === "connecting" || key === "waiting");
  const speaking = dataState === "speaking";
  const working = dataState === "working" || dataState === "sending";
  const ready = dataState === "ready";
  // "Claude needs you" (a question/permission waiting). Reuses the "your turn" dot-wave below, amber-toned
  // — semantically a your-turn moment, distinct from ready (green) and working (coral).
  const awaiting = dataState === "awaiting";
  const active = working || speaking; // strong equalizer animation
  // Colour by state: violet = speaking, green = connected/ready (waiting for you), amber = needs you,
  // coral = working/sending (and the calm fallback for any other state).
  const tone = speaking ? "bg-violet" : ready ? "bg-success" : awaiting ? "bg-warning" : "bg-coral";
  // The hero paints the live mic waveform into a canvas while recording; the mini bar has no canvas and
  // shows the (red) equalizer for recording instead. So: hero → equalizer unless recording; mini →
  // equalizer for everything that isn't the travelling dots.
  const showCanvas = !mini;
  const showEqualizer = !connectingDots && (mini || !recording);
  // "Ready / your turn" reuses the SAME equalizer elements but collapses them to uniform dots doing a
  // staggered appear-wave (awaiting input) instead of the breathing bars — so the row visibly morphs
  // bars↔dots as Claude goes idle/active. "Claude needs you" is also a your-turn moment (amber via `tone`).
  const readyDots = (ready || awaiting) && !recording;

  return (
    <div
      className={cn("relative grid place-items-center *:col-start-1 *:row-start-1", mini ? "h-7 w-16" : "h-20 w-full")}
      aria-hidden="true"
    >
      {/* Soft aura that warms up as things get busier (hero only). A wide elliptical RADIAL GRADIENT, not a
          blurred circle: iOS Safari's blur() filter region is rectangular, so a blurred fill shows a faint
          SQUARE halo in dark mode. A gradient has no filter region → a clean glow everywhere, and spanning
          the full width (fading top/bottom/sides) keeps the same airy look without any clip. currentColor
          (set by text-*) tones it; opacity sets intensity. */}
      {!mini && (
        <div
          className={cn(
            "h-28 w-64 bg-[radial-gradient(ellipse_at_center,currentColor,transparent_65%)] transition-opacity duration-500",
            speaking ? "text-violet" : ready ? "text-success" : awaiting ? "text-warning" : "text-coral",
            recording || active ? "opacity-[0.12]" : ready || awaiting ? "opacity-[0.08]" : "opacity-[0.05]"
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
      {connectingDots && (
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

      {/* The equalizer — the SAME 7 elements across states. Strong bar-pulse while working/speaking; while
          READY they collapse to uniform dots doing a staggered appear-wave ("your turn — tap to speak");
          calm/dim at rest. The mini bar also uses it for recording (no live canvas there). `items-center`
          so the dots sit centred (bars are bottom-aligned by their own height). */}
      {showEqualizer && (
        <div className={cn("flex", readyDots ? "items-center" : "items-end", mini ? "gap-1" : "gap-2")}>
          {BARS.map((bar) => (
            <span
              key={bar.id}
              className={cn(
                "origin-center rounded-full",
                mini ? "w-1" : "w-2",
                // Ready → a uniform dot (square w/h, fully round); otherwise the bar's own height.
                readyDots ? (mini ? "h-1" : "h-2") : mini ? bar.mini : bar.h,
                recording && mini ? "bg-danger" : tone,
                active || (recording && mini)
                  ? cn("animate-bar", bar.delay)
                  : readyDots
                    ? cn("animate-dot-wave", bar.soft)
                    : "scale-y-[0.35] opacity-50"
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}
