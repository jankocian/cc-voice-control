import { Toast } from "@base-ui-components/react/toast";
import { CircleAlert, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

// One shared toast manager so any code — even outside React — can raise a toast: `toast.add({...})`,
// `toast.update(id, {...})`, `toast.close(id)`. The <Toaster> (mounted once in App) subscribes to it.
// Used for the spawn-a-new-agent progress, and any retryable error (set `type: "error"` + `actionProps`).
export const toast = Toast.createToastManager();

// Toasts float just under the nav bar, centered, in a phone-width column.
export function Toaster() {
  return (
    <Toast.Provider toastManager={toast}>
      <Toast.Portal>
        {/* pointer-events-none so the (full-width, nav-overlapping) viewport never eats taps on the bar
            beneath it — e.g. the settings gear; each toast re-enables pointer-events for itself. */}
        <Toast.Viewport className="pointer-events-none fixed inset-x-0 top-0 z-50 mx-auto flex w-full max-w-md flex-col gap-2 px-4 pt-[calc(env(safe-area-inset-top)+4.25rem)]">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => {
    const loading = item.type === "loading";
    const error = item.type === "error";
    return (
      <Toast.Root
        key={item.id}
        toast={item}
        className={cn(
          "flex items-center gap-3 rounded-card border border-hairline bg-surface/95 p-3 shadow-lift backdrop-blur-md",
          "transition-[transform,opacity] duration-300 ease-soft",
          "data-[starting-style]:-translate-y-3 data-[starting-style]:opacity-0",
          "data-[ending-style]:-translate-y-3 data-[ending-style]:opacity-0"
        )}
      >
        {/* The state lives in the left icon (red for errors), not a coloured border — keeps the toast calm. */}
        {loading && <Loader2 className="size-4 shrink-0 animate-spin text-coral" aria-hidden="true" />}
        {error && <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <Toast.Title className={cn("text-sm font-semibold leading-tight", error ? "text-danger" : "text-ink")} />
          {item.description ? <Toast.Description className="mt-0.5 text-xs leading-snug text-ink-soft" /> : null}
        </div>
        {item.actionProps ? (
          <Toast.Action className="shrink-0 rounded-full bg-coral px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-coral/90" />
        ) : null}
        <Toast.Close
          aria-label="Dismiss"
          className="grid size-6 shrink-0 place-items-center rounded-full text-ink-faint transition-colors hover:bg-canvas-deep hover:text-ink"
        >
          <X className="size-4" />
        </Toast.Close>
      </Toast.Root>
    );
  });
}
