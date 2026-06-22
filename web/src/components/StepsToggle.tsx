import { Headphones } from "lucide-react";
import { Button } from "@/components/ui/button";

// Header toggle for "read every step": when on, Claude's interim steps are spoken aloud on voice turns
// (not just the final reply). Off shows the muted surface chip; on lights up violet (the agent accent).
export function StepsToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <Button
      variant={on ? "violet" : "surface"}
      size="iconSm"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={
        on
          ? "Reading every step aloud; tap to read the final reply only"
          : "Reading the final reply only; tap to read every step aloud"
      }
      title={on ? "Read every step (on)" : "Read final reply only"}
    >
      <Headphones />
    </Button>
  );
}
