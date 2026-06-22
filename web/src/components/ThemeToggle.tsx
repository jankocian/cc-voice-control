import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

// Light/dark toggle for the top bar. Persists the choice; with no stored choice it follows the OS
// (the same default the no-flash `prefers-color-scheme` rule in index.css paints pre-JS). Once mounted
// it sets an explicit `.dark`/`.light` class on <html>, which overrides the media query — so toggling
// is authoritative while a never-toggled user still tracks their OS across loads.
const KEY = "voiceRemote.theme";
// Keep in sync with --color-canvas (light) / its dark override in index.css.
const BAR = { light: "#faf6f1", dark: "#181621" };

function storedPref(): "dark" | "light" | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function apply(dark: boolean): void {
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? BAR.dark : BAR.light);
}

export function ThemeToggle() {
  const [dark, setDark] = useState(() => storedPref() === "dark" || (storedPref() === null && prefersDark()));

  useEffect(() => {
    apply(dark);
  }, [dark]);

  return (
    <button
      type="button"
      onClick={() => {
        setDark((d) => {
          const next = !d;
          try {
            localStorage.setItem(KEY, next ? "dark" : "light");
          } catch {
            /* ignore */
          }
          return next;
        });
      }}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      className="grid size-9 shrink-0 place-items-center rounded-control text-ink-soft transition-colors hover:bg-canvas-deep hover:text-ink"
    >
      {dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </button>
  );
}
