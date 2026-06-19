import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
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

// The activity panel is a shadcn <Card>; its scroll region is a shadcn
// <ScrollArea> (Radix). The `.log` class stays on the inner content div so the
// `.log:empty::after` "No activity yet" placeholder and row styling are preserved.
export function MessageList({ messages, playableIds, playingId, onPlay, onReplay }: MessageListProps) {
  return (
    <Card className="log-panel flex flex-1 flex-col gap-0 overflow-hidden rounded-[var(--radius)] py-0 shadow-none">
      <div className="panel-head">Activity</div>
      <ScrollArea className="flex-1 min-h-[120px]">
        <div id="log" className="log" aria-label="Session events">
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
      </ScrollArea>
    </Card>
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
      className={className}
      data-kind={message.kind}
      data-request-id={requestId}
      onClick={playable && requestId ? () => onPlay(requestId) : undefined}
    >
      {playable && requestId ? (
        <span className="entry-controls">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="replay-btn size-[26px] rounded-full text-[color:var(--text-3)] hover:text-[color:var(--text)]"
            aria-label="Replay this message"
            onClick={(event) => {
              event.stopPropagation();
              onReplay(requestId);
            }}
          >
            <ReplayIcon />
          </Button>
          <span className="entry-icon">
            <PlayPauseIcons />
          </span>
        </span>
      ) : null}
      <time>{message.time}</time>
      <p>{message.body}</p>
    </article>
  );
}
