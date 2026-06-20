import { useEffect, useRef } from "react";
import { MessageThread, type ThreadPlayback } from "@/components/MessageThread";
import type { Message } from "@/lib/messages";
import type { ThreadId } from "@/lib/protocol";

export type PagerThread = {
  threadId: ThreadId;
  messages: Message[];
};

// Horizontal CSS scroll-snap pager: one page per thread, swiped natively (momentum + snap, zero
// JS gesture code, no carousel lib — design §8.3). Each page is its own VERTICAL scroller holding
// that thread's message list, so each thread keeps an independent scroll position. The single
// shared hero (one mic/canvas) is pinned over the top of the active page by App; each page leaves
// a `heroHeight` spacer so its messages start below the hero and scroll up under it.
//
// Swipe ↔ active-thread sync is two-way: a settle on a page makes it active (IntersectionObserver
// per page — the same primitive App already uses for the condensed bar); selecting a thread in
// the pill scrolls the matching page into view (the `scrollTo` effect below).
//
// iOS Safari gesture tuning (§11-F): the outer pager declares `touch-action: pan-x` and the inner
// vertical scrollers `touch-action: pan-y`, so the browser routes a horizontal drag to the pager
// and a vertical drag to the message list instead of letting them fight for the same gesture.
// `overscroll-behavior: contain` on both axes stops a scroll hitting one scroller's edge from
// chaining into the other (e.g. a vertical fling at the top of the list flipping the page).
export function ThreadPager({
  threads,
  activeThreadId,
  heroHeight,
  playback,
  onActivate,
  activeScrollRootRef,
  activeSentinelRef
}: {
  threads: PagerThread[];
  activeThreadId: ThreadId | null;
  // Height (px) reserved at the top of each page for the pinned, shared hero.
  heroHeight: number;
  playback: ThreadPlayback;
  onActivate: (threadId: ThreadId) => void;
  // The active page's vertical scroll root + its hero sentinel, lifted to App so the shared
  // condensed-bar IntersectionObserver watches whichever thread is on screen.
  activeScrollRootRef: (node: HTMLDivElement | null) => void;
  activeSentinelRef: (node: HTMLDivElement | null) => void;
}) {
  const pagerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<ThreadId, HTMLDivElement>());
  // Suppress the scroll-settle -> onActivate feedback while WE are programmatically scrolling to a
  // selected page (a pill/dropdown pick), so the observer doesn't fight the imperative scroll.
  const programmaticRef = useRef(false);
  // The observer reads the latest active thread through a ref so it never has to re-subscribe on a
  // switch; re-subscribing only matters when the set of pages changes (the effect's `threads` dep).
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;

  // Observe which page is centered in the pager; the most-visible one becomes active. Depends on
  // `threads` so a join/leave re-subscribes to the new set of page nodes (we observe each thread's
  // node, so the nodes to watch change only when the thread list does).
  useEffect(() => {
    const root = pagerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (programmaticRef.current) return;
        for (const entry of entries) {
          if (!entry.isIntersecting || entry.intersectionRatio < 0.5) continue;
          const threadId = (entry.target as HTMLElement).dataset.threadId;
          if (threadId && threadId !== activeThreadIdRef.current) onActivate(threadId);
        }
      },
      { root, threshold: 0.5 }
    );
    for (const { threadId } of threads) {
      const node = pageRefs.current.get(threadId);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [threads, onActivate]);

  // A pill/dropdown selection (activeThreadId changed without a swipe) scrolls the matching page
  // into view. Guarded by `programmaticRef` so the resulting settle doesn't re-fire onActivate.
  useEffect(() => {
    if (!activeThreadId) return;
    const page = pageRefs.current.get(activeThreadId);
    const pager = pagerRef.current;
    if (!page || !pager) return;
    if (Math.abs(page.offsetLeft - pager.scrollLeft) < 1) return; // already there (e.g. a swipe)
    programmaticRef.current = true;
    pager.scrollTo({ left: page.offsetLeft, behavior: "smooth" });
    const done = window.setTimeout(() => {
      programmaticRef.current = false;
    }, 400);
    return () => window.clearTimeout(done);
  }, [activeThreadId]);

  return (
    <div
      ref={pagerRef}
      className="flex h-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [touch-action:pan-x]"
    >
      {threads.map(({ threadId, messages }) => {
        const isActive = threadId === activeThreadId;
        return (
          <div
            key={threadId}
            data-thread-id={threadId}
            ref={(node) => {
              if (node) pageRefs.current.set(threadId, node);
              else pageRefs.current.delete(threadId);
            }}
            className="h-full w-full shrink-0 snap-center snap-always"
          >
            {/* The active page owns the lifted scroll-root + sentinel refs so the shared hero +
                condensed bar track it; inactive pages keep their own scroll position. */}
            <div
              ref={isActive ? activeScrollRootRef : undefined}
              className="flex h-full flex-col overflow-y-auto overscroll-y-contain pb-safe [touch-action:pan-y]"
            >
              {/* Spacer reserving room for the pinned, shared hero rendered over the pager. */}
              <div aria-hidden="true" className="w-full shrink-0" style={{ height: heroHeight }} />
              {/* Hero sentinel: when it scrolls up under the pinned hero on the ACTIVE page, the
                  condensed bar appears. Only the active page wires it (it's the one being read). */}
              <div ref={isActive ? activeSentinelRef : undefined} aria-hidden="true" className="h-px w-full shrink-0" />
              <MessageThread messages={messages} playback={playback} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
