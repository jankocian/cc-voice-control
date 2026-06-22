// Which thread is focused — persisted in localStorage, NEVER in the URL. The URL stays static after load
// (no replaceState), which is what lets the page be pinned as a PWA: a changing URL would otherwise risk
// iOS re-prompting for the mic in standalone mode.
//
// The `?t=<threadId>` query is a ONE-TIME deep link: a QR for a specific pane opens straight to that thread
// the first time it's seen. After that localStorage is in charge — and because that same `?t=` rides the
// PWA's launch URL on every relaunch, we remember which one we've already consumed and ignore it thereafter,
// so it can't keep overriding the thread the user actually left off on.

import { readThreadHint } from "./session";

const ACTIVE_KEY = "vc.active-thread";
const CONSUMED_DEEPLINK_KEY = "vc.consumed-deeplink";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode / storage disabled
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — in-memory only for this load */
  }
}

// The thread to focus on load. A NEW `?t=` deep link wins once (and becomes the stored thread); a `?t=` we
// already consumed is ignored so the stored thread stays in charge. Otherwise: the last thread we stored.
// Call once per load (it consumes the deep link). Returns null when there's nothing to restore.
export function initialThread(): string | null {
  const hint = readThreadHint();
  if (hint && hint !== read(CONSUMED_DEEPLINK_KEY)) {
    write(CONSUMED_DEEPLINK_KEY, hint);
    write(ACTIVE_KEY, hint);
    return hint;
  }
  return read(ACTIVE_KEY);
}

// Persist the user's current thread so a refresh / PWA relaunch restores it — without touching the URL.
export function storeActiveThread(threadId: string): void {
  write(ACTIVE_KEY, threadId);
}
