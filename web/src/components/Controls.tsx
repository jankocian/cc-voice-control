import { Hand, Mic, Square, X } from "lucide-react";
import { SpeedPill } from "@/components/SpeedPill";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The one control cluster for every state, so idle / recording / working all share
// the same skeleton (speed pill pinned left · big center FAB · secondary controls
// right · one label below). Only the center FAB's action and the right slot change:
//
//   idle      → mic (speak)                      · right: —
//   working   → mic (steer/queue a message)      · right: Interrupt · Stop
//   recording → red stop-square (stop + send)    · right: Cancel
//
// Because the layout never reshuffles, the speed pill stays put and the working
// controls read as a sibling of the default mic cluster instead of a different UI.
export function Controls({
  working,
  recording,
  speedLabel,
  onCycleSpeed,
  onMic,
  onSteer,
  onInterrupt,
  onStopRecording,
  onCancel,
  onStopTask
}: {
  working: boolean;
  recording: boolean;
  speedLabel: string;
  onCycleSpeed: () => void;
  onMic: () => void;
  onSteer: () => void;
  onInterrupt: () => void;
  onStopRecording: () => void;
  onCancel: () => void;
  onStopTask: () => void;
}) {
  const centerAction = recording ? onStopRecording : working ? onSteer : onMic;
  const centerLabel = recording ? "Stop and send" : working ? "Steer the agent" : "Tap to speak";
  const caption = recording ? "Tap to send · ✕ to cancel" : working ? "Tap to steer" : "Tap to speak";

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="grid w-full max-w-xs grid-cols-[1fr_auto_1fr] items-center">
        {/* Left: speed pill — same slot in every state, so it never jumps. */}
        <div className="flex justify-start">
          <SpeedPill label={speedLabel} onClick={onCycleSpeed} />
        </div>

        {/* Center: the big mic / stop FAB with a soft halo. */}
        <div className="relative grid place-items-center">
          <span
            className={cn(
              "pointer-events-none absolute size-[92px] rounded-full transition-opacity duration-300",
              recording ? "animate-pulse-ring bg-danger/15" : "bg-coral/12"
            )}
            aria-hidden="true"
          />
          <Button
            variant={recording ? "danger" : "coral"}
            size="fab"
            onClick={centerAction}
            aria-label={centerLabel}
            className={cn(recording && "rounded-card")}
          >
            {recording ? <Square className="fill-current" /> : <Mic />}
          </Button>
        </div>

        {/* Right: contextual secondary controls — same slot, never moves the pill. */}
        <div className="flex items-center justify-end gap-2">
          {recording ? (
            <Button variant="surface" size="icon" onClick={onCancel} aria-label="Cancel recording">
              <X />
            </Button>
          ) : working ? (
            <>
              <Button variant="surface" size="iconSm" onClick={onInterrupt} aria-label="Interrupt and speak now">
                <Hand />
              </Button>
              <Button
                variant="danger"
                size="iconSm"
                onClick={onStopTask}
                aria-label="Stop the running task"
                className="rounded-control"
              >
                <Square className="fill-current" />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <p className="text-xs font-medium tracking-wide text-ink-faint">{caption}</p>
    </div>
  );
}
