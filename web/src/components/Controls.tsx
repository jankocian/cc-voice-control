import type { RefObject } from "preact";
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

export function Controls(props: ControlsProps) {
  const { canAct, recording, transcribing, visualizerActive, pending, canvasRef } = props;
  const voiceLabel = recording ? "Tap to Send" : transcribing ? "Sending…" : "Tap to Speak";

  return (
    <section class="controls">
      <button
        id="voiceButton"
        class={`btn primary${recording ? " recording" : ""}`}
        type="button"
        disabled={!canAct || transcribing}
        onClick={props.onToggleRecord}
      >
        <MicIcon />
        <span id="voiceLabel">{voiceLabel}</span>
      </button>

      <div id="visualizer" class={`visualizer panel${visualizerActive ? " active" : ""}`} aria-hidden="true">
        <canvas id="waveform" ref={canvasRef} />
      </div>

      <div id="sendChoice" class="controls-row two" hidden={!pending}>
        <button id="queueButton" class="btn" type="button" disabled={!canAct} onClick={props.onQueue}>
          Queue it
        </button>
        <button
          id="interruptButton"
          class="btn primary recording"
          type="button"
          disabled={!canAct}
          onClick={props.onInterrupt}
        >
          Interrupt &amp; send
        </button>
      </div>

      <div class="controls-row">
        <button id="summaryButton" class="btn ghost" type="button" disabled={!canAct} onClick={props.onSummary}>
          Get summary
        </button>
        <button id="statusButton" class="btn ghost" type="button" disabled={!canAct} onClick={props.onStatus}>
          Get status
        </button>
        <button id="stopButton" class="btn ghost danger" type="button" disabled={!canAct} onClick={props.onStop}>
          Stop Claude
        </button>
      </div>
    </section>
  );
}
