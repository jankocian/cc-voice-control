import type { RefObject } from "preact";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { MicIcon } from "./icons";

export type ControlsProps = {
  canAct: boolean;
  recording: boolean;
  transcribing: boolean;
  visualizerActive: boolean;
  pending: boolean;
  canvasRef: RefObject<HTMLCanvasElement>;
  onToggleRecord: () => void;
  onQueue: () => void;
  onInterrupt: () => void;
  onSummary: () => void;
  onStatus: () => void;
  onStop: () => void;
};

// Every control is a shadcn <Button> with an appropriate variant:
//   voice (idle)  → default (the one inverted, emphasised control)
//   voice (rec)   → destructive (red)
//   queue         → secondary
//   interrupt     → destructive
//   summary/status→ ghost
//   stop          → ghost, tinted destructive
// Sizing classes restore the original tall tap targets (mobile-friendly).
const PRIMARY = "min-h-[56px] w-full rounded-[var(--radius)] text-[14px] font-semibold";
const SECONDARY = "min-h-[52px] w-full rounded-[var(--radius)] text-[14px] font-medium";
const GHOST = "min-h-[46px] w-full rounded-[var(--radius)] border border-border text-[13px] font-medium";

export function Controls(props: ControlsProps) {
  const { canAct, recording, transcribing, visualizerActive, pending, canvasRef } = props;
  const voiceLabel = recording ? "Tap to Send" : transcribing ? "Sending…" : "Tap to Speak";

  return (
    <section class="controls">
      <Button
        id="voiceButton"
        type="button"
        variant={recording ? "destructive" : "default"}
        disabled={!canAct || transcribing}
        onClick={props.onToggleRecord}
        class={PRIMARY}
      >
        <MicIcon />
        <span id="voiceLabel">{voiceLabel}</span>
      </Button>

      <Card
        id="visualizer"
        class={`visualizer rounded-[var(--radius)] py-0 shadow-none${visualizerActive ? " active" : ""}`}
        aria-hidden="true"
      >
        <canvas id="waveform" ref={canvasRef} />
      </Card>

      <div id="sendChoice" class="controls-row two" hidden={!pending}>
        <Button
          id="queueButton"
          type="button"
          variant="secondary"
          disabled={!canAct}
          onClick={props.onQueue}
          class={SECONDARY}
        >
          Queue it
        </Button>
        <Button
          id="interruptButton"
          type="button"
          variant="destructive"
          disabled={!canAct}
          onClick={props.onInterrupt}
          class={SECONDARY}
        >
          Interrupt &amp; send
        </Button>
      </div>

      <div class="controls-row">
        <Button
          id="summaryButton"
          type="button"
          variant="ghost"
          disabled={!canAct}
          onClick={props.onSummary}
          class={GHOST}
        >
          Get summary
        </Button>
        <Button
          id="statusButton"
          type="button"
          variant="ghost"
          disabled={!canAct}
          onClick={props.onStatus}
          class={GHOST}
        >
          Get status
        </Button>
        <Button
          id="stopButton"
          type="button"
          variant="ghost"
          disabled={!canAct}
          onClick={props.onStop}
          class={`${GHOST} text-[color:var(--red)] hover:text-[color:var(--red)]`}
        >
          Stop Claude
        </Button>
      </div>
    </section>
  );
}
