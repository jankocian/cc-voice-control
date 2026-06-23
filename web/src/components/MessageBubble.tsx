import { Check, CheckCheck, Clock } from "lucide-react";
import type { ReactNode } from "react";
import { renderMarkdown } from "@/lib/markdown";
import type { Delivery } from "@/lib/messages";
import { cn } from "@/lib/utils";

// A chat bubble. User messages: right-aligned peach bubble, plain transcribed text + time + a WhatsApp-style
// delivery mark (clock = queued, one check = received by Claude, two coral checks = in Claude's transcript).
// Agent messages: left-aligned lavender bubble that may contain arbitrary children (the inline audio player
// embeds here) above the body, which is rendered as light Markdown so it reads like the terminal.
// `onActivate` (agent rows with audio) makes the whole card a play/pause target — the player's own controls
// stop propagation so they aren't double-triggered.
export function MessageBubble({
  side,
  body,
  time,
  delivery,
  onActivate,
  children
}: {
  side: "user" | "agent";
  body: string;
  time: string;
  delivery?: Delivery;
  onActivate?: () => void;
  children?: ReactNode;
}) {
  const isUser = side === "user";
  return (
    <div className={cn("flex w-full flex-col", isUser ? "items-end" : "items-start")}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only play/pause affordance — the
          inline play button (with aria-label) is the keyboard/AT control, so the card stays role-free. */}
      <div
        onClick={onActivate}
        className={cn(
          "max-w-[82%] rounded-bubble px-4 py-3 text-[15px] leading-relaxed shadow-soft",
          isUser ? "rounded-br-md bg-coral-soft text-ink" : "rounded-bl-md bg-violet-soft text-ink",
          onActivate && "cursor-pointer"
        )}
      >
        {children && <div className="mb-2">{children}</div>}
        {body &&
          (isUser ? (
            <p className="whitespace-pre-wrap break-words">{body}</p>
          ) : (
            <div className="break-words">{renderMarkdown(body)}</div>
          ))}
      </div>

      <div
        className={cn("mt-1 flex items-center gap-1 px-1 text-[11px] text-ink-faint", isUser ? "flex-row" : "flex-row")}
      >
        <span className="tabular-nums">{time}</span>
        {isUser &&
          delivery &&
          (delivery === "queued" ? (
            <Clock className="size-3.5 text-ink-faint" aria-label="Queued" />
          ) : delivery === "accepted" ? (
            <Check className="size-3.5 text-ink-faint" aria-label="Received by Claude" />
          ) : (
            <CheckCheck className="size-3.5 text-coral" aria-label="In Claude's history" />
          ))}
      </div>
    </div>
  );
}
