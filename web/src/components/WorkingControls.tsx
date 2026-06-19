import { Hand, Square, Zap } from "lucide-react";
import { SpeedPill } from "@/components/SpeedPill";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Working state controls: a row of three — Interrupt · Steer · Stop (Stop is a red
// square) — over the speed pill. Replaces the mic cluster while the agent works.
export function WorkingControls({
  speedLabel,
  onInterrupt,
  onSteer,
  onStop,
  onCycleSpeed
}: {
  speedLabel: string;
  onInterrupt: () => void;
  onSteer: () => void;
  onStop: () => void;
  onCycleSpeed: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-end justify-center gap-7">
        <ControlButton label="Interrupt" onClick={onInterrupt}>
          <Button variant="surface" size="icon" aria-label="Interrupt" onClick={onInterrupt}>
            <Hand />
          </Button>
        </ControlButton>

        <ControlButton label="Steer" onClick={onSteer}>
          <Button variant="violet" size="icon" aria-label="Steer" onClick={onSteer}>
            <Zap />
          </Button>
        </ControlButton>

        <ControlButton label="Stop" onClick={onStop}>
          <Button
            variant="danger"
            size="icon"
            aria-label="Stop the running task"
            onClick={onStop}
            className="rounded-control"
          >
            <Square className="fill-current" />
          </Button>
        </ControlButton>
      </div>

      <SpeedPill label={speedLabel} onClick={onCycleSpeed} />
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  children
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      {children}
      <button
        type="button"
        onClick={onClick}
        className={cn("text-xs font-medium text-ink-soft transition-colors hover:text-ink")}
      >
        {label}
      </button>
    </div>
  );
}
