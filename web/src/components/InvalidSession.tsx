import { LinkIcon } from "lucide-react";

// Shown when the URL has no valid /s/<id>?token=… — an honest message rather than
// a broken UI. (The Worker also refuses to serve the shell without a token.)
export function InvalidSession() {
  return (
    <main className="grid min-h-full place-items-center bg-canvas px-8">
      <div className="flex max-w-xs flex-col items-center gap-3 rounded-card bg-surface px-7 py-9 text-center shadow-card">
        <span className="grid size-12 place-items-center rounded-full bg-coral-soft text-coral-ink">
          <LinkIcon className="size-5" />
        </span>
        <h1 className="text-lg font-semibold text-ink">Invalid session link</h1>
        <p className="text-sm text-ink-soft">Open the URL from /voice-control:start in your terminal.</p>
      </div>
    </main>
  );
}
