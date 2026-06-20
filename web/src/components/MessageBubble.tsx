import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// A chat bubble. User messages: right-aligned peach bubble, text + time + coral
// check. Agent messages: left-aligned lavender bubble that may contain arbitrary
// children (the inline audio player embeds here) above the text, plus a time.
export function MessageBubble({
  side,
  body,
  time,
  delivered,
  children
}: {
  side: "user" | "agent";
  body: string;
  time: string;
  delivered?: boolean;
  children?: ReactNode;
}) {
  const isUser = side === "user";
  return (
    <div className={cn("flex w-full flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[82%] rounded-bubble px-4 py-3 text-[15px] leading-relaxed shadow-soft",
          isUser ? "rounded-br-md bg-coral-soft text-ink" : "rounded-bl-md bg-violet-soft text-ink"
        )}
      >
        {children && <div className="mb-2">{children}</div>}
        {body && <p className="whitespace-pre-wrap break-words">{body}</p>}
      </div>

      <div
        className={cn("mt-1 flex items-center gap-1 px-1 text-[11px] text-ink-faint", isUser ? "flex-row" : "flex-row")}
      >
        <span className="tabular-nums">{time}</span>
        {isUser && delivered && <Check className="size-3.5 text-coral" />}
      </div>
    </div>
  );
}
