import type { RefObject } from "react";
import { Orb, type OrbState } from "@/components/Orb";
import { StatusIndicator } from "@/components/StatusIndicator";
import { VoiceCluster } from "@/components/VoiceCluster";
import { WorkingControls } from "@/components/WorkingControls";
import type { StatusView } from "@/lib/status";

// Maps the status machine's dataState/key to the orb's visual state.
function orbStateFor(status: StatusView): OrbState {
  switch (status.dataState) {
    case "recording":
      return "listening";
    case "working":
    case "sending":
      return "working";
    case "speaking":
      return "speaking";
    case "ready":
      return "idle";
    default:
      return status.key === "connecting" || status.key === "waiting" ? "connecting" : "idle";
  }
}

// The hero: a soft gradient card holding the morphing orb, the status block, and
// the control cluster (mic cluster when idle/listening; Interrupt·Steer·Stop when
// the agent is working).
export function Hero({
  status,
  elapsed,
  recording,
  visualizerActive,
  canvasRef,
  speedLabel,
  onToggleRecord,
  onCycleSpeed,
  onInterrupt,
  onSteer,
  onStop
}: {
  status: StatusView;
  elapsed: number;
  recording: boolean;
  visualizerActive: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  speedLabel: string;
  onToggleRecord: () => void;
  onCycleSpeed: () => void;
  onInterrupt: () => void;
  onSteer: () => void;
  onStop: () => void;
}) {
  const working = status.dataState === "working";

  return (
    <section className="relative flex shrink-0 flex-col items-center gap-6 rounded-b-card bg-gradient-to-b from-canvas-deep/70 to-canvas px-5 pb-7 pt-2">
      <Orb state={orbStateFor(status)} className="size-44" />

      <StatusIndicator status={status} elapsed={elapsed} />

      <div className="w-full max-w-sm pt-1">
        {working ? (
          <WorkingControls
            speedLabel={speedLabel}
            onInterrupt={onInterrupt}
            onSteer={onSteer}
            onStop={onStop}
            onCycleSpeed={onCycleSpeed}
          />
        ) : (
          <VoiceCluster
            recording={recording}
            // Always tappable so a tap gives feedback even before a daemon attaches
            // (App.toggleRecording flashes "Not connected…"); matches the reference's
            // always-vibrant mic.
            disabled={false}
            visualizerActive={visualizerActive}
            canvasRef={canvasRef}
            speedLabel={speedLabel}
            onToggleRecord={onToggleRecord}
            onCycleSpeed={onCycleSpeed}
          />
        )}
      </div>
    </section>
  );
}
