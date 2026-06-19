import { AudioLines, Layers, PenSquare } from "lucide-react";
import { cn } from "@/lib/utils";

// Bottom tab bar: Threads (layers) · center waveform (active, coral) · New thread
// (compose). The center tab is the elevated active voice tab.
export function BottomTabBar({
  onThreads,
  onNewThread
}: {
  onThreads?: () => void;
  onNewThread?: () => void;
}) {
  return (
    <nav className="flex shrink-0 items-center justify-around border-t border-hairline bg-surface/80 px-6 pb-2 pt-2.5 backdrop-blur-sm">
      <Tab label="Threads" onClick={onThreads}>
        <Layers className="size-[22px]" />
      </Tab>

      <button
        type="button"
        aria-label="Voice"
        aria-current="page"
        className="grid size-12 -translate-y-1 place-items-center rounded-full bg-coral text-white shadow-mic transition-transform duration-150 ease-soft active:scale-95"
      >
        <AudioLines className="size-6" />
      </button>

      <Tab label="New" onClick={onNewThread}>
        <PenSquare className="size-[22px]" />
      </Tab>
    </nav>
  );
}

function Tab({
  label,
  onClick,
  children
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex w-16 flex-col items-center gap-0.5 text-ink-faint transition-colors duration-150 hover:text-ink-soft"
      )}
    >
      {children}
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}
