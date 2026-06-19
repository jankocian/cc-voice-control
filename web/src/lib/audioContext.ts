// One long-lived AudioContext for the whole app.
//
// iOS is the reason this is a singleton rather than a per-recording context:
//   • WebKit caps how many AudioContexts a page may create — churning one per recording
//     eventually fails to construct new ones.
//   • A context constructed right after the page was backgrounded can be born "suspended"
//     or stuck in WebKit's non-standard "interrupted" state (it never produces samples,
//     so the mic visualiser is a flat line). The cure is to RESUME an existing context on
//     every user gesture and every foreground return, not to make a new one.
//
// So: keep exactly one context, resume it aggressively, and never close it for the life
// of the page.

type AudioContextCtor = typeof AudioContext;

function ctor(): AudioContextCtor {
  return window.AudioContext || (window as unknown as { webkitAudioContext: AudioContextCtor }).webkitAudioContext;
}

let ctx: AudioContext | null = null;

/** The shared context, created lazily. Callers must never close it. */
export function getAudioContext(): AudioContext {
  if (!ctx || ctx.state === "closed") ctx = new (ctor())();
  return ctx;
}

/**
 * Resume the shared context, tolerating WebKit's "interrupted" state.
 *
 * On iOS `resume()` can hang (the promise stays pending until an interruption ends) or
 * reject outright while interrupted, and a once-running context that was interrupted
 * drops to "suspended" rather than auto-resuming. So we kick `resume()`, then wait on
 * `statechange` (retrying each transition) up to a bounded timeout. Call this from inside
 * the user gesture that starts recording.
 */
export async function ensureAudioRunning(): Promise<AudioContext> {
  const c = getAudioContext();
  if (c.state === "running") return c;
  try {
    await c.resume();
  } catch {
    // may reject while interrupted — fall through to the statechange wait
  }
  // resume() may have moved us to "running"; cast defeats TS's stale narrowing from the
  // first check (it can't see that resume() mutates `state`).
  if ((c.state as AudioContextState) === "running") return c;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      c.removeEventListener("statechange", onChange);
      resolve();
    };
    const onChange = (): void => {
      if (c.state === "running") finish();
      else c.resume().catch(() => {});
    };
    const timer = setTimeout(finish, 2500);
    c.addEventListener("statechange", onChange);
    c.resume().catch(() => {});
  });
  return c;
}

// Keep the shared context warm: resume it on any user gesture and whenever the tab comes
// back to the foreground. This covers the "born interrupted after backgrounding" bug so
// the next record tap finds a live context instead of a flat one. Idempotent install.
let wired = false;
export function wireAudioContextRecovery(): void {
  if (wired) return;
  wired = true;
  const warm = (): void => {
    if (ctx && ctx.state !== "running" && ctx.state !== "closed") ctx.resume().catch(() => {});
  };
  for (const ev of ["pointerdown", "touchend", "keydown"]) {
    document.addEventListener(ev, warm, { passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") warm();
  });
}
