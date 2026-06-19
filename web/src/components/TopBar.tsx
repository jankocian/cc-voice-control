import { ChevronDown, Menu, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Top app bar: circular menu button (left), centered thread title with a dropdown
// chevron + a status dot, circular settings/sliders button (right).
export function TopBar({
  title = "Shopify Integration",
  online,
  onMenu,
  onSettings
}: {
  title?: string;
  online: boolean;
  onMenu?: () => void;
  onSettings?: () => void;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
      <Button variant="surface" size="icon" aria-label="Threads menu" onClick={onMenu}>
        <Menu />
      </Button>

      <button
        type="button"
        className="flex min-w-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-ink transition-colors duration-200 ease-soft hover:bg-surface/70 active:scale-[0.98]"
      >
        <span
          className={cn(
            "size-2 shrink-0 rounded-full transition-colors",
            online ? "bg-success" : "bg-ink-faint"
          )}
          aria-hidden="true"
        />
        <span className="truncate text-[15px] font-semibold tracking-tight">{title}</span>
        <ChevronDown className="size-4 shrink-0 text-ink-faint" aria-hidden="true" />
      </button>

      <Button variant="surface" size="icon" aria-label="Settings" onClick={onSettings}>
        <SlidersHorizontal />
      </Button>
    </header>
  );
}
