import { lazy, Suspense, useEffect, useState } from "react";
import type { AgentState } from "@/components/ui/orb";
import { cn } from "@/lib/utils";

// The hero orb: ElevenLabs UI's WebGL Orb (three.js / react-three-fiber), driven by
// the session state. three.js is heavy, so the orb is lazy-loaded as its own chunk
// (the shell paints first). Its gradient colours are read from the design tokens so
// the shader and the rest of the UI share a single source of truth.
const WebglOrb = lazy(() => import("@/components/ui/orb").then((m) => ({ default: m.Orb })));

export type OrbState = "idle" | "listening" | "working" | "speaking" | "connecting";

const AGENT_STATE: Record<OrbState, AgentState> = {
  idle: null,
  connecting: null,
  listening: "listening",
  working: "thinking",
  speaking: "talking"
};

// Resolve the orb gradient stops from the CSS design tokens (the shader needs
// concrete colours; this keeps them in lockstep with --color-orb-*).
function useTokenColors(): [string, string] | null {
  const [colors, setColors] = useState<[string, string] | null>(null);
  useEffect(() => {
    const root = getComputedStyle(document.documentElement);
    const warm = root.getPropertyValue("--color-orb-warm").trim();
    const cool = root.getPropertyValue("--color-orb-cool").trim();
    if (warm && cool) setColors([warm, cool]);
  }, []);
  return colors;
}

export function Orb({ state = "idle", className }: { state?: OrbState; className?: string }) {
  const colors = useTokenColors();

  return (
    <div className={cn("relative isolate grid place-items-center", className)} aria-hidden="true">
      {/* Soft aura behind the orb. */}
      <div
        className={cn(
          "absolute inset-0 rounded-full bg-orb-glow/55 blur-2xl transition-opacity duration-700",
          state === "connecting" ? "opacity-30" : "opacity-60"
        )}
      />

      {/* The real WebGL orb, centered and filling the square (mounts once colours
          are resolved from tokens). No overlaid CSS dots — the orb stands alone. */}
      {colors && (
        <Suspense fallback={null}>
          <WebglOrb
            colors={colors}
            agentState={AGENT_STATE[state]}
            volumeMode="manual"
            manualInput={0}
            manualOutput={0}
            className="absolute inset-0 size-full"
          />
        </Suspense>
      )}
    </div>
  );
}
