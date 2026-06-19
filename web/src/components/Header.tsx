import { Button } from "@/components/ui/button";

// The playback-speed pill is now a shadcn <Button> (outline/rounded-full),
// preserving the original tap-to-cycle behavior and tabular-nums rate label.
export function Header({ rateLabel, onCycleSpeed }: { rateLabel: string; onCycleSpeed: () => void }) {
  return (
    <header className="app-header">
      <h1 className="app-title">voice control</h1>
      <Button
        id="speedButton"
        type="button"
        variant="outline"
        size="sm"
        aria-label="Playback speed"
        onClick={onCycleSpeed}
        className="h-[30px] rounded-full px-3 text-[12.5px] font-semibold tabular-nums text-[color:var(--text-2)] hover:text-[color:var(--text)]"
      >
        {rateLabel}
      </Button>
    </header>
  );
}
