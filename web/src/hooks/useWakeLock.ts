import { useEffect, useRef } from "react";

// Screen Wake Lock — keeps the phone screen on for the whole session (the main
// use case is a phone left open on the page). Degrades gracefully where the API
// is unsupported. Acquires on mount, re-acquires when the tab becomes visible
// again (the lock is auto-released when hidden), and releases on teardown.
export function useWakeLock(): void {
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let released = false;

    async function request(): Promise<void> {
      if (sentinel.current || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (released) {
          // Teardown raced ahead of the await — release immediately.
          try {
            await lock.release();
          } catch {
            /* ignore */
          }
          return;
        }
        sentinel.current = lock;
        lock.addEventListener("release", () => {
          sentinel.current = null;
        });
      } catch {
        sentinel.current = null; // denied/unsupported — page still works, screen may sleep
      }
    }

    function onVisibility(): void {
      if (document.visibilityState === "visible") void request();
    }

    document.addEventListener("visibilitychange", onVisibility);
    // Also re-acquire on pageshow (bfcache restore) so a returning tab keeps the lock.
    window.addEventListener("pageshow", onVisibility);
    void request();

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
      const current = sentinel.current;
      sentinel.current = null;
      if (current) {
        try {
          void current.release();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);
}
