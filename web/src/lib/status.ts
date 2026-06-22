import type { SessionRuntimeState } from "./protocol";

export type StatusKey =
  | "offline"
  | "connecting"
  | "waiting"
  | "reconnecting"
  | "offline-stale"
  | "recording"
  | "sending"
  | "speaking"
  | "working"
  | "ready"
  | "not-listening";

// How long after the daemon was last seen we still treat its absence as a transient
// blip ("Reconnecting…", the laptop is probably just napping). Past this we grade the
// session as genuinely offline. ~90s comfortably covers a brief sleep/Wi-Fi flap while
// still flipping to the honest "Session offline" copy well before a minute feels stale.
export const RECONNECT_GRACE_MS = 90_000;

// data-state on the status panel only uses this reduced set (the offline branches
// and not-listening all map to "offline" visually).
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
  // Epoch-ms time the daemon was last seen by the worker (null = never seen, or our
  // own socket is currently down). Grades the "no daemon" state by elapsed time.
  daemonLastSeenAt: number | null;
  // Current wall clock (epoch ms), injected so deriveStatus stays pure and the UI can
  // tick reconnecting→offline + refresh the "X ago" without any server message.
  now: number;
  recording: boolean;
  transcribing: boolean;
  speaking: boolean;
  runtimeState: SessionRuntimeState;
  currentTask: string | undefined;
  listening: boolean;
  // A transient flash overrides the detail line while active.
  flash: string | null;
};

// The status state machine. The ordering of branches is load-bearing — it is a priority cascade.
export function deriveStatus(inputs: StatusInputs): StatusView {
  // currentTask is intentionally ignored (see the working branch below).
  const {
    connected,
    daemonConnected,
    daemonLastSeenAt,
    now,
    recording,
    transcribing,
    speaking,
    runtimeState,
    listening,
    flash
  } = inputs;
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
    // Socket is OPEN but no daemon. Grade by how long ago the daemon was last seen so
    // an overnight-dead session reads honestly instead of looking like a 2s reconnect.
    if (daemonLastSeenAt == null) {
      // Never connected on this DO — the daemon simply hasn't been started yet.
      key = "waiting";
      title = "Waiting for Claude Code";
      detail = "Start the daemon in your terminal";
    } else if (now - daemonLastSeenAt < RECONNECT_GRACE_MS) {
      // Dropped within the grace window — almost certainly a brief blip (laptop napping,
      // Wi-Fi flap). Stay calm; it usually pops back without the user doing anything.
      key = "reconnecting";
      title = "Reconnecting…";
      detail = "Your laptop may just be napping — hang tight";
    } else {
      // Gone long enough to call it: the session is offline (laptop asleep/off). The pill carries the
      // time-since-last-seen ("Session offline · 14h ago") so the user knows how stale it is at a glance.
      key = "offline-stale";
      dataState = "offline";
      const ago = humanizeAgo(now - daemonLastSeenAt);
      title = `Session offline · ${ago}`;
      detail = `Last active ${ago}. Wake your laptop to resume, or start a new session.`;
    }
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

// The presence dot tone for one thread in the switcher (#7), graded with the SAME offline
// rule as deriveStatus (#10): a thread with no live daemon is "offline" only once it's been
// gone past the grace window — a brief drop still reads as present so a Wi-Fi flap doesn't
// grey every chip. A working thread is coral; a connected idle/ready thread is success.
export type ThreadTone = "success" | "coral" | "faint";

export function gradeThread(inputs: {
  connected: boolean;
  state: SessionRuntimeState;
  listening: boolean;
}): ThreadTone {
  const { connected, state, listening } = inputs;
  // A thread with no live daemon, or one whose daemon can't reach its cmux pane, isn't
  // actionable → grey it (the #10 reconnecting-vs-offline distinction is carried by the active
  // thread's full StatusView/hero; the chip dot only needs reachable-or-not). A reachable
  // thread is coral while working, success when idle/ready.
  if (!connected || !listening) return "faint";
  return state === "working" ? "coral" : "success";
}

// Coarse, human "time ago" for the offline detail line ("just now" / "3m ago" /
// "14h ago" / "2d ago"). Floors to the largest whole unit — precision below a minute
// isn't useful here and "0m ago" would read oddly, so sub-minute is "just now".
export function humanizeAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
