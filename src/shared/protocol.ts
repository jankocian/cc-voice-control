// Wire protocol shared by the daemon and the phone page. Only the events actually
// exchanged are defined here — the bridge relays these envelopes verbatim.

export type SessionRuntimeState = "idle" | "working";

export type SessionState = {
  sessionId: string;
  daemonConnected: boolean;
  browserConnected: boolean;
  // True when the daemon can reach the Claude pane (cmux is healthy). Goes false
  // if injection can't get through, so the phone shows "not listening".
  listening: boolean;
  state: SessionRuntimeState;
  createdAt: number;
  expiresAt: number;
};

export type BrowserToDaemonEvent =
  | { type: "submit_audio"; requestId: string; audioBase64: string; mimeType: string }
  | { type: "status_request"; requestId: string }
  | { type: "summary_request"; requestId: string }
  | { type: "stop_task"; requestId: string };

export type DaemonToBrowserEvent =
  | { type: "session_status"; state: SessionState; memory: { currentTask?: string } }
  | { type: "transcript"; requestId: string; text: string }
  | { type: "claude_reply"; requestId: string; text: string }
  | { type: "tts_audio"; requestId: string; audioBase64: string; mimeType: string }
  | { type: "bridge_presence"; daemonConnected: boolean; browserConnected: boolean }
  | { type: "error"; requestId?: string; message: string };

export type BridgeClientRole = "daemon" | "browser";

export type BridgeEnvelope =
  | { channel: "daemon"; event: BrowserToDaemonEvent }
  | { channel: "browser"; event: DaemonToBrowserEvent };
