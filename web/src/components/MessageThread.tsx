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
  onPlay: (requestId: string) => void;
  onReplay: (requestId: string) => void;
  onSeek: (requestId: string, seconds: number) => void;
};

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
          return <MessageBubble key={message.id} side="user" body={message.body} time={message.time} delivered />;
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

        const playable = message.requestId ? playback.playableIds.has(message.requestId) : false;
        const id = message.requestId ?? message.id;
        const loaded = playback.loadedId === id;

        return (
          <MessageBubble
            key={message.id}
            side="agent"
            body={message.body}
            time={message.time}
            onActivate={playable && message.requestId ? () => playback.onPlay(message.requestId as string) : undefined}
          >
            {playable && message.requestId && (
              <InlineAudioPlayer
                playing={playback.playingId === message.requestId}
                loaded={loaded}
                position={loaded ? playback.position : 0}
                duration={loaded ? playback.duration : 0}
                onPlayPause={() => playback.onPlay(message.requestId as string)}
                onReplay={() => playback.onReplay(message.requestId as string)}
                onSeek={(seconds) => playback.onSeek(message.requestId as string, seconds)}
              />
            )}
          </MessageBubble>
        );
      })}
    </div>
  );
}
