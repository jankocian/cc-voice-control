// Wire protocol shared by the daemon and the phone page. Only the events actually
// exchanged are defined here — the bridge relays these envelopes verbatim.

export type SessionRuntimeState = "idle" | "working";

export type SessionState = {
  sessionId: string;
  // True when the daemon can reach the Claude pane (cmux is healthy). Connection
  // lamps come from `bridge_presence`, not from here — the daemon can't observe the
  // phone's socket, so it never reports connection state it doesn't know.
  listening: boolean;
  state: SessionRuntimeState;
};

// How a spoken message reaches the pane: queue behind the running turn, or interrupt
// the running turn (Esc) and run immediately.
export type InjectMode = "queue" | "interrupt";

export type BrowserToDaemonEvent =
  | { type: "submit_audio"; requestId: string; audioBase64: string; mimeType: string; mode: InjectMode }
  | { type: "status_request"; requestId: string }
  | { type: "summary_request"; requestId: string }
  | { type: "stop_task"; requestId: string }
  // Sent on (re)connect. `lastSeenReplyId` is the requestId of the most recent reply the
  // phone already has, so the daemon can re-send the latest reply only if it was missed
  // (e.g. it arrived while the phone was asleep and no socket was there to receive it).
  | { type: "sync"; requestId: string; lastSeenReplyId?: string };

export type DaemonToBrowserEvent =
  | { type: "session_status"; state: SessionState; memory: { currentTask?: string } }
  | { type: "transcript"; requestId: string; text: string }
  | { type: "claude_reply"; requestId: string; text: string }
  // `replay` marks a reply re-sent on reconnect: the phone shows it for tap-to-play
  // instead of auto-playing it (a reply the user already missed should not start talking).
  | { type: "tts_audio"; requestId: string; audioBase64: string; mimeType: string; replay?: boolean }
  | { type: "bridge_presence"; daemonConnected: boolean; browserConnected: boolean }
  | { type: "error"; requestId?: string; message: string };

// Daemon → bridge control messages. The worker acts on these instead of relaying them.
export type BridgeControlEvent = { type: "terminate" };

export type BridgeClientRole = "daemon" | "browser";

export type BridgeEnvelope =
  | { channel: "daemon"; event: BrowserToDaemonEvent }
  | { channel: "browser"; event: DaemonToBrowserEvent }
  | { channel: "control"; event: BridgeControlEvent };
