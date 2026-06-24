import { Loader2, Pause, Play, RotateCcw } from "lucide-react";
import { renderMarkdown } from "@/lib/markdown";

// A "step": Claude's interim narration before a tool call. Compact + dim, whole-row
// clickable to synthesize + play. Shows a spinner while audio is in flight, a retry
// icon when synthesis failed, pause while playing.
export function StepRow({
  body,
  playing,
  loading,
  failed,
  onPlay
}: {
  body: string;
  playing: boolean;
  loading?: boolean;
  failed?: boolean;
  onPlay: () => void;
}) {
  const label = loading ? "Loading step audio" : playing ? "Pause step" : failed ? "Retry step" : "Play step";

  return (
    <button
      type="button"
      onClick={onPlay}
      aria-label={label}
      className="flex w-full items-start gap-2 rounded-lg px-1 py-0.5 text-left text-ink-faint transition-colors hover:bg-violet/5 active:bg-violet/10"
    >
      <span className="mt-1 grid size-5 shrink-0 place-items-center rounded-full text-ink-faint/80">
        {loading ? (
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        ) : playing ? (
          <Pause className="size-3 fill-current" aria-hidden="true" />
        ) : failed ? (
          <RotateCcw className="size-3" aria-hidden="true" />
        ) : (
          <Play className="size-3 translate-x-px fill-current" aria-hidden="true" />
        )}
      </span>
      {/* min-w-0 lets the flex child shrink so long unbreakable strings wrap instead of overflow */}
      <p
        className={`min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] py-0.5 text-[13px] italic leading-relaxed ${failed ? "text-danger/70" : ""}`}
      >
        {renderMarkdown(body)}
      </p>
    </button>
  );
}
