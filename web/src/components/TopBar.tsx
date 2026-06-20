import { AudioLines, ChevronDown, Menu, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FEATURES } from "@/lib/features";
import { cn } from "@/lib/utils";

// Top app bar. For the current single-screen experience this is just a small
// "voice control" wordmark (left). The menu / thread-title / settings surfaces are
// kept here behind FEATURES flags so they can be switched back on later.
export function TopBar({
  title = "",
  online,
  onMenu,
  onSettings
}: {
  title?: string;
  online: boolean;
  onMenu?: () => void;
  onSettings?: () => void;
}) {
  return (
    <header className="flex min-h-16 shrink-0 items-center justify-between gap-2 px-4 pt-safe">
      {FEATURES.threadMenu ? (
        <Button variant="surface" size="icon" aria-label="Threads menu" onClick={onMenu}>
          <Menu />
        </Button>
      ) : (
        <Wordmark />
      )}

      {FEATURES.threadTitle && (
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-ink transition-colors duration-200 ease-soft hover:bg-surface/70 active:scale-[0.98]"
        >
          <span
            className={cn("size-2 shrink-0 rounded-full transition-colors", online ? "bg-success" : "bg-ink-faint")}
            aria-hidden="true"
          />
          <span className="truncate text-base font-semibold tracking-tight">{title}</span>
          <ChevronDown className="size-4 shrink-0 text-ink-faint" aria-hidden="true" />
        </button>
      )}

      {FEATURES.settings && (
        <Button variant="surface" size="icon" aria-label="Settings" onClick={onSettings}>
          <SlidersHorizontal />
        </Button>
      )}
    </header>
  );
}

// Small brand mark — a logo placeholder + label. Swap the icon for the real mark.
function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <span className="grid size-7 place-items-center rounded-control bg-coral/15 text-coral" aria-hidden="true">
        <AudioLines className="size-4" />
      </span>
      <span className="text-base font-semibold tracking-tight text-ink">voice control</span>
    </div>
  );
}
