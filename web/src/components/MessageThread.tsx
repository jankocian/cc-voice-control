import { Loader2, RotateCcw } from "lucide-react";
import { InlineAudioPlayer } from "@/components/InlineAudioPlayer";
import { MessageBubble } from "@/components/MessageBubble";
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
  onPlay: (requestId: string) => void;
  onReplay: (requestId: string) => void;
  onSeek: (requestId: string, seconds: number) => void;
};

// Shown in an agent bubble while its audio is still being synthesized.
function AudioPending() {
  return (
    <div className="flex items-center gap-2 text-xs font-medium text-violet-ink/70">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      <span>Generating voice…</span>
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
          // A pending echo (local stt placeholder) shows without the delivered check until the projection
          // confirms the turn reached Claude (then the real row replaces it, delivered).
          return (
            <MessageBubble
              key={message.id}
              side="user"
              body={message.body}
              time={message.time}
              delivered={!message.pending}
            />
          );
        }

        // A step: Claude's interim narration. Dim, compact, tap-to-play (synthesized on demand).
        if (message.interim) {
          return (
            <StepRow
              key={message.id}
              body={message.body}
              playing={playback.playingId === message.requestId}
              onPlay={() => playback.onPlay(message.requestId)}
            />
          );
        }

        const requestId = message.requestId;
        const playable = requestId ? playback.playableIds.has(requestId) : false;
        const status = requestId ? playback.audioStatus.get(requestId) : undefined;
        const id = requestId ?? message.id;
        const loaded = playback.loadedId === id;

        return (
          <MessageBubble
            key={message.id}
            side="agent"
            body={message.body}
            time={message.time}
            onActivate={playable && requestId ? () => playback.onPlay(requestId) : undefined}
          >
            {playable && requestId ? (
              <InlineAudioPlayer
                playing={playback.playingId === requestId}
                loaded={loaded}
                position={loaded ? playback.position : 0}
                duration={loaded ? playback.duration : 0}
                onPlayPause={() => playback.onPlay(requestId)}
                onReplay={() => playback.onReplay(requestId)}
                onSeek={(seconds) => playback.onSeek(requestId, seconds)}
              />
            ) : status === "pending" ? (
              <AudioPending />
            ) : status === "failed" && requestId ? (
              <AudioRetry onRetry={() => playback.onPlay(requestId)} />
            ) : null}
          </MessageBubble>
        );
      })}
    </div>
  );
}
