import { useCallback, useEffect, useState } from "react";

// Theme preference: an explicit dark/light choice, or "system" to follow the OS. Persisted in
// localStorage; "system" tracks `prefers-color-scheme` live (and is the default with no stored choice,
// matching the no-flash media-query rule in index.css that paints before JS runs).
export type ThemeMode = "system" | "dark" | "light";

const KEY = "voiceRemote.theme";
// Keep in sync with --color-canvas (light) / its dark override in index.css.
const BAR = { light: "#faf6f1", dark: "#181621" };

function storedTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

// Drive the <html> classes index.css keys off: explicit `.dark`/`.light` override the media query, while
// "system" sets neither so the `prefers-color-scheme` rule wins. Also keep the address-bar colour in step.
function apply(theme: ThemeMode): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  const dark = theme === "dark" || (theme === "system" && prefersDark());
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? BAR.dark : BAR.light);
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(storedTheme);

  useEffect(() => {
    apply(theme);
    if (theme !== "system") return;
    // While following the OS, re-apply when it flips (the CSS recolours itself; this keeps the meta + any
    // computed bits in sync).
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode — in-memory only */
    }
  }, []);

  return { theme, setTheme };
}
