import { Check, CircleHelp, Pause, Play } from "lucide-react";
import { isVoiceAnswerable, type QuestionPayload } from "@/lib/protocol";
import { cn } from "@/lib/utils";

// Claude's interactive AskUserQuestion, shown as a card: the question(s) + lettered options so you know what
// to say. You answer by VOICE — the spoken transcript becomes the picker's custom answer (no tap-to-select,
// by design). The play button re-hears the read-aloud question; once answered the card dims with a check.
export function QuestionCard({
  question,
  playing,
  onPlay
}: {
  question: QuestionPayload;
  playing: boolean;
  onPlay: () => void;
}) {
  const { questions, answered } = question;
  // A spoken answer can only drive a single single-select question (the daemon routes multi-part/multi-select
  // to the terminal), so the card's hint must match — same predicate as the daemon, shared so they can't drift.
  const terminalOnly = !isVoiceAnswerable(question);
  return (
    <div className={cn("flex w-full flex-col items-start", answered && "opacity-60")}>
      <div className="max-w-[88%] rounded-bubble border border-violet/30 bg-violet-soft/60 px-4 py-3 shadow-soft">
        <div className="mb-2 flex items-center gap-2">
          {answered ? (
            <Check className="size-4 text-violet-ink" aria-hidden="true" />
          ) : (
            <CircleHelp className="size-4 text-violet-ink" aria-hidden="true" />
          )}
          <span className="text-xs font-semibold uppercase tracking-wide text-violet-ink">
            {answered ? "Answered" : "Claude is asking"}
          </span>
          <button
            type="button"
            onClick={onPlay}
            aria-label={playing ? "Pause question" : "Hear question"}
            className="ml-auto grid size-6 place-items-center rounded-full text-violet-ink/80 transition-colors hover:bg-violet/15 hover:text-violet-ink"
          >
            {playing ? (
              <Pause className="size-3.5 fill-current" />
            ) : (
              <Play className="size-3.5 translate-x-px fill-current" />
            )}
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {/* Key by content, not the array index: biome's noArrayIndexKey forbids index keys, and a
              question's options/sub-questions are distinct, so label/question text is a stable unique key. */}
          {questions.map((q) => (
            <div key={q.question} className="flex flex-col gap-1.5">
              {q.header && <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{q.header}</p>}
              <p className="text-[15px] font-medium leading-snug text-ink">{q.question}</p>
              <ol className="mt-0.5 flex flex-col gap-1">
                {q.options.map((o, oi) => (
                  <li key={o.label} className="flex gap-2 text-[14px] leading-snug text-ink">
                    <span className="font-semibold text-violet-ink">{String.fromCharCode(65 + oi)}</span>
                    <span>
                      {o.label}
                      {o.description && <span className="text-ink-faint"> — {o.description}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>

        {!answered && (
          <p className="mt-3 text-[12px] text-ink-faint">
            {terminalOnly ? "Answer this one in the terminal." : "Tap the mic and say your answer."}
          </p>
        )}
      </div>
    </div>
  );
}
