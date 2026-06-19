import { cn } from "@/lib/utils";

// The hero "orb": a soft liquid orange→violet gradient blob that morphs per state.
// Tokenized CSS gradient (no WebGL) so the SPA stays lean for cellular and clears
// the strict CSP. Visual reference is ElevenLabs UI's Orb; the look/states match.
//
// States mirror the status machine:
//   idle      → calm slow morph + drift
//   listening → glowing coral ring, faster pulse
//   working   → glowing violet ring, steady pulse
//   speaking  → gentle pulse, warm aura
//   connecting→ dimmer, calm (still "alive")
export type OrbState = "idle" | "listening" | "working" | "speaking" | "connecting";

const RING_BY_STATE: Record<OrbState, string> = {
  idle: "opacity-0",
  connecting: "opacity-0",
  listening: "opacity-100 ring-coral/45 animate-orb-pulse",
  working: "opacity-100 ring-violet/45 animate-orb-pulse",
  speaking: "opacity-100 ring-coral/30"
};

export function Orb({ state = "idle", className }: { state?: OrbState; className?: string }) {
  const dimmed = state === "connecting";
  return (
    <div className={cn("relative isolate grid place-items-center", className)} aria-hidden="true">
      {/* Outer soft aura */}
      <div
        className={cn(
          "absolute inset-0 rounded-full bg-orb-glow/55 blur-2xl transition-opacity duration-700",
          dimmed ? "opacity-30" : "opacity-70"
        )}
      />

      {/* Glowing state ring (listening / working / speaking) */}
      <div
        className={cn(
          "absolute size-[78%] rounded-full ring-8 blur-[2px] transition-opacity duration-500",
          RING_BY_STATE[state]
        )}
      />

      {/* The liquid blob itself */}
      <div
        className={cn(
          "relative size-[72%] animate-orb-morph animate-orb-drift bg-gradient-to-br from-orb-warm via-orb-mid to-orb-cool shadow-orb transition-[filter] duration-700",
          dimmed && "saturate-[0.8] brightness-105"
        )}
      >
        {/* Inner light wash for a glassy liquid sheen */}
        <div className="absolute inset-0 rounded-[inherit] bg-gradient-to-t from-transparent via-white/10 to-white/45 mix-blend-soft-light" />
        {/* Bright specular highlight, top-left */}
        <div className="absolute left-[18%] top-[14%] size-[34%] rounded-full bg-white/60 blur-xl" />
      </div>

      {/* Floating accent dots */}
      <span className="absolute left-[8%] top-[26%] size-2 animate-float-slow rounded-full bg-coral/70 blur-[0.5px]" />
      <span className="absolute right-[12%] top-[18%] size-1.5 animate-float-slow rounded-full bg-violet/70 [animation-delay:1.5s]" />
      <span className="absolute right-[16%] bottom-[22%] size-2.5 animate-float-slow rounded-full bg-coral-soft [animation-delay:0.8s]" />
      <span className="absolute left-[16%] bottom-[16%] size-1.5 animate-float-slow rounded-full bg-violet-soft [animation-delay:2.2s]" />
    </div>
  );
}
