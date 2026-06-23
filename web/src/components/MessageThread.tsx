import { Loader2, RotateCcw } from "lucide-react";
import { InlineAudioPlayer } from "@/components/InlineAudioPlayer";
import { MessageBubble } from "@/components/MessageBubble";
import { QuestionCard } from "@/components/QuestionCard";
import { StepRow } from "@/components/StepRow";
import type { Message } from "@/lib/messages";

export type ThreadPlayback = {
  playingId: string | null;
  loadedId: string | null;
  position: number;
  duration: number;
  playableIds: ReadonlySet<string>;
  // Per-reply audio lifecycle (pending = synthesizing, failed = retryable) for the loading/retry indicator.
  audioStatus: ReadonlyMap<string, "pending" | "failed">;
  // requestId for which a tap-to-play fetch is in flight (loading spinner for steps + history rows).
  pendingPlayId: string | null;
  onPlay: (requestId: string) => void;
  onReplay: (requestId: string) => void;
  onSeek: (requestId: string, seconds: number) => void;
};

// Skeleton player shown while audio is synthesizing — same structural dimensions as InlineAudioPlayer
// so the bubble height never shifts when the real player swaps in.
function AudioPendingPlayer() {
  return (
    <div className="flex items-center gap-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-full bg-violet/40">
        <Loader2 className="size-4 animate-spin text-white" aria-hidden="true" />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="w-9 shrink-0 text-right text-[11px] font-medium tabular-nums text-violet-ink/40">0:00</span>
        <div className="h-1.5 flex-1 rounded-full bg-violet/15" />
        <span className="w-9 shrink-0 text-[11px] font-medium tabular-nums text-violet-ink/40" />
      </div>
      {/* placeholder keeps the same width as the replay button */}
      <div className="size-8 shrink-0" />
    </div>
  );
}

// Shown when synthesis failed — tapping re-requests it (the daemon re-synthesizes on demand).
function AudioRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onRetry();
      }}
      className="flex items-center gap-1.5 rounded-full text-xs font-medium text-danger transition-colors hover:text-danger/80"
    >
      <RotateCcw className="size-3.5" aria-hidden="true" />
      <span>Voice failed — tap to retry</span>
    </button>
  );
}

// The chat thread. `messages` are newest-first and render in that order, so the
// latest turn sits at the top, directly under the hero. Agent rows with attached
// audio embed the inline player inside the lavender bubble.
export function MessageThread({ messages, playback }: { messages: Message[]; playback: ThreadPlayback }) {
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

        // An interactive question: render the card (question + lettered options); answer by voice.
        if (message.question) {
          return (
            <QuestionCard
              key={message.id}
              question={message.question}
              playing={playback.playingId === message.requestId}
              onPlay={() => playback.onPlay(message.requestId)}
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
        const playable = requestId ? playback.playableIds.has(requestId) : false;
        const status = requestId ? playback.audioStatus.get(requestId) : undefined;
        const isFetchPending = requestId ? playback.pendingPlayId === requestId : false;
        const id = requestId ?? message.id;
        const loaded = playback.loadedId === id;

        // Status "pending" (synthesizing) takes precedence over playable — the skeleton player
        // shows at the same height so no layout shift when real audio arrives.
        const audioContent =
          status === "pending" || isFetchPending ? (
            <AudioPendingPlayer />
          ) : playable && requestId ? (
            <InlineAudioPlayer
              playing={playback.playingId === requestId}
              loaded={loaded}
              position={loaded ? playback.position : 0}
              duration={loaded ? playback.duration : 0}
              onPlayPause={() => playback.onPlay(requestId)}
              onReplay={() => playback.onReplay(requestId)}
              onSeek={(seconds) => playback.onSeek(requestId, seconds)}
            />
          ) : status === "failed" && requestId ? (
            <AudioRetry onRetry={() => playback.onPlay(requestId)} />
          ) : null;

        return (
          <MessageBubble
            key={message.id}
            side="agent"
            body={message.body}
            time={message.time}
            onActivate={playable && requestId ? () => playback.onPlay(requestId) : undefined}
          >
            {audioContent}
          </MessageBubble>
        );
      })}
    </div>
  );
}
