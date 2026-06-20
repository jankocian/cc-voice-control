import { AudioLines, Menu, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FEATURES } from "@/lib/features";

// Top app bar. The center slot holds the thread switcher (#7) when there's something to switch;
// the menu / settings surfaces are kept here behind FEATURES flags so they can be switched back
// on later. With no `children`, the bar is just the small "voice control" wordmark (left).
export function TopBar({
  onMenu,
  onSettings,
  children
}: {
  // Kept for API compatibility with the demo harness; the live online dot now lives on the
  // switcher pill (per-active-thread), so the bar itself no longer reads it.
  online?: boolean;
  onMenu?: () => void;
  onSettings?: () => void;
  // The centered thread switcher (pill → dropdown). App gates it on FEATURES.threadTitle.
  children?: ReactNode;
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

      {children}

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
