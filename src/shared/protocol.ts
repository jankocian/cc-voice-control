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

// One entry of the durable conversation thread the daemon retains (a ring of the last
// few turns). Text only — audio is fetched on demand via `get_audio`, never bundled into
// history (iOS reconnects constantly; re-pushing audio every time would burn bandwidth).
export type HistoryTurn = {
  // Daemon-monotonic sequence number; the phone merges/orders the thread by this.
  seq: number;
  // Creation wall-clock (Date.now()).
  timestamp: number;
  requestId: string;
  role: "user" | "claude";
  text: string;
  // True for a reply whose synthesized audio is still in the ring (fetchable). The phone
  // renders such rows as tap-to-play even before the audio bytes have been requested.
  hasAudio: boolean;
};

export type BrowserToDaemonEvent =
  | { type: "submit_audio"; requestId: string; audioBase64: string; mimeType: string; mode: InjectMode }
  | { type: "status_request"; requestId: string }
  | { type: "summary_request"; requestId: string }
  | { type: "stop_task"; requestId: string }
  // Sent on (re)connect. The daemon answers with a `history` event (the full retained
  // thread), so the phone restores its conversation after a refresh / on a 2nd browser.
  | { type: "sync"; requestId: string }
  // Fetch the audio for a specific reply on demand (tap-to-play on a history row whose
  // bytes aren't cached locally). The daemon answers with a `tts_audio` carrying `replay`.
  | { type: "get_audio"; requestId: string };

export type DaemonToBrowserEvent =
  | { type: "session_status"; state: SessionState; memory: { currentTask?: string } }
  | { type: "transcript"; requestId: string; seq: number; timestamp: number; text: string }
  | { type: "claude_reply"; requestId: string; seq: number; timestamp: number; text: string }
  // `replay` marks a reply re-sent on reconnect: the phone shows it for tap-to-play
  // instead of auto-playing it (a reply the user already missed should not start talking).
  | { type: "tts_audio"; requestId: string; audioBase64: string; mimeType: string; replay?: boolean }
  // The retained thread, sent in response to `sync`. Replaces single-reply replay: the
  // phone reconciles these (text-only) turns to restore history after a refresh / on a
  // 2nd browser, then fetches audio per row on demand.
  | { type: "history"; turns: HistoryTurn[] }
  | { type: "bridge_presence"; daemonConnected: boolean; browserConnected: boolean }
  | { type: "error"; requestId?: string; message: string };

// Daemon → bridge control messages. The worker acts on these instead of relaying them.
export type BridgeControlEvent = { type: "terminate" };

export type BridgeClientRole = "daemon" | "browser";

export type BridgeEnvelope =
  | { channel: "daemon"; event: BrowserToDaemonEvent }
  | { channel: "browser"; event: DaemonToBrowserEvent }
  | { channel: "control"; event: BridgeControlEvent };
