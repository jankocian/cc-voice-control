// Wire protocol shared by the daemon and the phone page. The bridge relays these envelopes verbatim and
// CANNOT read their content: conversational events (browser/daemon channels) cross the wire as a sealed
// `enc` blob, and the thread label is sealed too — the worker stores/forwards both opaquely. See e2e.ts.

import type { EncBlob } from "./e2e.js";

// Non-secret, stable per pane: the cmux surface UUID (CMUX_SURFACE_ID), or a per-process
// uuid when launched outside cmux. Safe on the wire and in the DO — it is NOT the session
// secret, just an opaque routing key that attributes every event to one daemon/thread.
export type ThreadId = string;

// "awaiting" = Claude is blocked on the HUMAN (an interactive AskUserQuestion still open, or a permission
// prompt) — not working, not free. Distinct from "idle" so the phone can flag "Claude needs you" instead of
// lying "working" (coral) through a wait. Derived from the transcript (a pending question) + the Notification
// hook (a permission_prompt); see VoiceDaemon.computeState.
export type SessionRuntimeState = "idle" | "working" | "awaiting";

export type SessionState = {
  sessionId: string;
  // True when the daemon can reach the Claude pane (cmux is healthy). Per-thread connection
  // presence comes from the DO roster (`connected`/`lastSeenAt`), not from here — the daemon
  // can't observe the phone's socket, so it never reports connection state it doesn't know.
  listening: boolean;
  state: SessionRuntimeState;
};

// How a spoken message reaches the pane. Both type the message straight in (Claude Code itself queues it
// while busy and ingests it at the next tool boundary — real steering). "interrupt" then presses Esc AFTER
// the text — type+Enter queues it, then Esc propagates that queued message into the stream so Claude runs it
// NOW instead of at the next boundary.
export type InjectMode = "steer" | "interrupt";

// What the daemon auto-plays on a voice turn: nothing, just the final reply, or every step too.
export type SpeakMode = "off" | "final" | "all";

// One option Claude offers for an interactive question (the AskUserQuestion tool). `label` is what's spoken
// and shown (and what the tool records as the answer); `description` is the optional sub-label Claude adds.
export type QuestionOption = { label: string; description?: string };

// One question from Claude's interactive AskUserQuestion tool: the prompt, its options, and whether it
// takes multiple selections. `header` is the short section tag Claude gives it (e.g. "Audio strategy").
export type Question = { header?: string; question: string; multiSelect?: boolean; options: QuestionOption[] };

// An interactive AskUserQuestion turn projected from the transcript. `toolUseId` ties it to the tool call
// (and its eventual answer); `answered` flips once the user's selection (or rejection) lands. `aborted` is
// true when that landing was a REJECTION — Esc in the terminal writes a tool_result with no answers map — so
// the turn ended with NO reply coming and the lamp must settle to idle (isPaneWorking treats an aborted
// question as the concluding turn). Otherwise NOT a final reply: an unanswered question never ends working
// (isPaneWorking skips it) so Claude's later conclusion is still spoken.
export type QuestionPayload = {
  toolUseId: string;
  questions: Question[];
  answered: boolean;
  aborted?: boolean;
  // Answers collected so far for the SEQUENTIAL wizard, daemon-side, while the question is still pending
  // (one per sub-question, in order). The phone presents question[answers.length] next; once it equals
  // questions.length the wizard AUTO-SUBMITS (no confirm) and the phone shows the filled-out wrap-up. Only
  // meaningful on the pending overlay — a submitted/answered question carries its answer as a separate "you"
  // turn, never here.
  answers?: string[];
};

// One conversational turn projected from Claude Code's transcript (see transcript-projection.ts). The
// transcript is the source of truth, so a turn IS a native record: `requestId` is its native `uuid`
// (identity + dedup key) and `timestamp` is its native record time (order key) — both stable across
// daemon restarts, unlike the old daemon-monotonic seq. Text only; audio is fetched on demand via
// `get_audio` (iOS reconnects constantly; re-pushing audio every time would burn bandwidth).
export type HistoryTurn = {
  // The native transcript record uuid. Identity: the phone dedupes by this, so a turn re-sent in a later
  // snapshot is never duplicated, and audio is keyed to it.
  requestId: string;
  // Native record timestamp (epoch ms). The phone orders the thread newest-first by this.
  timestamp: number;
  role: "user" | "claude";
  text: string;
  // True for a reply whose synthesized audio is still retained (fetchable). The phone renders such rows
  // as tap-to-play even before the audio bytes have been requested.
  hasAudio: boolean;
  // A "step": assistant narration written before a tool call (e.g. "I'll read the file first"), vs a
  // user turn or a FINAL reply. The phone shows steps dimmer and never auto-plays them unless the user
  // opted into "read every step" (set_speak_mode "all"). Absent/false for user turns and final replies.
  interim?: boolean;
  // Present iff this turn is Claude's interactive AskUserQuestion prompt — rendered as a SEQUENTIAL wizard
  // (one sub-question at a time, each read aloud), answered by VOICE (each spoken transcript becomes that
  // sub-question's picker custom answer; there is no tap-to-select, by design); the last answer AUTO-SUBMITS
  // them all (no confirm). `text` carries a flattened spoken/displayed rendering for any non-card fallback.
  question?: QuestionPayload;
};

