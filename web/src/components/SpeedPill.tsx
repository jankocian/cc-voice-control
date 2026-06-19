import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

// The playback-speed pill ("1.25x ⌄"). Tapping cycles through the speed presets
// (wired to usePlayback.cycleSpeed). The rate is persisted by the hook.
export function SpeedPill({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="surface" size="pill" onClick={onClick} aria-label={`Playback speed ${label}, tap to change`}>
      <span className="font-semibold tabular-nums">{label}</span>
      <ChevronDown className="size-3.5 text-ink-faint" />
    </Button>
  );
}
