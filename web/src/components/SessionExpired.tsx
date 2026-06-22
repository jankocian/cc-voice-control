import { LockIcon } from "lucide-react";

// Shown when this device has no valid cookie and the pairing window is closed (POST /claim → 403) —
// because the link is single-use: it pairs one device, once, then stops working (or it expired
// unused). A leaked link or screenshotted QR therefore can't grant access after the fact; a fresh
// link must be opened from the computer.
export function SessionExpired() {
  return (
    <main className="grid min-h-full place-items-center bg-canvas px-8">
      <div className="flex max-w-xs flex-col items-center gap-3 rounded-card bg-surface px-7 py-9 text-center shadow-card">
        <span className="grid size-12 place-items-center rounded-full bg-coral-soft text-coral-ink">
          <LockIcon className="size-5" />
        </span>
        <h1 className="text-lg font-semibold text-ink">This link has expired</h1>
        <p className="text-sm text-ink-soft">
          It's a one-time link — it pairs a single device, then stops working. To connect this device, run{" "}
          <span className="font-medium text-ink">/voice-control:pair</span> on your computer for a fresh link, then
          reload this page.
        </p>
      </div>
    </main>
  );
}
