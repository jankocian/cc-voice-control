import type { SessionRuntimeState } from "./protocol";

export type StatusKey =
  | "offline"
  | "connecting"
  | "waiting"
  | "recording"
  | "sending"
  | "speaking"
  | "working"
  | "ready"
  | "not-listening";

// data-state on the status panel only uses this reduced set (the offline branches
// and not-listening all map to "offline" visually, exactly as the vanilla client).
export type StatusDataState = "offline" | "ready" | "recording" | "sending" | "speaking" | "working";

export type StatusView = {
  key: StatusKey;
  dataState: StatusDataState;
  lampClass: string;
  title: string;
  detail: string;
  // Whether the user can act (speak / control). Mirrors `canAct = ready && listening`.
  canAct: boolean;
};

export type StatusInputs = {
  connected: boolean; // socket OPEN
  daemonConnected: boolean;
  recording: boolean;
  transcribing: boolean;
  speaking: boolean;
  runtimeState: SessionRuntimeState;
  currentTask: string | undefined;
  listening: boolean;
  // A transient flash overrides the detail line while active.
  flash: string | null;
};

// Pure port of the vanilla `render()` state machine (the ordering of branches is
// load-bearing — it is a priority cascade).
export function deriveStatus(inputs: StatusInputs): StatusView {
  // currentTask is intentionally ignored (see the working branch below).
  const { connected, daemonConnected, recording, transcribing, speaking, runtimeState, listening, flash } = inputs;
  const ready = connected && daemonConnected === true;

  let key: StatusKey = "offline";
  let dataState: StatusDataState = "offline";
  let title: string;
  let detail: string;

  if (!connected) {
    key = "connecting";
    title = "Connecting…";
    detail = "Establishing secure connection";
  } else if (!ready) {
    key = "waiting";
    title = "Waiting for Claude Code";
    detail = "Start the daemon in your terminal";
  } else if (recording) {
    key = "recording";
    dataState = "recording";
    title = "Listening…";
    detail = "Tap to stop";
  } else if (transcribing) {
    key = "sending";
    dataState = "sending";
    title = "Sending…";
    detail = "Transcribing your voice";
  } else if (speaking) {
    key = "speaking";
    dataState = "speaking";
    title = "Speaking";
    // No detail and (in the hero) no title: that the agent is speaking is already
    // obvious from the playing audio + the violet visual. The compact bar still
    // uses `title` as its label.
    detail = "";
  } else if (runtimeState === "working") {
    key = "working";
    dataState = "working";
    title = "Agent is working…";
    // Intentionally NO detail line here: currentTask is the user's full (often very
    // long) transcript, which is noise under the timer. The elapsed clock + title
    // carry the state; a transient flash can still override `detail` below.
    detail = "";
  } else if (!listening) {
    key = "not-listening";
    dataState = "offline";
    title = "Claude isn't listening";
    detail = "Restart with /voice-control:start";
  } else {
    key = "ready";
    dataState = "ready";
    title = "Connected";
    detail = "Ready to help";
  }

  if (flash) detail = flash;

  const lampClass =
    "lamp" +
    (dataState === "ready"
      ? " connected"
      : dataState === "recording"
        ? " recording"
        : dataState === "speaking"
          ? " speaking"
          : dataState === "working" || dataState === "sending"
            ? " working"
            : "");

  const canAct = ready && listening;

  return { key, dataState, lampClass, title, detail, canAct };
}
