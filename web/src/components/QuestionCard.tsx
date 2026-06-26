import { Check, CircleSlash } from "lucide-react";
import { type AudioControls, MessageAudio } from "@/components/MessageAudio";
import type { Question, QuestionPayload } from "@/lib/protocol";
import { cn } from "@/lib/utils";

// Claude's interactive AskUserQuestion, shown as a SEQUENTIAL wizard: one sub-question at a time (read aloud
// with the same player as a message — play/scrub/replay), answered by VOICE (with auto-respond on the mic
// opens by itself once the question finishes playing — auto OR a manual tap). The wizard is one-way and the
// last answer AUTO-SUBMITS — no confirm tap, no back-step — so it's fully hands-free. Deliberately chrome-light
// and language-agnostic: the only words on screen are Claude's own question + options (already in the
// conversation's language); the wizard adds only progress dots. `requestId` keys the sub-question audio.
export function QuestionCard({
  question,
  requestId,
  controls
}: {
  question: QuestionPayload;
  requestId: string;
  controls: AudioControls;
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

  // Review step: every sub-question answered → the filled-out wrap-up (each question with its spoken answer).
  // No confirm button — the last answer already auto-submitted; this is just the conclusion as it flushes to
  // history (the card then flips to the dimmed answered state above).
  if (idx >= total) {
    return (
      <Shell>
        <div className="flex flex-col gap-2.5">
          {questions.map((q, i) => (
            <div key={q.question} className="flex flex-col gap-0.5">
              {q.header && <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{q.header}</p>}
              <p className="text-[14px] leading-snug text-ink-soft">{q.question}</p>
              <p className="text-[15px] font-medium leading-snug text-violet-ink">{answers[i]}</p>
            </div>
          ))}
        </div>
      </Shell>
    );
  }

  // Active sub-question: the current question + options, read aloud, awaiting a spoken answer. The progress
  // dots ride on the header (FOCUS) row, aligned right — a subtle "N questions total" indicator, nothing more.
  const current = questions[idx];
  return (
    <Shell>
      <MessageAudio controls={controls} requestId={`${requestId}#${idx}`} />
      <div className="mt-2.5">
        <QuestionText q={current} trailing={total > 1 ? <Dots total={total} current={idx} /> : undefined} />
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
// answer by voice — the spoken transcript becomes that sub-question's custom answer). `trailing` rides on the
// header (FOCUS) row, aligned right — the active sub-question uses it for the progress dots.
function QuestionText({ q, trailing }: { q: Question; trailing?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {(q.header || trailing) && (
        <div className="flex items-center gap-2">
          {q.header && <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{q.header}</p>}
          {trailing && <div className="ml-auto">{trailing}</div>}
        </div>
      )}
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
