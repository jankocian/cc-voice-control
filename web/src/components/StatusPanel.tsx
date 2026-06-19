import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { StatusView } from "../lib/status";

// Maps the status data-state to a Badge variant for the state indicator. The
// per-state colour fill still comes from the `.status[data-state=…]` CSS on the
// Card so behaviour/appearance parity with the vanilla client is preserved.
const BADGE_VARIANT: Record<StatusView["dataState"], "default" | "secondary" | "destructive" | "outline"> = {
  ready: "secondary",
  recording: "destructive",
  sending: "secondary",
  speaking: "secondary",
  working: "secondary",
  offline: "outline"
};

export function StatusPanel({ status }: { status: StatusView }) {
  return (
    <Card
      id="statusPanel"
      class="status flex-row gap-0 rounded-[var(--radius)] py-0 shadow-none"
      data-state={status.dataState}
      aria-live="polite"
    >
      <div class="status-main">
        <span id="lamp" class={status.lampClass} aria-hidden="true" />
        <div class="status-text">
          <strong id="stateLabel">{status.title}</strong>
          <span id="detailLabel">{status.detail}</span>
        </div>
      </div>
      <Badge
        variant={BADGE_VARIANT[status.dataState]}
        class="shrink-0 uppercase tracking-wider text-[10px] font-semibold"
      >
        {status.key === "not-listening" ? "offline" : status.dataState}
      </Badge>
    </Card>
  );
}
