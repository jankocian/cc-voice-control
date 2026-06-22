import { LockIcon } from "lucide-react";

// Shown when /claim is rejected for good (after retries) and this device can't connect. Two cases, same
// fix (run /voice-control:pair for a fresh link), different wording:
//  - "stale": a device cookie was present but the session no longer recognises it — e.g. the voice
//    remote was stopped/slept long enough to be revoked while the phone was away.
//  - "expired": no valid cookie + closed window — a fresh or already-used one-time link.
// Either way a leaked link / screenshotted QR can't grant access after the fact.
export function SessionExpired({ reason }: { reason: "stale" | "expired" }) {
  const heading = reason === "stale" ? "Session needs re-pairing" : "This link has expired";
  return (
    <main className="grid min-h-full place-items-center bg-canvas px-8">
      <div className="flex max-w-xs flex-col items-center gap-3 rounded-card bg-surface px-7 py-9 text-center shadow-card">
        <span className="grid size-12 place-items-center rounded-full bg-coral-soft text-coral-ink">
          <LockIcon className="size-5" />
        </span>
        <h1 className="text-lg font-semibold text-ink">{heading}</h1>
        <p className="text-sm text-ink-soft">
          {reason === "stale"
            ? "This device was paired, but the voice remote was stopped and the session ended. "
            : "It's a one-time link — it pairs a single device, then stops working. "}
          To reconnect, run <span className="font-medium text-ink">/voice-control:pair</span> on your computer for a
          fresh link, then reload this page.
        </p>
      </div>
    </main>
  );
}
