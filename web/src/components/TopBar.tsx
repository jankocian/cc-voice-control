import { AudioLines } from "lucide-react";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";

// Top app bar: the "voice control" wordmark (left), an optional slot for global controls (the
// "read every step" toggle), and the light/dark toggle (right). The thread switcher + New session
// live in the bottom <BottomSwitcher> now, so the header stays minimal.
export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="flex min-h-16 shrink-0 items-center justify-between gap-2 px-4 pt-safe">
      <Wordmark />
      <div className="flex items-center gap-1">
        {children}
        <ThemeToggle />
      </div>
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
