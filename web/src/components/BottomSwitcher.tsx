import { ChevronUp, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RosterThread, ThreadId } from "@/lib/protocol";
import { cn } from "@/lib/utils";

// The active thread's presence dot tone (#10 grading): working = coral, idle/ready = success,
// offline/unreachable = faint.
export type DotTone = "success" | "coral" | "faint";

export type ThreadRow = {
  thread: RosterThread;
  unread: number;
  tone: DotTone;
};

// The thread switcher, moved out of the (now slim) nav bar to a subtle "liquid glass" pill floating at
// the bottom, where it doesn't congest the header. Collapsed it shows the active thread's repo·branch;
// tapping grows a list UPWARD (every thread as name + repo·branch + unread, plus New session — the only
// entry point for spawning now, so the pill shows even with a single thread). The swipe dots sit just
// below, but only with 2+ threads (a lone dot would say nothing).
export function BottomSwitcher({
  rows,
  activeThreadId,
  onSelect,
  onSpawn
}: {
  rows: ThreadRow[];
  activeThreadId: ThreadId | null;
  onSelect: (threadId: ThreadId) => void;
  onSpawn: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = rows.find((r) => r.thread.threadId === activeThreadId) ?? rows[0];

  // Close on an outside tap or Escape (checked against the whole switcher so a tap on the pill closes
  // via its own onClick instead of being dismissed here and immediately re-toggled open).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Always shown when there's a session (it's the only way to spawn another); only truly empty rosters
  // render nothing.
  if (!active) return null;

  const branch = branchLabel(active.thread.label);
  const multi = rows.length > 1;
  // A subtle "you have unread elsewhere" cue on the collapsed pill — any NON-active thread with unread.
  const hasOtherUnread = rows.some((r) => r.thread.threadId !== activeThreadId && r.unread > 0);

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center pb-safe"
    >
      <div className="pointer-events-auto mb-2 flex w-full flex-col items-center gap-1.5">
        {open && (
          <div
            role="menu"
            // Concentric radii: outer rounded-bubble (20px) − p-1 (4px) = the rows' rounded-control (16px),
            // so the row corners nest cleanly inside the menu's.
            className="flex max-h-[55vh] w-72 max-w-[85vw] animate-rise flex-col overflow-y-auto rounded-bubble border border-hairline/70 bg-surface/80 p-1 shadow-lift backdrop-blur-xl"
          >
            {rows.map(({ thread, unread, tone }) => {
              const isActive = thread.threadId === activeThreadId;
              return (
                <button
                  key={thread.threadId}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    setOpen(false);
                    onSelect(thread.threadId);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors",
                    isActive ? "bg-canvas-deep/60" : "hover:bg-canvas-deep/40"
                  )}
                >
                  <Dot tone={tone} />
                  <span className="min-w-0 flex-1">
                    <ThreadLabelText label={thread.label} />
                  </span>
                  {unread > 0 && (
                    <span className="grid min-w-5 shrink-0 place-items-center rounded-full bg-coral px-1.5 text-xs font-semibold tabular-nums text-white">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </button>
              );
            })}

            {/* A clean straight divider — a 1px line of its own, so the border doesn't ride the
                New-session button's rounded corners (which read as a weirdly-curved rule). */}
            <div className="mx-2.5 my-1 border-t border-hairline" aria-hidden="true" />

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSpawn();
              }}
              className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-ink-soft transition-colors hover:bg-canvas-deep/40 hover:text-ink"
            >
              <Plus className="size-4 shrink-0 text-ink-faint" />
              <span className="text-sm font-medium">New session</span>
            </button>
          </div>
        )}

        {/* The collapsed glass pill — current thread's repo·branch. A coral dot rides the top-right corner
            when another thread has unread (only meaningful while collapsed; the list shows the counts). */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="relative flex max-w-[85%] items-center gap-1.5 rounded-full border border-hairline/60 bg-surface/70 px-3 py-1.5 text-[13px] font-medium text-ink shadow-soft backdrop-blur-md transition-colors duration-200 ease-soft hover:bg-surface/90 active:scale-[0.98]"
        >
          <Dot tone={active.tone} />
          <span className="truncate">{branch}</span>
          <ChevronUp
            className={cn("size-3.5 shrink-0 text-ink-faint transition-transform duration-200", open && "rotate-180")}
            aria-hidden="true"
          />
          {hasOtherUnread && !open && (
            <span
              className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-canvas bg-coral"
              aria-label="Unread messages in another session"
            />
          )}
        </button>

        {/* Swipe indicator — DISPLAY ONLY (not tappable), only meaningful with more than one thread.
            It sits in the iOS home-indicator zone, where the bottom edge-swipe (app switcher / close)
            would otherwise land on a dot and switch threads by accident. Paging is by sideways swipe;
            the pill above is the tap target. pointer-events-none lets the OS gesture pass straight
            through, and the row is decorative (aria-hidden) — the pill/menu is the accessible switcher. */}
        {multi && (
          <div className="pointer-events-none flex items-center gap-1.5" aria-hidden="true">
            {rows.map(({ thread }) => {
              const isActive = thread.threadId === activeThreadId;
              return (
                <span
                  key={thread.threadId}
                  className={cn(
                    "h-1.5 shrink-0 rounded-full transition-all duration-200 ease-soft",
                    isActive ? "w-5 bg-coral" : "w-1.5 bg-ink-faint/40"
                  )}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// The compact pill label: repo·branch when we have it, else the daemon's title.
function branchLabel(label: RosterThread["label"]): string {
  return [label.repo, label.branch].filter(Boolean).join(" · ") || label.title;
}

// Title (the cmux task description) over a repo·branch subtitle, surfaced when it adds context.
function ThreadLabelText({ label }: { label: RosterThread["label"] }) {
  const subtitle = [label.repo, label.branch].filter(Boolean).join(" · ");
  const showSubtitle = subtitle.length > 0 && subtitle !== label.title;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-sm font-semibold leading-tight tracking-tight">{label.title}</span>
      {showSubtitle && <span className="truncate text-xs font-medium leading-tight text-ink-faint">{subtitle}</span>}
    </span>
  );
}

function Dot({ tone }: { tone: DotTone }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "success" ? "bg-success" : tone === "coral" ? "bg-coral" : "bg-ink-faint"
      )}
      aria-hidden="true"
    />
  );
}
