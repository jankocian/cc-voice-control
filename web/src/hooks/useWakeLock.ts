import { useEffect, useRef } from "react";

// Screen Wake Lock — keeps the phone screen on for the whole session (a phone left open
// on the page is the entire use case). Degrades gracefully where unsupported.
//
// The iOS-critical detail: the FIRST `wakeLock.request("screen")` must run inside a user
// gesture (transient activation), otherwise Safari rejects it with NotAllowedError. A
// request fired from `useEffect`/mount alone never carries activation, so on iOS the lock
// was never acquired and the screen slept after the idle timeout. We therefore seed the
// lock from the first real pointer/touch/key gesture. Once acquired under activation, the
// authorisation is sticky for the document's lifetime (iOS 17+), so re-acquiring on
// foreground return needs no further gesture.
//
// The lock is auto-released whenever the page is hidden (lock screen, app switch, the
// auto-dim itself), so we re-acquire on visibilitychange→visible, plus pageshow (bfcache)
// and focus (a few devices miss visibilitychange after Control Center / notifications).
export function useWakeLock(): void {
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    let released = false;
    const supported = "wakeLock" in navigator;

    async function request(): Promise<void> {
      if (released || !supported) return;
      if (document.visibilityState !== "visible") return;
      if (sentinel.current && !sentinel.current.released) return; // already held
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
          // Auto-released on hide; re-acquired by onVisibility when we return.
          sentinel.current = null;
        });
        // First success carried the gesture's activation; iOS makes the authorisation
        // sticky from here, so we no longer need the seed listeners.
        removeSeedListeners();
      } catch {
        // NotAllowedError (no activation yet / Low Power Mode) or unsupported — the page
        // still works, the screen may sleep. A later gesture or foreground return retries.
        sentinel.current = null;
      }
    }

    function onVisibility(): void {
      if (document.visibilityState === "visible") void request();
    }

    // One-shot-ish seed: the first gesture gives `request()` the transient activation iOS
    // demands. Listeners are removed on the first successful acquire (see request()).
    function onSeedGesture(): void {
      void request();
    }
    function removeSeedListeners(): void {
      document.removeEventListener("pointerdown", onSeedGesture);
      document.removeEventListener("touchend", onSeedGesture);
      document.removeEventListener("keydown", onSeedGesture);
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);
    window.addEventListener("focus", onVisibility);
    document.addEventListener("pointerdown", onSeedGesture);
    document.addEventListener("touchend", onSeedGesture);
    document.addEventListener("keydown", onSeedGesture);
    // Best-effort immediate attempt (succeeds on Android/desktop where no gesture is
    // required; on iOS it harmlessly fails and the seed listeners take over).
    void request();

    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
      window.removeEventListener("focus", onVisibility);
      removeSeedListeners();
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
