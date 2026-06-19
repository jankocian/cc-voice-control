import { formatClock } from "@/hooks/useElapsed";
import type { StatusView } from "@/lib/status";

// The status block under the visual: a large title (or the elapsed mm:ss timer
// while working) plus an optional one-line detail. The animated state indicator
// lives in <StatusVisual>; this block is text only.
export function StatusIndicator({ status, elapsed }: { status: StatusView; elapsed: number }) {
  const { dataState, title, detail } = status;
  const showTimer = dataState === "working";

  return (
    <div className="flex animate-rise flex-col items-center gap-1.5 text-center">
      {showTimer ? (
        <span className="font-mono text-3xl font-semibold tabular-nums tracking-tight text-ink">
          {formatClock(elapsed)}
        </span>
      ) : (
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      )}

      <div className="flex min-h-[1.25rem] items-center gap-2 text-[15px] text-ink-soft">
        {showTimer && <span className="font-semibold text-ink">{title}</span>}
        {detail && <span className="max-w-[18rem] truncate">{detail}</span>}
      </div>
    </div>
  );
}
