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
  flash
}: {
  status: StatusView;
  elapsed: number;
  flash: string | null;
}) {
  const { dataState, key, title } = status;
  const showTimer = dataState === "working";
  // The title alone is the label for every state ("Connected", "Listening…", …); kept succinct, so the
  // pill is never empty — a pill that came and went is exactly what shifted the hero's layout.
  const ready = key === "ready";
  const message = flash ?? title;
  // Amber when there's an action for the user (daemon down / not listening); neutral
  // white for transient flashes and every steady state.
  const alert = key === "waiting" || key === "not-listening";
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
          alert ? "bg-warning/12 text-warning" : "bg-surface/90 text-ink-soft"
        )}
      >
        {showDot && <span className={cn("size-1.5 shrink-0 rounded-full", dotTone)} />}
        <span className="truncate">{message}</span>
      </span>

      {showTimer && (
        <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight text-ink">
          {formatClock(elapsed)}
        </span>
      )}
    </div>
  );
}
