import { Button } from "@/components/ui/button";

// The playback-speed pill is now a shadcn <Button> (outline/rounded-full),
// preserving the original tap-to-cycle behavior and tabular-nums rate label.
export function Header({ rateLabel, onCycleSpeed }: { rateLabel: string; onCycleSpeed: () => void }) {
  return (
    <header class="app-header">
      <h1 class="app-title">voice control</h1>
      <Button
        id="speedButton"
        type="button"
        variant="outline"
        size="sm"
        aria-label="Playback speed"
        onClick={onCycleSpeed}
        class="h-[30px] rounded-full px-3 text-[12.5px] font-semibold tabular-nums text-[color:var(--text-2)] hover:text-[color:var(--text)]"
      >
        {rateLabel}
      </Button>
    </header>
  );
}
