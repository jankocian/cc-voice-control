import type { StatusView } from "../lib/status";

export function StatusPanel({ status }: { status: StatusView }) {
  return (
    <section id="statusPanel" class="panel status" data-state={status.dataState} aria-live="polite">
      <div class="status-main">
        <span id="lamp" class={status.lampClass} aria-hidden="true" />
        <div class="status-text">
          <strong id="stateLabel">{status.title}</strong>
          <span id="detailLabel">{status.detail}</span>
        </div>
      </div>
    </section>
  );
}
