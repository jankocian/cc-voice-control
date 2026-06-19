import { formatClock } from "@/hooks/useElapsed";
import type { StatusView } from "@/lib/status";

// The status block under the orb: a large title, a detail line, and a per-state
// indicator — green dot (ready), animated progress dots (connecting/waiting/
// sending), or the elapsed mm:ss timer (working).
export function StatusIndicator({ status, elapsed }: { status: StatusView; elapsed: number }) {
  const { dataState, key, title, detail } = status;
  const showDots = key === "connecting" || key === "waiting" || dataState === "sending";
  const showTimer = dataState === "working";

  return (
    <div className="flex animate-rise flex-col items-center gap-2 text-center">
      {showTimer ? (
        <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight text-ink">
          {formatClock(elapsed)}
        </span>
      ) : (
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      )}

      <div className="flex items-center gap-2 text-[15px] text-ink-soft">
        {showTimer && <span className="font-semibold text-ink">{title}</span>}
        <span className="truncate">{detail}</span>
      </div>

      {/* Indicator row */}
      <div className="mt-0.5 h-3">
        {dataState === "ready" && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-success">
            <span className="size-2 rounded-full bg-success" />
          </span>
        )}
        {showDots && <ProgressDots />}
      </div>
    </div>
  );
}

function ProgressDots() {
  // Fixed stagger via arbitrary-value utilities (build-time classes, no inline style).
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      <span className="size-1.5 animate-dot-bounce rounded-full bg-coral" />
      <span className="size-1.5 animate-dot-bounce rounded-full bg-coral [animation-delay:0.18s]" />
      <span className="size-1.5 animate-dot-bounce rounded-full bg-coral [animation-delay:0.36s]" />
    </span>
  );
}
