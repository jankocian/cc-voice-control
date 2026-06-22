import useEmblaCarousel from "embla-carousel-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
  const [emblaRef, emblaApi] = useEmblaCarousel({ align: "start", containScroll: "keepSnaps", duration: 20 });
  const [ready, setReady] = useState(false);
  // Read latest threads/active inside Embla's stable callbacks without re-subscribing each render.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  // Mirror `ready` so the stable callback can read it. Before the first reveal we JUMP (no animation) so
  // restoring the saved thread shows no swipe; once revealed, user switches (pill / dots) glide.
  const readyRef = useRef(false);

  // Bring the active thread's slide into view. This is event-driven (not just a render effect) because
  // Embla re-measures its slides ASYNCHRONOUSLY (watchSlides reInits a tick after React commits): a
  // synchronous scrollTo would target a stale slide layout, then a later re-run would animate — the blip.
  // We only act once Embla's snap count matches the threads (slides measured), jump until the first
  // reveal, and reveal only then — so the init/restore positioning is never seen as a swipe.
  const positionToActive = useCallback(() => {
    if (!emblaApi) return;
    if (emblaApi.scrollSnapList().length !== threadsRef.current.length) return; // slides not measured yet
    const idx = activeThreadIdRef.current
      ? threadsRef.current.findIndex((t) => t.threadId === activeThreadIdRef.current)
      : -1;
    if (idx < 0) return;
    if (emblaApi.selectedScrollSnap() !== idx) emblaApi.scrollTo(idx, !readyRef.current);
    if (!readyRef.current) {
      readyRef.current = true;
      setReady(true);
    }
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    // Swipe settle → the snapped slide becomes active (a programmatic scrollTo also emits `select`, but
    // it lands on the already-active thread, so onActivate is a no-op there).
    const onSelect = () => {
      const id = threadsRef.current[emblaApi.selectedScrollSnap()]?.threadId;
      if (id && id !== activeThreadIdRef.current) onActivate(id);
    };
    emblaApi.on("select", onSelect);
    // Re-apply position once Embla (re)measures — the key timing fix (slides arrive after React commits).
    emblaApi.on("reInit", positionToActive);
    emblaApi.on("slidesChanged", positionToActive);
    positionToActive();
    return () => {
      emblaApi.off("select", onSelect);
      emblaApi.off("reInit", positionToActive);
      emblaApi.off("slidesChanged", positionToActive);
    };
  }, [emblaApi, onActivate, positionToActive]);

  // An external switch (pill / dots) or the saved-thread restore changed the active thread → reposition.
  // activeThreadId/threads are intentional re-run triggers (positionToActive reads the latest via refs).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on active/threads change
  useEffect(() => {
    positionToActive();
  }, [activeThreadId, threads, positionToActive]);

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
