import { formatClock } from "@/hooks/useElapsed";
import type { StatusView } from "@/lib/status";
import { cn } from "@/lib/utils";

// The hero readout. The animated <StatusVisual> now carries the state by itself, so
// this is intentionally quiet:
//   • working                 → the elapsed mm:ss timer (the one bit of real data)
//   • a transient flash, or a state that needs the user (connecting / waiting for
//     the daemon / not listening) → a small toast-style message
//   • idle / recording / speaking with nothing to flag → renders nothing
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
  // "offline" groups connecting / waiting-for-daemon / not-listening — i.e. states
  // where the user can't talk yet and should be told why.
  const attention = dataState === "offline";
  const message = flash ?? (attention ? title : null);
  // Amber when there's an action for the user (daemon down / not listening); neutral
  // for transient flashes and the brief connecting handshake.
  const alert = key === "waiting" || key === "not-listening";

  if (!showTimer && !message) return null;

  return (
    <div className="flex animate-rise flex-col items-center gap-2 text-center">
      {message && (
        <span
          className={cn(
            "max-w-[20rem] truncate rounded-full px-3.5 py-1.5 text-xs font-medium shadow-soft backdrop-blur-md",
            alert ? "bg-warning/12 text-warning" : "bg-surface/90 text-ink-soft"
          )}
        >
          {message}
        </span>
      )}

      {showTimer && (
        <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight text-ink">
          {formatClock(elapsed)}
        </span>
      )}
    </div>
  );
}
