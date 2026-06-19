import { Card } from "@/components/ui/card";
import type { StatusView } from "../lib/status";

// The status panel is the primary feedback surface: a panel that fills with a
// subtle per-state colour (driven by `.status[data-state]` in index.css). No
// badge — the dot + label + the colour fill convey the state, matching the
// original design exactly.
export function StatusPanel({ status }: { status: StatusView }) {
  return (
    <Card
      id="statusPanel"
      className="panel status flex-row gap-0 rounded-[var(--radius)] py-0 shadow-none"
      data-state={status.dataState}
      aria-live="polite"
    >
      <div className="status-main">
        <span id="lamp" className={status.lampClass} aria-hidden="true" />
        <div className="status-text">
          <strong id="stateLabel">{status.title}</strong>
          <span id="detailLabel">{status.detail}</span>
        </div>
      </div>
    </Card>
  );
}
