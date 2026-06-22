import { AudioLines } from "lucide-react";
import type { ReactNode } from "react";

// Top app bar: the "voice control" wordmark (left) and a slot for the settings menu (right) — which holds
// the read-aloud + theme controls. The thread switcher + New session live in the bottom <BottomSwitcher>,
// so the header stays minimal.
export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="flex min-h-16 shrink-0 items-center justify-between gap-2 px-4 pt-safe">
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
