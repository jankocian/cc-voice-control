import { Hand, Mic, Square, X } from "lucide-react";
import { StatusVisual } from "@/components/StatusVisual";
import { Button } from "@/components/ui/button";
import { formatClock } from "@/hooks/useElapsed";
import type { StatusView } from "@/lib/status";
import { cn } from "@/lib/utils";

// The condensed control bar. It REPLACES the nav bar in the same header slot once the full hero scrolls
// out of view (App drives `shown`) — slides in as the <TopBar> slides out — so the mic / stop / cancel
// stay reachable while reading the message history, with maximum room for content.
//
// Layout mirrors the nav it replaces: a small live visualizer on the left (where the wordmark was) and
// the state's action cluster aligned right. Only the chat controls live here — no settings gear; while
// reading the thread, the mic / stop / cancel are all that's wanted.
//
// Mirrors <Controls>'s state logic, compacted to iconSm:
//   idle / speaking → mic
//   working         → Interrupt · Stop · Mic (steer)
//   recording       → Cancel · Stop-square (send)
export function MiniControls({
  status,
  elapsed,
  working,
  recording,
  shown,
  flash,
  flashAlert = false,
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
  flash?: string | null;
  // A red "alert" flash mirrored from the hero, so it's visible while the hero is scrolled away.
  flashAlert?: boolean;
  onMic: () => void;
  onSteer: () => void;
  onInterrupt: () => void;
  onStopRecording: () => void;
  onCancel: () => void;
  onStopTask: () => void;
}) {
  const { dataState } = status;
  const alertFlash = flashAlert && flash ? flash : null;

  return (
    <div
      className={cn(
        "absolute inset-0 transition-[transform,opacity] duration-300 ease-soft",
        shown ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-full opacity-0"
      )}
    >
      <div className="flex h-full items-center gap-3 border-b border-hairline/60 bg-surface/70 px-4 backdrop-blur-md">
        {/* Left: a small live visualizer (the hero's animation, compact) + an alert/working readout. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <StatusVisual status={status} recording={recording} visualizerActive={recording} size="mini" />
          {alertFlash ? (
            <span className="truncate text-sm font-semibold text-danger">{alertFlash}</span>
          ) : working ? (
            <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-ink">
              {formatClock(elapsed)}
            </span>
          ) : (
            dataState === "offline" && <span className="truncate text-sm font-semibold text-ink">{status.title}</span>
          )}
        </div>

        {/* Actions — same set as the full cluster, all iconSm. */}
        <div className="flex shrink-0 items-center gap-2">
          {recording ? (
            <>
              <Button variant="surface" size="iconSm" onClick={onCancel} aria-label="Cancel recording">
                <X />
              </Button>
              <Button
                variant="danger"
                size="iconSm"
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
              <Button variant="coral" size="iconSm" onClick={onSteer} aria-label="Steer the agent">
                <Mic />
              </Button>
            </>
          ) : (
            <Button variant="coral" size="iconSm" onClick={onMic} aria-label="Tap to speak">
              <Mic />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
