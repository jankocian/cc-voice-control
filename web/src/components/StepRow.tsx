import { Pause, Play } from "lucide-react";

// A "step": Claude's interim narration before a tool call ("I'll read the file first…"). Compact + dim,
// with a tiny tap-to-play that synthesizes the line on demand — reassurance during a long turn, not part of
// the conversation proper, so it's deliberately quieter than a reply bubble.
export function StepRow({ body, playing, onPlay }: { body: string; playing: boolean; onPlay: () => void }) {
  return (
    <div className="-my-1.5 flex items-start gap-2 px-1 text-ink-faint">
      <button
        type="button"
        onClick={onPlay}
        aria-label={playing ? "Pause step" : "Play step"}
        className="mt-px grid size-5 shrink-0 place-items-center rounded-full text-ink-faint/80 transition-colors hover:bg-violet/10 hover:text-violet-ink"
      >
        {playing ? <Pause className="size-3 fill-current" /> : <Play className="size-3 translate-x-px fill-current" />}
      </button>
      <p className="whitespace-pre-wrap break-words text-[13px] italic leading-snug">{body}</p>
    </div>
  );
}
