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
  const { dataState, key, title, detail } = status;
  const showTimer = dataState === "working";
  // "offline" groups connecting / waiting-for-daemon / not-listening — i.e. states
  // where the user can't talk yet and should be told why.
  const attention = dataState === "offline";
  // Ready/connected gets a steady "all good" badge too — not just transient flashes
  // and attention states — so the green-wave hero always has a matching readout.
  const ready = key === "ready";
  // The in-progress states (transcribing the clip → the agent working) surface their
  // title too, so "loading" is never silent. Without it those states showed only a
  // bare equalizer/timer that read as idle — the turn looked done while Claude was just
  // starting. Recording/speaking stay text-free (the mic UI / playing audio is obvious).
  const busy = dataState === "sending" || dataState === "working";
  const message = flash ?? (attention || busy ? title : ready ? `${title} · ${detail}` : null);
  // Amber when there's an action for the user (daemon down / not listening); neutral
  // white for transient flashes and the steady ready badge.
  const alert = key === "waiting" || key === "not-listening";
  // A small live dot turns the neutral white pill into a clear "connected" indicator
  // (only for the steady ready state, never over a transient flash).
  const showDot = ready && !flash;

  if (!showTimer && !message) return null;

  return (
    <div className="flex animate-rise flex-col items-center gap-2 text-center">
      {message && (
        <span
          className={cn(
            "inline-flex max-w-[20rem] items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium shadow-soft backdrop-blur-md",
            alert ? "bg-warning/12 text-warning" : "bg-surface/90 text-ink-soft"
          )}
        >
          {showDot && <span className="size-1.5 shrink-0 rounded-full bg-success" />}
          <span className="truncate">{message}</span>
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
