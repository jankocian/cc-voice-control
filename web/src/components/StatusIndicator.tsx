import { formatClock } from "@/hooks/useElapsed";
import type { StatusView } from "@/lib/status";
import { cn } from "@/lib/utils";

// The hero readout. The pill is ALWAYS present (one line, every state) so the hero keeps a
// constant height and the layout never jumps as the state changes:
//   • ready                    → "Connected" (green dot)
//   • recording / speaking / sending / working → the state title (state-toned dot)
//   • working                  → also the elapsed mm:ss timer (the one bit of real data)
//   • connecting / waiting / offline / not-listening → why the user can't talk yet
//   • a transient flash overrides the label while active.
export function StatusIndicator({
  status,
  elapsed,
  flash,
  flashAlert = false
}: {
  status: StatusView;
  elapsed: number;
  flash: string | null;
  // An "alert" flash (e.g. spawning from a disconnected thread) — render the pill red so it's noticed.
  flashAlert?: boolean;
}) {
  const { dataState, key, title } = status;
  // The working elapsed time lives INSIDE the pill ("Agent is working · 0:42"), not as a separate big
  // number — one constant-height line, so the hero never shifts as the timer appears/ticks. (elapsed is 0
  // on inactive pager slides, where we don't have that thread's running clock — then just the title shows.)
  const ready = key === "ready";
  const label = dataState === "working" && elapsed > 0 ? `${title} · ${formatClock(elapsed)}` : title;
  const message = flash ?? label;
  // Red for an alert flash (an action the user must notice). Amber for the steady attention states
  // (daemon down / not listening / Claude needs you). Neutral white otherwise.
  const danger = flash !== null && flashAlert;
  const alert = !danger && (key === "waiting" || key === "not-listening" || key === "awaiting");
  // A small state-toned dot makes the steady pill read as a live indicator (never over a flash,
  // and not for the attention states — their amber/neutral copy already carries the meaning).
  const dotTone = ready
    ? "bg-success"
    : dataState === "recording"
      ? "bg-danger"
      : dataState === "speaking"
        ? "bg-violet"
        : dataState === "sending" || dataState === "working"
          ? "bg-coral"
          : null;
  const showDot = !flash && dotTone !== null;

  return (
    <div className="flex animate-rise flex-col items-center gap-2 text-center">
      <span
        className={cn(
          "inline-flex max-w-[20rem] items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium shadow-soft backdrop-blur-md",
          danger ? "bg-danger/15 text-danger" : alert ? "bg-warning/12 text-warning" : "bg-surface/90 text-ink-soft"
        )}
      >
        {showDot && <span className={cn("size-1.5 shrink-0 rounded-full", dotTone)} />}
        <span className="truncate tabular-nums">{message}</span>
      </span>
    </div>
  );
}
