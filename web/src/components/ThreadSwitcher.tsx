import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RosterThread, ThreadId } from "@/lib/protocol";
import { cn } from "@/lib/utils";

// The active thread's presence dot tone, reusing #10's grading inputs (connected + how long
// since lastSeenAt) plus its runtime state. Working = coral, idle/ready = success, offline =
// faint. Kept tiny and local: a dot doesn't need the full StatusView cascade.
export type DotTone = "success" | "coral" | "faint";

export type ThreadRow = {
  thread: RosterThread;
  unread: number;
  tone: DotTone;
};

// The header white pill → dropdown switcher (#7 / design §8.2). Shows the active thread's
// label (title + repo·branch subtitle) and, when more than one thread exists, opens a sheet
// listing every roster thread with a status dot + unread badge. A single thread renders the
// label with no dropdown affordance — identical to today's single-screen UX.
export function ThreadSwitcher({
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
  const active = rows.find((r) => r.thread.threadId === activeThreadId) ?? rows[0];
  // Progressive disclosure: the dropdown only earns its place once a 2nd thread joins.
  const multi = rows.length > 1;

  if (!active) return null;

  return (
    <div className="relative flex min-w-0 items-center justify-center gap-1">
      <button
        type="button"
        disabled={!multi}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup={multi ? "menu" : undefined}
        aria-expanded={multi ? open : undefined}
        className="flex min-w-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-ink transition-colors duration-200 ease-soft hover:bg-surface/70 active:scale-[0.98] disabled:active:scale-100"
      >
        <Dot tone={active.tone} />
        <ThreadLabelText label={active.thread.label} />
        {multi && <ChevronDown className="size-4 shrink-0 text-ink-faint" aria-hidden="true" />}
      </button>

      {/* Spawn is ALWAYS reachable, beside the pill — opening a 2nd session can't live only inside the
          dropdown, which itself only appears once a 2nd thread exists (chicken-and-egg). One tap →
          spawn_thread on the active thread's daemon. */}
      <button
        type="button"
        onClick={onSpawn}
        aria-label="New session"
        className="grid size-8 shrink-0 place-items-center rounded-full text-ink-soft transition-colors duration-200 ease-soft hover:bg-surface/70 hover:text-ink active:scale-[0.98]"
      >
        <Plus className="size-4" aria-hidden="true" />
      </button>

      {open && multi && (
        <ThreadMenu
          rows={rows}
          activeThreadId={activeThreadId}
          onSelect={(id) => {
            setOpen(false);
            onSelect(id);
          }}
          onSpawn={() => {
            setOpen(false);
            onSpawn();
          }}
          onDismiss={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ThreadMenu({
  rows,
  activeThreadId,
  onSelect,
  onSpawn,
  onDismiss
}: {
  rows: ThreadRow[];
  activeThreadId: ThreadId | null;
  onSelect: (threadId: ThreadId) => void;
  onSpawn: () => void;
  onDismiss: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss on an outside tap or Escape. A pointerdown listener (not click) closes before the
  // pill's own toggle would re-open it, and matches the rest of the app's gesture handling.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onDismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="absolute top-full z-30 mt-2 max-h-[60vh] w-72 max-w-[85vw] overflow-y-auto rounded-card border border-hairline bg-surface/95 p-1.5 shadow-soft backdrop-blur-md"
    >
      {rows.map(({ thread, unread, tone }) => {
        const isActive = thread.threadId === activeThreadId;
        return (
          <button
            key={thread.threadId}
            type="button"
            role="menuitemradio"
            aria-checked={isActive}
            onClick={() => onSelect(thread.threadId)}
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

      <button
        type="button"
        role="menuitem"
        onClick={onSpawn}
        className="mt-1 flex w-full items-center gap-2.5 rounded-control border-t border-hairline px-2.5 py-2 text-left text-ink-soft transition-colors hover:bg-canvas-deep/40 hover:text-ink"
      >
        <span className="grid size-2 shrink-0 place-items-center text-ink-faint">
          <Plus className="size-4" />
        </span>
        <span className="text-sm font-medium">New thread</span>
      </button>
    </div>
  );
}

// Title (the cmux task description / repo·branch) over an optional repo·branch subtitle. The
// daemon precomputes `title`; we surface repo·branch beneath it when present for context.
function ThreadLabelText({ label }: { label: RosterThread["label"] }) {
  const subtitle = [label.repo, label.branch].filter(Boolean).join(" · ");
  // Only show the subtitle when it adds something the title doesn't already say.
  const showSubtitle = subtitle.length > 0 && subtitle !== label.title;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-base font-semibold leading-tight tracking-tight">{label.title}</span>
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
