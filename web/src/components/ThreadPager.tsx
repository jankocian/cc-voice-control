import useEmblaCarousel from "embla-carousel-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MessageThread, type ThreadPlayback } from "@/components/MessageThread";
import type { Message } from "@/lib/messages";
import type { ThreadId } from "@/lib/protocol";
import { cn } from "@/lib/utils";

export type PagerThread = {
  threadId: ThreadId;
  messages: Message[];
};

// Horizontal thread carousel powered by Embla — one slide per thread. Embla owns the gesture: drag /
// momentum / snap on touch AND mouse, with built-in angle detection so a vertical drag scrolls the
// message list inside a slide while a horizontal drag pages between threads (the hand-rolled
// scroll-snap + touch-action version couldn't do this reliably on iOS). Each slide is its own VERTICAL
// scroller holding that thread's in-flow hero + messages, so threads keep independent scroll positions.
// `renderHero(isActive)` wires the live mic/canvas to the on-screen slide only.
//
// Swipe ↔ active-thread sync is two-way: Embla's `select` makes the snapped slide active; an external
// switch (pill / dots / saved-thread restore) calls `scrollTo`. The first positioning JUMPS (no
// animation) and the carousel stays hidden until then, so resuming the saved thread shows no swipe blip
// — just a subtle fade-in.
export function ThreadPager({
  threads,
  activeThreadId,
  renderHero,
  playback,
  onActivate,
  activeScrollRootRef,
  activeSentinelRef
}: {
  threads: PagerThread[];
  activeThreadId: ThreadId | null;
  // Renders the in-flow hero for a page; `isActive` wires the live mic/canvas to the on-screen page.
  renderHero: (isActive: boolean) => ReactNode;
  playback: ThreadPlayback;
  onActivate: (threadId: ThreadId) => void;
  // The active page's vertical scroll root + its hero sentinel, lifted to App so the shared
  // condensed-bar IntersectionObserver watches whichever thread is on screen.
  activeScrollRootRef: (node: HTMLDivElement | null) => void;
  activeSentinelRef: (node: HTMLDivElement | null) => void;
}) {
  const [emblaRef, emblaApi] = useEmblaCarousel({ align: "start", duration: 22 });
  const [ready, setReady] = useState(false);
  // Read latest threads/active inside Embla's stable callback without re-subscribing each render.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  // The first scrollTo jumps (no animation); later ones (pill / dots) glide.
  const didPositionRef = useRef(false);

  // Swipe settle → the snapped slide becomes the active thread (a programmatic scrollTo also emits
  // `select`, but it lands on the already-active thread, so onActivate is a no-op there).
  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => {
      const id = threadsRef.current[emblaApi.selectedScrollSnap()]?.threadId;
      if (id && id !== activeThreadIdRef.current) onActivate(id);
    };
    emblaApi.on("select", onSelect);
    return () => {
      emblaApi.off("select", onSelect);
    };
  }, [emblaApi, onActivate]);

  // External switch (pill / dots) or the initial saved-thread restore → bring that slide into view.
  // Jump on the first positioning (no blip resuming the saved thread), animate after. Reveal once
  // positioned so the init→jump is never seen.
  useEffect(() => {
    if (!emblaApi) return;
    const idx = activeThreadId ? threads.findIndex((t) => t.threadId === activeThreadId) : -1;
    if (idx >= 0) {
      if (emblaApi.selectedScrollSnap() !== idx) emblaApi.scrollTo(idx, !didPositionRef.current);
      didPositionRef.current = true; // consume the "jump" only on the first REAL positioning
      setReady(true);
    } else if (threads.length === 0) {
      setReady(true); // nothing to position — reveal the empty pager
    }
  }, [emblaApi, activeThreadId, threads]);

  return (
    <div
      ref={emblaRef}
      className={cn(
        "h-full overflow-hidden transition-opacity duration-300 ease-soft",
        ready ? "opacity-100" : "opacity-0"
      )}
    >
      <div className="flex h-full">
        {threads.map(({ threadId, messages }) => {
          const isActive = threadId === activeThreadId;
          return (
            <div key={threadId} className="h-full min-w-0 shrink-0 grow-0 basis-full">
              {/* The active slide owns the lifted scroll-root + sentinel refs so the condensed bar
                  tracks it; inactive slides keep their own scroll position. */}
              <div
                ref={isActive ? activeScrollRootRef : undefined}
                className="flex h-full flex-col overflow-y-auto overscroll-y-contain pb-safe"
              >
                {/* The hero, in normal flow at the top of this slide — scrolls away with the messages. */}
                {renderHero(isActive)}
                {/* Hero sentinel: when it scrolls above the top on the ACTIVE slide (hero gone), the
                    condensed bar appears. Only the active slide wires it (it's the one being read). */}
                <div
                  ref={isActive ? activeSentinelRef : undefined}
                  aria-hidden="true"
                  className="h-px w-full shrink-0"
                />
                <MessageThread messages={messages} playback={playback} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