export type BrowserToDaemonEvent =
  | { type: "submit_audio"; requestId: string; audioBase64: string; mimeType: string; mode: InjectMode }
  | { type: "status_request"; requestId: string }
  | { type: "summary_request"; requestId: string }
  | { type: "stop_task"; requestId: string }
  // Sent on (re)connect. The daemon answers with a `history` event (the full retained
  // thread), so the phone restores its conversation after a refresh / on a 2nd browser.
  | { type: "sync"; requestId: string }
  // Fetch the audio for a specific reply/step on demand (tap-to-play on a row whose bytes aren't cached
  // locally). The daemon synthesizes it on demand if needed and answers with a `tts_audio` carrying `replay`.
  | { type: "get_audio"; requestId: string }
  // The phone's autoplay preference for voice turns: "off" speaks nothing (tap-to-play only), "final"
  // speaks just the final reply (default), "all" also speaks each interim step as it appears. Re-sent on
  // connect so the daemon matches the phone's saved preference.
  | { type: "set_speak_mode"; mode: SpeakMode }
  // Open a NEW cmux workspace running Claude + /voice-control:start, so it joins this same
  // session as a new thread (same QR). Routed to the ACTIVE thread's daemon, which has the
  // cmux trust to spawn for its machine. `cwd` defaults to the spawning daemon's cwd.
  | { type: "spawn_thread"; cwd?: string };

export type DaemonToBrowserEvent =
  | { type: "session_status"; state: SessionState; memory: { currentTask?: string } }
  // `replay` marks a reply re-sent on reconnect: the phone shows it for tap-to-play
  // instead of auto-playing it (a reply the user already missed should not start talking).
  | { type: "tts_audio"; requestId: string; audioBase64: string; mimeType: string; replay?: boolean }
  // Streaming TTS: one chunk of a long reply, sent as each piece finishes so audio starts before
  // all chunks are synthesized. `seq` is the 0-based chunk index (chunks arrive in order).
  // The stream ends when `tts_audio` (replay:true) arrives for the same requestId — that caches
  // the full audio for tap-to-play and signals no more chunks are coming. On synthesis failure
  // mid-stream a `tts_status: failed` arrives instead and the phone aborts the stream.
  | { type: "tts_audio_chunk"; requestId: string; seq: number; audioBase64: string; mimeType: string }
  // Audio lifecycle for a reply the daemon is voicing: "pending" while it synthesizes, "failed" if synth
  // errored. Lets the phone show a loading indicator on the message until `tts_audio` lands, and a retry
  // (re-request via get_audio) on failure. Not sent for replies the daemon never voices.
  | { type: "tts_status"; requestId: string; state: "pending" | "failed" }
  // The projected conversation thread, the SINGLE channel for transcript content. The daemon re-projects
  // it from Claude's transcript on every turn event (and on `sync`) and sends the snapshot; the phone
  // reconciles by native uuid + native timestamp, so it self-heals to ground truth and can never drift,
  // duplicate, or reorder. Text only; audio is fetched per row on demand.
  | { type: "history"; turns: HistoryTurn[] }
  // Real, event-driven delivery status for one of the user's OWN prompts, so the phone shows the message
  // the instant Claude Code receives it — not only when the reply (or a step) lands. `text` is the prompt's
  // words: the phone has none for a typed turn, and only the daemon transcribed a voice turn, so the daemon
  // must send them. The phone renders an OPTIMISTIC "you" row from this (WhatsApp-style: one grey check =
  // sent), reconciled away by TEXT once the authoritative native row appears in `history` (which renders
  // "logged" = two coral checks, i.e. picked up into Claude's conversation). Both states show one check;
  // they differ only for the daemon's spinner/resend bookkeeping: "queued" = transcribed/queued for the
  // pane, "accepted" = the agent received it (UserPromptSubmit). ponytail: text-keyed reconcile — at most a
  // few prompts are ever in flight, so a duplicate-phrase collision only drops a placeholder a beat early.
  | { type: "prompt_status"; text: string; state: "queued" | "accepted" }
  // This daemon just spawned a new thread (phone "+" OR the /voice-control:spawn skill). `spawnId`
  // is a one-shot correlation key carried end-to-end (spawn command env → child daemon → its first
  // thread_register → the thread_joined delta), so the phone follows the EXACT new thread — never a
  // ghost or an unrelated reconnect.
  | { type: "spawn_pending"; spawnId: string }
  // End-to-end receipt for a `submit_audio` (echoes its `requestId`), sent the instant the daemon gets it
  // — BEFORE the slow transcription. The relay (DO) doesn't buffer or retry, so a brief network blip can
  // silently drop the audio between phone and daemon; the phone retransmits the same requestId until this
  // ack lands, and the daemon dedups by requestId so a retransmit can never duplicate the prompt.
  | { type: "submit_ack"; requestId: string }
  | { type: "error"; requestId?: string; message: string };

