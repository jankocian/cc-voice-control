import type { Message } from "../lib/messages";
import { PlayPauseIcons, ReplayIcon } from "./icons";

export type MessageListProps = {
  // Newest first (the vanilla log prepends).
  messages: Message[];
  playableIds: ReadonlySet<string>;
  playingId: string | null;
  onPlay: (requestId: string) => void;
  onReplay: (requestId: string) => void;
};

export function MessageList({ messages, playableIds, playingId, onPlay, onReplay }: MessageListProps) {
  return (
    <section class="panel log-panel">
      <div class="panel-head">Activity</div>
      <div id="log" class="log" aria-label="Session events">
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            playable={Boolean(message.requestId && playableIds.has(message.requestId))}
            playing={Boolean(message.requestId && playingId === message.requestId)}
            onPlay={onPlay}
            onReplay={onReplay}
          />
        ))}
      </div>
    </section>
  );
}

function MessageRow({
  message,
  playable,
  playing,
  onPlay,
  onReplay
}: {
  message: Message;
  playable: boolean;
  playing: boolean;
  onPlay: (requestId: string) => void;
  onReplay: (requestId: string) => void;
}) {
  const requestId = message.requestId;
  const className = `entry${playable ? " playable" : ""}${playing ? " playing" : ""}`;

  return (
    <article
      class={className}
      data-kind={message.kind}
      data-request-id={requestId}
      onClick={playable && requestId ? () => onPlay(requestId) : undefined}
    >
      {playable && requestId ? (
        <span class="entry-controls">
          <button
            type="button"
            class="ec-btn replay-btn"
            aria-label="Replay this message"
            onClick={(event) => {
              event.stopPropagation();
              onReplay(requestId);
            }}
          >
            <ReplayIcon />
          </button>
          <span class="entry-icon">
            <PlayPauseIcons />
          </span>
        </span>
      ) : null}
      <time>{message.time}</time>
      <p>{message.body}</p>
    </article>
  );
}
