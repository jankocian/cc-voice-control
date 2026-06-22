import { LockIcon } from "lucide-react";

// Shown when the pairing window has closed and this device has no valid cookie (POST /claim → 403).
// The session URL alone is intentionally not enough to get in — pairing must be re-opened from the
// computer, so a leaked link or screenshotted QR can't grant access after the fact.
export function SessionExpired() {
  return (
    <main className="grid min-h-full place-items-center bg-canvas px-8">
      <div className="flex max-w-xs flex-col items-center gap-3 rounded-card bg-surface px-7 py-9 text-center shadow-card">
        <span className="grid size-12 place-items-center rounded-full bg-coral-soft text-coral-ink">
          <LockIcon className="size-5" />
        </span>
        <h1 className="text-lg font-semibold text-ink">Pairing window closed</h1>
        <p className="text-sm text-ink-soft">
          To connect this device, run <span className="font-medium text-ink">/voice-control:pair</span> on your
          computer, then reload this page.
        </p>
      </div>
    </main>
  );
}
