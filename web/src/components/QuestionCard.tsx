import { Check, ChevronLeft, CircleHelp, CircleSlash } from "lucide-react";
import { type AudioControls, MessageAudio } from "@/components/MessageAudio";
import type { Question, QuestionPayload } from "@/lib/protocol";
import { cn } from "@/lib/utils";

// Claude's interactive AskUserQuestion, shown as a SEQUENTIAL wizard: one sub-question at a time (read aloud
// with the same player as a message — play/scrub/replay), answered by VOICE (tap the mic, speak), then a
// final review + CONFIRM submits them all. Deliberately chrome-light and language-agnostic: the only words on
// screen are Claude's own question + options (already in the conversation's language); everything the wizard
// adds is an icon (progress dots, back, confirm). `requestId` keys the per-sub-question audio (`uuid#index`).
export function QuestionCard({
  question,
  requestId,
  live,
  controls,
  onConfirm,
  onRedo
}: {
  question: QuestionPayload;
  requestId: string;
  // True only on the active thread — gates the actionable controls (a background thread's card is static).
  live: boolean;
  controls: AudioControls;
  onConfirm: () => void;
  onRedo: () => void;
}) {
  const { questions, answered, aborted, answers = [] } = question;
  const total = questions.length;
  const idx = Math.min(answers.length, total); // current sub-question; === total at the review step

  // Already resolved (submitted or Esc'd in the terminal): a dimmed historical card, no controls.
  if (answered) {
    return (
      <Shell dim>
        <div className="mb-1.5 flex items-center gap-2">
          {aborted ? (
            <CircleSlash className="size-4 text-ink-faint" aria-hidden="true" />
          ) : (
            <Check className="size-4 text-violet-ink" aria-hidden="true" />
          )}
        </div>
        <div className="flex flex-col gap-2.5">
          {questions.map((q) => (
            <QuestionText key={q.question} q={q} />
          ))}
        </div>
      </Shell>
    );
  }

  // Review step: every sub-question answered → show each with its spoken answer, then Confirm / Back.
  if (idx >= total) {
    return (
      <Shell>
        <div className="mb-1 flex items-center gap-2">
          <CircleHelp className="size-4 text-violet-ink" aria-hidden="true" />
          {total > 1 && <Dots total={total} current={total} />}
        </div>
        <div className="flex flex-col gap-2.5">
          {questions.map((q, i) => (
            <div key={q.question} className="flex flex-col gap-0.5">
              {q.header && <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{q.header}</p>}
              <p className="text-[14px] leading-snug text-ink-soft">{q.question}</p>
              <p className="text-[15px] font-medium leading-snug text-violet-ink">{answers[i]}</p>
            </div>
          ))}
        </div>
        {live && (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={onConfirm}
              aria-label="Confirm answers"
              className="grid size-9 place-items-center rounded-full bg-violet text-white shadow-soft transition-transform duration-150 ease-soft active:scale-95"
            >
              <Check className="size-5" />
            </button>
            <button
              type="button"
              onClick={onRedo}
              aria-label="Redo the last answer"
              className="grid size-8 place-items-center rounded-full text-violet-ink/70 transition-colors hover:bg-violet/15 hover:text-violet-ink"
            >
              <ChevronLeft className="size-4" />
            </button>
          </div>
        )}
      </Shell>
    );
  }

  // Active sub-question: the current question + options, read aloud, awaiting a spoken answer.
  const current = questions[idx];
  return (
    <Shell>
      <div className="mb-2 flex items-center gap-2">
        <CircleHelp className="size-4 text-violet-ink" aria-hidden="true" />
        {total > 1 && <Dots total={total} current={idx} />}
        {live && idx > 0 && (
          <button
            type="button"
            onClick={onRedo}
            aria-label="Previous question"
            className="ml-auto grid size-7 place-items-center rounded-full text-violet-ink/70 transition-colors hover:bg-violet/15 hover:text-violet-ink"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}
      </div>
      <MessageAudio controls={controls} requestId={`${requestId}#${idx}`} />
      <div className="mt-2.5">
        <QuestionText q={current} />
      </div>
    </Shell>
  );
}

// The lavender question bubble shell, shared by every wizard state.
function Shell({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <div className={cn("flex w-full flex-col items-start", dim && "opacity-60")}>
      <div className="max-w-[88%] rounded-bubble border border-violet/30 bg-violet-soft/60 px-4 py-3 shadow-soft">
        {children}
      </div>
    </div>
  );
}

// One question's header + prompt + lettered options (the options are shown so you know your choices; you
// answer by voice — the spoken transcript becomes that sub-question's custom answer).
function QuestionText({ q }: { q: Question }) {
  return (
    <div className="flex flex-col gap-1.5">
      {q.header && <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{q.header}</p>}
      <p className="text-[15px] font-medium leading-snug text-ink">{q.question}</p>
      {q.options.length > 0 && (
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
      )}
    </div>
  );
}

// Progress through the sub-questions — filled dots for done/current, hollow for ahead. Numerals would read
// in one language; dots are language-neutral, matching the wizard's chrome-free intent.
function Dots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-1" aria-label={`Question ${Math.min(current + 1, total)} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional dots, index IS the identity
          key={i}
          className={cn("size-1.5 rounded-full", i <= current ? "bg-violet-ink" : "bg-violet/30")}
        />
      ))}
    </div>
  );
}
