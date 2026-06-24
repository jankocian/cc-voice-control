import { useEffect, useState } from "react";

// A ticking wall clock (epoch ms) that re-renders every `intervalMs` while `active`,
// so a pure status function can transition reconnecting→offline and refresh "X ago"
// with no server message. Returns a single Date.now() and stops ticking when inactive
// (don't spin a timer while the session is healthy). The value still updates on toggle.
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Snap to the current time whenever activity changes (entering the disconnected
    // state shouldn't wait a full interval for its first reading).
    setNow(Date.now());
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);

  return now;
}

// "02:38" style mm:ss.
export function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
