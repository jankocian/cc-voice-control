import { Hand, Mic, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatClock } from "@/hooks/useElapsed";
import type { StatusView } from "@/lib/status";
import { cn } from "@/lib/utils";

// A condensed, sticky version of the hero controls. It slides in at the top of the
// scroll area once the full hero scrolls out of view (App drives `shown`), so the
// mic / stop / cancel stay reachable while reading the message history below.
//
// Mirrors <Controls>'s state logic in a single compact row:
//   idle / speaking → mic
//   working         → Interrupt · Stop · Mic (steer)
//   recording       → Cancel · Stop-square (send)
export function MiniControls({
  status,
  elapsed,
  working,
  recording,
  shown,
  onMic,
  onSteer,
  onInterrupt,
  onStopRecording,
  onCancel,
  onStopTask
}: {
  status: StatusView;
  elapsed: number;
  working: boolean;
  recording: boolean;
  shown: boolean;
  onMic: () => void;
  onSteer: () => void;
  onInterrupt: () => void;
  onStopRecording: () => void;
  onCancel: () => void;
  onStopTask: () => void;
}) {
  const { dataState, title } = status;
  const busy = recording || working || dataState === "speaking" || dataState === "sending";
  const dotTone =
    dataState === "recording"
      ? "bg-danger"
      : dataState === "speaking"
        ? "bg-violet"
        : working || dataState === "sending"
          ? "bg-coral"
          : dataState === "ready"
            ? "bg-success"
            : "bg-ink-faint";

  return (
    <div
      className={cn(
        "absolute inset-x-0 top-0 z-20 transition-[transform,opacity] duration-300 ease-soft",
        shown ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-full opacity-0"
      )}
    >
      <div className="flex items-center gap-3 border-b border-hairline bg-canvas/85 px-4 py-2.5 shadow-soft backdrop-blur-md">
        {/* Status */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn("size-2.5 shrink-0 rounded-full", dotTone, busy && "animate-pulse-ring")}
            aria-hidden="true"
          />
          <span className="truncate text-sm font-semibold text-ink">{title}</span>
          {working && (
            <span className="shrink-0 font-mono text-sm tabular-nums text-ink-soft">{formatClock(elapsed)}</span>
          )}
        </div>

        {/* Actions — same set as the full cluster, compacted. */}
        <div className="flex shrink-0 items-center gap-2">
          {recording ? (
            <>
              <Button variant="surface" size="iconSm" onClick={onCancel} aria-label="Cancel recording">
                <X />
              </Button>
              <Button
                variant="danger"
                size="icon"
                onClick={onStopRecording}
                aria-label="Stop and send"
                className="rounded-control"
              >
                <Square className="fill-current" />
              </Button>
            </>
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
              <Button variant="coral" size="icon" onClick={onSteer} aria-label="Steer the agent">
                <Mic />
              </Button>
            </>
          ) : (
            <Button variant="coral" size="icon" onClick={onMic} aria-label="Tap to speak">
              <Mic />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
