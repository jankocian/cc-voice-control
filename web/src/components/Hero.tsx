import type { RefObject } from "react";
import { Controls } from "@/components/Controls";
import { StatusIndicator } from "@/components/StatusIndicator";
import { StatusVisual } from "@/components/StatusVisual";
import type { StatusView } from "@/lib/status";

// The hero: a soft gradient card holding the state visual (waveform / equalizer /
// dots), the status block, and the one control cluster (mic when idle/working,
// stop-square while recording — see <Controls>).
export function Hero({
  status,
  elapsed,
  recording,
  visualizerActive,
  canvasRef,
  speedLabel,
  onCycleSpeed,
  onMic,
  onSteer,
  onInterrupt,
  onStopRecording,
  onCancel,
  onStopTask
}: {
  status: StatusView;
  elapsed: number;
  recording: boolean;
  visualizerActive: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  speedLabel: string;
  onCycleSpeed: () => void;
  onMic: () => void;
  onSteer: () => void;
  onInterrupt: () => void;
  onStopRecording: () => void;
  onCancel: () => void;
  onStopTask: () => void;
}) {
  // `working` is the non-recording working state; while recording, the status
  // machine reports "recording" (priority), so the cluster shows the record UI.
  const working = status.dataState === "working";

  return (
    <section className="relative flex shrink-0 flex-col items-center gap-6 rounded-b-card bg-gradient-to-b from-canvas-deep/70 to-canvas px-5 pb-7 pt-3">
      <StatusVisual status={status} recording={recording} visualizerActive={visualizerActive} canvasRef={canvasRef} />

      <StatusIndicator status={status} elapsed={elapsed} />

      <div className="w-full max-w-sm pt-1">
        <Controls
          working={working}
          recording={recording}
          speedLabel={speedLabel}
          onCycleSpeed={onCycleSpeed}
          onMic={onMic}
          onSteer={onSteer}
          onInterrupt={onInterrupt}
          onStopRecording={onStopRecording}
          onCancel={onCancel}
          onStopTask={onStopTask}
        />
      </div>
    </section>
  );
}
