import { type AudioControls, MessageAudio } from "@/components/MessageAudio";
import { MessageBubble } from "@/components/MessageBubble";
import { QuestionCard } from "@/components/QuestionCard";
import { StepRow } from "@/components/StepRow";
import type { Message } from "@/lib/messages";

// The audio surface (shared by messages + the question wizard) plus the wizard's own actions: CONFIRM submits
// every collected answer, REDO steps back one sub-question. Both act on the active thread (App wires them).
export type ThreadPlayback = AudioControls & {
  onQuestionConfirm: (toolUseId: string) => void;
  onQuestionRedo: (toolUseId: string) => void;
};

// The chat thread. `messages` are newest-first and render in that order, so the
// latest turn sits at the top, directly under the hero. Agent rows with attached
// audio embed the inline player inside the lavender bubble. `live` = this is the
// active thread, so the question wizard's controls are actionable (the mic is shared).
export function MessageThread({
  messages,
  playback,
  live
}: {
  messages: Message[];
  playback: ThreadPlayback;
  live: boolean;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
        <p className="text-sm font-medium text-ink-soft">No messages yet</p>
        <p className="text-xs text-ink-faint">Tap the mic and speak to start the conversation</p>
      </div>
    );
  }

  return (
    // Generous bottom padding so the last turn scrolls clear of the always-on bottom switcher + dots
    // (which float over the scroll area) instead of hiding behind them.
    <div className="flex flex-col gap-4 px-4 pb-28">
      {messages.map((message) => {
        if (message.kind === "you") {
          return (
            <MessageBubble
              key={message.id}
              side="user"
              body={message.body}
              time={message.time}
              delivery={message.delivery}
            />
          );
        }

        // An interactive question: the sequential voice wizard (one sub-question at a time, then confirm).
        const question = message.question;
        if (question) {
          return (
            <QuestionCard
              key={message.id}
              question={question}
              requestId={message.requestId}
              live={live}
              controls={playback}
              onConfirm={() => playback.onQuestionConfirm(question.toolUseId)}
              onRedo={() => playback.onQuestionRedo(question.toolUseId)}
            />
          );
        }

        // A step: Claude's interim narration. Dim, compact, whole-row tap-to-play (synthesized on demand).
        if (message.interim) {
          const stepStatus = playback.audioStatus.get(message.requestId);
          return (
            <StepRow
              key={message.id}
              body={message.body}
              playing={playback.playingId === message.requestId}
              loading={playback.pendingPlayId === message.requestId || stepStatus === "pending"}
              failed={stepStatus === "failed"}
              onPlay={() => playback.onPlay(message.requestId)}
            />
          );
        }

        const requestId = message.requestId;
        const playable = playback.playableIds.has(requestId);
        return (
          <MessageBubble
            key={message.id}
            side="agent"
            body={message.body}
            time={message.time}
            onActivate={playable ? () => playback.onPlay(requestId) : undefined}
          >
            <MessageAudio controls={playback} requestId={requestId} />
          </MessageBubble>
        );
      })}
    </div>
  );
}
