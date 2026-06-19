import { useCallback, useEffect, useRef, useState } from "react";

// Transient status-line message. The vanilla client showed a flash for ~2.6s
// (and cleared it ~2.7s after the last flash). Re-flashing resets the timer.
const FLASH_VISIBLE_MS = 2600;
const FLASH_CLEAR_MS = 2700;

export type Flash = {
  flash: string | null;
  show: (text: string) => void;
};

export function useFlash(): Flash {
  const [flash, setFlash] = useState<string | null>(null);
  const timerRef = useRef(0);
  const untilRef = useRef(0);

  const show = useCallback((text: string): void => {
    untilRef.current = Date.now() + FLASH_VISIBLE_MS;
    setFlash(text);
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

  return { flash, show };
}
