import { useCallback, useEffect, useRef, useState } from "react";

// Transient status-line message: visible for ~2.6s, fully cleared ~2.7s after the last
// flash. Re-flashing resets the timer.
const FLASH_VISIBLE_MS = 2600;
const FLASH_CLEAR_MS = 2700;

// "alert" flashes render red (an action the user must notice — e.g. trying to spawn from a
// disconnected thread); "info" is the neutral default.
export type FlashTone = "info" | "alert";

export type Flash = {
  flash: string | null;
  flashTone: FlashTone;
  show: (text: string, tone?: FlashTone) => void;
};

export function useFlash(): Flash {
  const [flash, setFlash] = useState<string | null>(null);
  const [flashTone, setFlashTone] = useState<FlashTone>("info");
  const timerRef = useRef(0);
  const untilRef = useRef(0);

  const show = useCallback((text: string, tone: FlashTone = "info"): void => {
    untilRef.current = Date.now() + FLASH_VISIBLE_MS;
    setFlash(text);
    setFlashTone(tone);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      // Only clear if no newer flash extended the window.
      if (Date.now() >= untilRef.current) setFlash(null);
    }, FLASH_CLEAR_MS);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  return { flash, flashTone, show };
}
