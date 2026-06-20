// Wire protocol shared by the daemon and the phone page. Only the events actually
// exchanged are defined here — the bridge relays these envelopes verbatim.

// Non-secret, stable per pane: the cmux surface UUID (CMUX_SURFACE_ID), or a per-process
// uuid when launched outside cmux. Safe on the wire and in the DO — it is NOT the session
// secret, just an opaque routing key that attributes every event to one daemon/thread.
export type ThreadId = string;

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
  | { type: "get_audio"; requestId: string }
  // Open a NEW cmux workspace running Claude + /voice-control:start, so it joins this same
  // session as a new thread (same QR). Routed to the ACTIVE thread's daemon, which has the
  // cmux trust to spawn for its machine. `cwd` defaults to the spawning daemon's cwd.
  | { type: "spawn_thread"; cwd?: string; direction?: "right" | "down" };

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
  // `daemonLastSeenAt` is the epoch-ms time a daemon socket last closed for this
  // session (null = a daemon was never seen). It lets the phone distinguish a brief
  // reconnect from a session that ended hours ago: `daemonConnected` is a pure boolean
  // with no time dimension, so the browser grades the "no daemon" state by elapsed time.
  // A clean `/stop` wipes the DO storage, so a terminated session reports null — only an
  // ungraceful drop (laptop sleep/off) leaves a timestamp behind.
  | { type: "bridge_presence"; daemonConnected: boolean; browserConnected: boolean; daemonLastSeenAt: number | null }
  | { type: "error"; requestId?: string; message: string };

// Daemon → bridge control messages. The worker acts on these instead of relaying them.
export type BridgeControlEvent = { type: "terminate" };

export type BridgeClientRole = "daemon" | "browser";

// ---- Thread registry (multi-session) -------------------------------------------------
//
// One machine secret = one URL/QR; every Claude pane's daemon joins the same session as a
// distinct THREAD. The DO is a thread registry: it stores a tiny per-thread roster (label +
// last-seen) and routes by `threadId`, never conversation content (that stays in each
// daemon's history ring).

// A human label for a thread, precomputed by the daemon (see src/daemon/labels.ts). Every
// field is best-effort; `title` is always present (it degrades to "repo · branch", then the
// cwd basename, then the threadId). See computeLabel for the priority order.
export type ThreadLabel = {
  title: string; // the single string shown on the thread chip (most specific available)
  repo?: string; // git repo dir basename (basename of `git rev-parse --show-toplevel`)
  branch?: string; // `git rev-parse --abbrev-ref HEAD`
  cwd?: string; // basename(process.cwd()) — cmux does not expose a per-surface cwd
};

// What a daemon registers / refreshes. `state`/`listening` already exist in session_status;
// the daemon folds them in here too so the roster can grade per-thread presence (reuse #10)
// without the DO having to inspect relayed content.
export type ThreadInfo = {
  threadId: ThreadId;
  label: ThreadLabel;
  state: SessionRuntimeState;
  listening: boolean; // the daemon can reach its cmux pane
};

// A roster entry the DO sends to browsers: the thread's last-registered info plus live
// presence. `connected` = a daemon socket for this threadId is attached right now;
// `lastSeenAt` = epoch-ms its socket last closed (null = currently connected / never gone).
export type RosterThread = ThreadInfo & { connected: boolean; lastSeenAt: number | null };

// Daemon → DO (registry channel): register on connect, refresh as the label/state changes.
export type ThreadRegister = { type: "thread_register"; info: ThreadInfo };

// DO → browser (roster channel): full roster on browser connect; deltas as threads come/go.
export type ThreadRoster = { type: "thread_roster"; threads: RosterThread[] };
export type ThreadJoined = { type: "thread_joined"; thread: RosterThread };
export type ThreadLeft = { type: "thread_left"; threadId: ThreadId; lastSeenAt: number };

export type RegistryEvent = ThreadRegister;
export type RosterEvent = ThreadRoster | ThreadJoined | ThreadLeft;

// The bridge relays these envelopes. `threadId` is the routing key: browser→daemon targets
// the one matching daemon socket; daemon→browser is tagged with the daemon's own threadId so
// the phone files each event under the right thread. Existing event shapes are unchanged —
// only the envelope grew a tag.
export type BridgeEnvelope =
  // browser → ONE thread's daemon (`threadId` = the selected thread).
  | { channel: "daemon"; threadId: ThreadId; event: BrowserToDaemonEvent; threadToken?: string }
  // a thread's daemon → browser(s), tagged with that daemon's threadId.
  | { channel: "browser"; threadId: ThreadId; event: DaemonToBrowserEvent }
  // daemon → DO, unchanged (terminate this thread; the DO expires the session on the last).
  | { channel: "control"; event: BridgeControlEvent }
  // daemon → DO registry (register/refresh this thread's label + state).
  | { channel: "registry"; event: RegistryEvent }
  // DO → browser(s): roster snapshot + join/leave deltas.
  | { channel: "roster"; event: RosterEvent };
