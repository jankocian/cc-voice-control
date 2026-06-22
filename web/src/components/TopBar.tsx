import { AudioLines } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Top app bar: the "voice control" wordmark (left) and a slot for the settings menu (right) — which holds
// the read-aloud + theme controls. The thread switcher + New session live in the bottom <BottomSwitcher>,
// so the header stays minimal. Floating-glass styling (like the bottom pill) so it reads as a layer over
// the canvas; it shares the header slot with <MiniControls> and slides out (via `className`) when the
// page is scrolled.
export function TopBar({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        "flex min-h-16 items-center justify-between gap-2 border-b border-hairline/60 bg-surface/70 px-4 backdrop-blur-md",
        className
      )}
    >
      <Wordmark />
      {children}
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
