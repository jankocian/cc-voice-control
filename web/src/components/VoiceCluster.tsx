import { AudioLines, Mic, Square } from "lucide-react";
import type { RefObject } from "react";
import { SpeedPill } from "@/components/SpeedPill";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The voice cluster (idle + recording): speed pill (left), the big circular mic
// FAB (center) that becomes a red rounded STOP square while recording, and a
// small waveform/visualizer button (right). Label reads "Tap to speak" /
// "Tap to stop". The live mic waveform draws into `canvasRef` (useRecorder).
export function VoiceCluster({
  recording,
  disabled,
  visualizerActive,
  canvasRef,
  speedLabel,
  onToggleRecord,
  onCycleSpeed
}: {
  recording: boolean;
  disabled: boolean;
  visualizerActive: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  speedLabel: string;
  onToggleRecord: () => void;
  onCycleSpeed: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center">
        {/* Left: speed pill */}
        <div className="flex justify-start">
          <SpeedPill label={speedLabel} onClick={onCycleSpeed} />
        </div>

        {/* Center: mic / stop FAB with a soft halo */}
        <div className="relative grid place-items-center">
          <span
            className={cn(
              "pointer-events-none absolute size-[92px] rounded-full transition-opacity duration-300",
              recording ? "bg-danger/15 animate-orb-pulse" : "bg-coral/12"
            )}
            aria-hidden="true"
          />
          <Button
            variant={recording ? "danger" : "coral"}
            size="fab"
            disabled={disabled}
            onClick={onToggleRecord}
            aria-label={recording ? "Stop recording" : "Tap to speak"}
            className={cn(recording && "rounded-card")}
          >
            {recording ? <Square className="fill-current" /> : <Mic />}
          </Button>
        </div>

        {/* Right: waveform / visualizer button */}
        <div className="flex justify-end">
          <Button
            variant="surface"
            size="icon"
            aria-label="Voice visualizer"
            className={cn(recording && "text-coral")}
          >
            <AudioLines />
          </Button>
        </div>
      </div>

      {/* Live mic waveform (only painted while recording) */}
      <canvas
        ref={canvasRef}
        className={cn(
          "h-9 w-44 transition-opacity duration-200",
          visualizerActive ? "opacity-100" : "opacity-0"
        )}
        aria-hidden="true"
      />

      <p className="text-sm font-medium text-ink-soft">{recording ? "Tap to stop" : "Tap to speak"}</p>
    </div>
  );
}