// Daemon → bridge control messages. The worker acts on these instead of relaying them.
//  - `terminate`: end this thread (the DO expires the session on the last one).
//  - `open_claim_window`: explicitly open a device-pairing window (sent on /voice-control:pair). The DO
//    ALSO opens one on its own when an unpaired daemon connects; this is the "add another device" path.
export type BridgeControlEvent = { type: "terminate" } | { type: "open_claim_window" };

// DO → daemon: session-level signal sent right after the daemon connects. Currently just whether a
// device-pairing window is open (the DO auto-opens one when no device is paired yet), so the
// /voice-control:start skill can show "scan to pair" vs "already connected".
export type SessionSignal = { type: "pairing"; open: boolean };

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
  // Present ONLY in a spawned daemon's FIRST register: the spawn correlation id it was launched with
  // (VOICE_SPAWN_ID). Lets the phone follow the exact thread it spawned. Cleared after first register.
  spawnId?: string;
};

// A roster entry the DO sends to browsers: the thread's last-registered info plus live
// presence. `connected` = a daemon socket for this threadId is attached right now;
// `lastSeenAt` = epoch-ms its socket last closed (null = currently connected / never gone).
export type RosterThread = ThreadInfo & { connected: boolean; lastSeenAt: number | null };

// ---- app vs wire (the label is sealed on the wire) -----------------------------------
//
// `ThreadInfo`/`RosterThread`/the registry+roster events above are the DECRYPTED (app) shapes the daemon
// computes and the phone displays. On the wire — and in the worker's storage — the label is a sealed
// `EncBlob` the worker can't read; the `Wire*` shapes below are what actually cross the socket. The
// daemon seals its label before sending; the phone opens it back into a `ThreadLabel` before display.
export type WireThreadInfo = Omit<ThreadInfo, "label"> & { label: EncBlob };
export type WireRosterThread = Omit<RosterThread, "label"> & { label: EncBlob };

// Daemon → DO (registry channel): register on connect, refresh as the label/state changes.
export type ThreadRegister = { type: "thread_register"; info: ThreadInfo };
export type WireThreadRegister = { type: "thread_register"; info: WireThreadInfo };

// DO → browser (roster channel): full roster on browser connect; deltas as threads come/go.
export type ThreadRoster = { type: "thread_roster"; threads: RosterThread[] };
export type ThreadJoined = { type: "thread_joined"; thread: RosterThread };
export type ThreadLeft = { type: "thread_left"; threadId: ThreadId; lastSeenAt: number };
export type WireThreadRoster = { type: "thread_roster"; threads: WireRosterThread[] };
export type WireThreadJoined = { type: "thread_joined"; thread: WireRosterThread };

export type RegistryEvent = ThreadRegister;
export type RosterEvent = ThreadRoster | ThreadJoined | ThreadLeft;
export type WireRegistryEvent = WireThreadRegister;
export type WireRosterEvent = WireThreadRoster | WireThreadJoined | ThreadLeft;

// The bridge relays these envelopes. `threadId` is the routing key: browser→daemon targets the one
// matching daemon socket; daemon→browser is tagged with the daemon's own threadId so the phone files
// each event under the right thread. Conversational content (browser/daemon channels) is a sealed
// `enc` blob — the worker routes by channel/threadId without ever reading it (see e2e.ts). Control is
// plaintext (no content); registry/roster are structural with the label sealed inside.
export type BridgeEnvelope =
  // browser → ONE thread's daemon (`threadId` = the selected thread); sealed BrowserToDaemonEvent.
  | { channel: "daemon"; threadId: ThreadId; enc: EncBlob }
  // a thread's daemon → browser(s), tagged with that daemon's threadId; sealed DaemonToBrowserEvent.
  | { channel: "browser"; threadId: ThreadId; enc: EncBlob }
  // daemon → DO (terminate this thread / open a pairing window). No content; the DO acts on it.
  | { channel: "control"; event: BridgeControlEvent }
  // DO → daemon: session-level signal (e.g. whether a pairing window is open). No content.
  | { channel: "session"; event: SessionSignal }
  // daemon → DO registry (register/refresh this thread's sealed label + plaintext state).
  | { channel: "registry"; event: WireRegistryEvent }
  // DO → browser(s): roster snapshot + join/leave deltas (sealed labels).
  | { channel: "roster"; event: WireRosterEvent };
