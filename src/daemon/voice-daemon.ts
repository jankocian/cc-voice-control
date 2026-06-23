import { randomUUID } from "node:crypto";
import { type FSWatcher, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { BRIDGE_DAEMON_KEY_HEADER } from "../shared/bridge-contract.js";
import { aad, deriveKey, type EncBlob, openJson, sealJson } from "../shared/e2e.js";
import type {
  BridgeEnvelope,
  BrowserToDaemonEvent,
  DaemonToBrowserEvent,
  InjectMode,
  SessionRuntimeState,
  SessionSignal,
  SessionState,
  SpeakMode,
  ThreadId,
  ThreadInfo,
  WireThreadInfo
} from "../shared/protocol.js";
import { isVoiceAnswerable } from "../shared/protocol.js";
import { createSerializer } from "../shared/serialize.js";
import { startBridgeHeartbeat } from "./bridge-heartbeat.js";
import { cmuxAnswerQuestion, cmuxHealth, cmuxInterrupt, cmuxSubmit, spawnWorkspace } from "./cmux.js";
import {
  loadOrCreateSession,
  qrPath,
  runtimeDir,
  stateDir,
  threadRuntimePath,
  toBrowserUrl,
  toWebSocketUrl,
  type VoiceRemoteConfig
} from "./config.js";
import { computeLabel } from "./labels.js";
import { synthesizeSpeech, transcribeAudio } from "./openai.js";
import { renderQr } from "./qr.js";
import { buildClaudeSpawnCommand, PERMISSION_MODES } from "./spawn-command.js";
import {
  dropSessionAnnouncement,
  isPaneWorking,
  normalizeQuestions,
  type ProjectedTurn,
  pendingQuestion,
  questionContentSig,
  questionSpeech
} from "./transcript-projection.js";
import { projectTranscript } from "./transcript-reader.js";
import { TurnCoordinator } from "./turn-coordinator.js";

type Audio = { audioBase64: string; mimeType: string };

// Reconnect backoff for transient bridge drops (a terminal 1008 close is handled separately).
const RECONNECT_DELAY_MS = 1500;
// How many recent submit_audio requestIds we remember for dedup (bounds the set; see rememberBounded).
const MAX_HANDLED_SUBMITS = 200;
// Bridge keepalive interval. Pinging well under any network/NAT idle timeout keeps the socket warm and
// catches a half-open drop within ~2 ticks (see bridge-heartbeat.ts). Cheap: Cloudflare auto-pongs
// without waking the hibernated Durable Object.
const BRIDGE_PING_INTERVAL_MS = 25_000;
// How often the daemon re-resolves its cmux pane so `listening` self-heals.
const CMUX_HEALTH_INTERVAL_MS = 5000;
// How long to treat a pairing window as open locally before flipping the runtime `pairing` flag back —
// mirrors the worker's CLAIM_WINDOW_MS. Display-only (drives the start/status wording), so it need not
// match to the millisecond.
const PAIRING_WINDOW_MS = 90_000;
// Safety ceiling on speech length (synthesizeSpeech chunks past the per-call TTS limit) so a runaway
// reply can't fan out into unbounded TTS calls. Far above any real reply; ~40k ≈ 10 chunks.
const MAX_SPEECH_CHARS = 40_000;
// Cap the projected thread (newest turns) sent to the phone, and the synthesized reply audio retained for
// tap-to-play, so neither grows unbounded over a long session.
const MAX_PROJECTED_TURNS = 40;
const MAX_AUDIO_ENTRIES = 20;
// Cap the set of already-seen reply/step uuids (the dedup guard against re-synthesizing on re-projection).
// It tracks more uuids than we keep audio for — every interim step a long turn sees, plus replies — so
// it's a multiple of the audio cap rather than equal to it.
const SEEN_UUID_CAP = MAX_AUDIO_ENTRIES * 4;
// The phone mirrors the transcript via a SELF-HEALING LIVE TAIL (see armWatch): one fs.watch re-syncs on
// every write, debounced so a burst coalesces into one re-projection. This is the whole fix for "the hook
// fired before Claude flushed the record" — we react to the file write, not to hook timing, so a user
// prompt, a step before a tool call, or an answer that streams in seconds-to-minutes after the Stop hook
// (extended thinking: the thinking block flushes as its own `end_turn` record first) all reach the phone
// the instant they land, never one event behind. ~150ms reads as instant while collapsing tool-output floods.
// fs.watch on the file is reliable for every write pattern (verified); the only fragility was the watch going
// DEAD — its file replaced (/clear, /compact → a new session file) or not yet created at arm time (a fresh
// session's first record flushes AFTER its hook). So the watch re-arms itself; there is NO backup poll.
const SYNC_DEBOUNCE_MS = 150;
// How soon to re-arm the watch after it dies (file replaced/rotated) or fails to arm because the target file
// isn't there yet. Short, so a fresh session's tail arms within a beat of the file appearing. Only runs during
// that brief window — once armed there is no timer at all (an idle daemon does zero work).
const WATCH_REARM_MS = 250;

// Plugin-load root, three dirs up from this module either way (dist/daemon or src/daemon). Only used
// to point a spawned `claude` at a `--plugin-dir`-loaded (dev) plugin.
const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Dev loads the plugin via `--plugin-dir` (Claude Code marks it with an `-inline` data dir); an
// installed plugin is global, so the flag is omitted. Pass the dir only for an inline (dev) load.
const SPAWN_PLUGIN_DIR = stateDir().endsWith("-inline") ? PLUGIN_ROOT : undefined;

export type DaemonInit = {
  config: VoiceRemoteConfig;
  surface?: string;
  // Non-secret per-pane routing key (CMUX_SURFACE_ID, or a uuid outside cmux). Tags every event; a
  // reconnecting pane re-registers to the SAME slot. NOT the session secret.
  threadId: ThreadId;
  // The MACHINE-level secret (session.json). Shared by every pane → identical phone URL/QR. It rides
  // in the URL FRAGMENT (never sent to the worker) and is the key the phone and daemon derive their
  // end-to-end encryption key from. The daemon never sends it to the bridge.
  secret: string;
  // Daemon-role auth secret (session.json, never in any URL). Sent as a connect header so the bridge can
  // tell the real local daemon apart from a leaked-URL holder (who has `secret` but not this).
  daemonKey: string;
  // Short non-secret hash of `secret` (sha256[:8]) — the session handle: routes the DO and is the
  // visible id in the URL path. Safe to relay/log.
  sessionId: string;
  browserUrl: string;
};

/** Build the daemon init from config + the current cmux pane (threadId = CMUX_SURFACE_ID, or a uuid
 *  outside cmux). The secret is the SHARED machine secret, so every pane derives the same URL/QR. */
export function createDaemonInit(config: VoiceRemoteConfig): DaemonInit {
  const surface = process.env.CMUX_SURFACE_ID;
  const threadId = surface ?? randomUUID();
  const { secret, sessionId, daemonKey } = loadOrCreateSession();
  const browserUrl = toBrowserUrl(config.bridgeUrl, sessionId, secret);
  return { config, surface, threadId, secret, daemonKey, sessionId, browserUrl };
}

/**
 * Voice daemon for the cmux-hosted Claude Code session. Phone speaks → STT → `cmux send` types it
 * into the live pane; the Stop hook POSTs Claude's reply back → TTS → phone. The real interactive
 * session, no turn-hijack. Runs INSIDE Claude Code's process tree (a background Bash task), so it
 * keeps cmux's socket trust and dies with the session (a detached process would lose both). Logs to
 * stderr (teed to ${stateDir}/daemon.log); the entry point reserves stdout for its banner.
 */
export class VoiceDaemon {
  private readonly init: DaemonInit;
  private ws?: WebSocket;
  private httpServer?: Server;
  private port = 0;
  // `cmuxHealthy` drives the "listening" lamp: optimistic (starts true), drops only on a POSITIVE
  // "pane gone" verdict. `cmuxReachable` tracks the socket separately, just to log transitions.
  private cmuxHealthy = true;
  private cmuxReachable = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private healthTimer?: ReturnType<typeof setInterval>;
  // Stops the current bridge socket's ping/pong keepalive; re-armed on every (re)connect.
  private stopHeartbeat?: () => void;
  private stopped = false;

  // Device pairing. The BRIDGE decides when a pairing window opens — automatically when an unpaired
  // daemon connects, never on a mere reconnect or an extra pane (so a leaked URL can't pair via a
  // restart). `/voice-control:pair` is the only daemon-initiated open: an explicit "add another device"
  // even though one is already paired. If the socket is mid-reconnect when it's pressed, defer to the
  // next connect. `pairingOpen` mirrors the bridge's signal (is a window open right now?) so the
  // start/status skills can show the right message; it's surfaced in the runtime file.
  private pairWindowRequested = false;
  // null until the bridge signals on connect — so the start skill can wait for the settled value rather
  // than racing the initial runtime-file write.
  private pairingOpen: boolean | null = null;
  private pairingTimer?: ReturnType<typeof setTimeout>;

  // The voice injection queue + idle-gate (inject one spoken prompt at a time while Claude is idle). It
  // does NOT own the working lamp — that's DERIVED from the transcript (see isWorking) so it self-heals and
  // can never stick. See turn-coordinator.ts.
  private readonly turns: TurnCoordinator;

  // Last derived runtime state (idle/working/awaiting), cached so buildThreadInfo (and any registerThread
  // caller) reflects it without re-reading the transcript. Authoritatively recomputed in emitStatus.
  private lastState: SessionRuntimeState = "idle";

  // The ONLY state we keep of our own; everything the phone shows is projected from Claude's transcript.
  //  - `audio`: synthesized reply audio keyed by native reply uuid, for tap-to-play + reconnect.
  //  - `lastTranscriptPath`: the transcript the hooks last pointed us at, so `sync` can re-project without
  //    a hook firing.
  //  - `seen`: claude reply/step uuids we've already processed, so re-projecting on every event never
  //    double-synthesizes. There is NO prompt→reply matching: every reply the projection shows is a
  //    candidate for audio, keyed by its own native uuid — the one source of truth for both text and audio.
  //  - `floor`: epoch ms below which projected turns are hidden (set on /clear|/compact so a new topic
  //    doesn't show the previous one still sitting in the transcript tail).
  //  - `seeded`: false until the first projection establishes a baseline. The replies already in the
  //    transcript when we first look (the tail shown on a (re)start) are recorded as seen but NOT
  //    synthesized — they stay tap-to-playable. Only replies we watch land AFTER that auto-synthesize, so
  //    a (re)connect can never blast a wall of TTS for old history.
  private readonly audio = new Map<string, Audio>();
  private lastTranscriptPath?: string;
  private readonly seen = new Set<string>();
  private floor = 0;
  private seeded = false;

  // requestIds of `submit_audio`s we've already handled, so a phone RETRANSMIT (same requestId, sent when
  // its end-to-end ack didn't arrive — e.g. a network blip dropped the audio at the relay) is acked again
  // but NOT processed twice. Bounded (oldest dropped past the cap); a process restart clears it, which is
  // safe — a restarted daemon never processed the prior copy. See submit_ack in the protocol.
  private readonly handledSubmits = new Set<string>();

  // The live tail on the active transcript (see armWatch): the SINGLE mechanism that keeps the phone current —
  // a self-healing fs.watch, no backup poll. `transcriptWatcher`/`watchedPath` are the watch + which file it's
  // on; `rearmTimer` re-arms it when its file is replaced/rotated or isn't created yet; `syncDebounce`
  // coalesces a burst of writes; `lastHistorySig` lets the tail skip re-sending an unchanged thread (tool
  // output that adds no conversational turn must not re-flood the wire).
  private transcriptWatcher?: FSWatcher;
  private watchedPath?: string;
  private syncDebounce?: ReturnType<typeof setTimeout>;
  private rearmTimer?: ReturnType<typeof setTimeout>;
  private lastHistorySig = "";
  // True while a spoken answer is being typed into an AskUserQuestion picker, so a second utterance arriving
  // during the STT+send window can't re-type into the same picker (the answered state derives from the
  // transcript, which may not have flushed when the first send completes).
  private answeringQuestion = false;
  // The PENDING interactive question, surfaced from the PreToolUse hook because Claude does NOT write the
  // AskUserQuestion record to the transcript until it's answered — so the projection alone can't show it while
  // the user still needs to answer. projectedNow() injects this synthetic turn until the same question (by
  // content) appears in the transcript, then yields. Cleared on a new turn / reset / once the answer is sent.
  private pendingQuestionOverlay?: ProjectedTurn;
  // The phone's autoplay preference for VOICE turns: "off" speaks nothing, "final" speaks just the final
  // reply (default — the prior behaviour), "all" also speaks each interim step. Tap-to-play works in every
  // mode. Set via set_speak_mode.
  private speakMode: SpeakMode = "final";

  // The spawning session's LIVE permission mode (forwarded each turn by the turn-open hook). A spawn
  // launches with `--permission-mode <this>` so it inherits the user's mode EXACTLY (env won't carry
  // it). Undefined until the first turn → a spawn before then falls back to the user's default.
  private inheritedPermissionMode?: string;

  // If THIS daemon was spawned (phone "+"/skill) it carries a VOICE_SPAWN_ID. Sent once in the FIRST
  // thread_register so the phone follows the exact thread it asked for, then cleared.
  private pendingSpawnId = process.env.VOICE_SPAWN_ID;

  // Last-computed thread label (repo·branch·cwd · cmux title). Sent in thread_register and refreshed
  // on the health tick when it changes; starts with a cheap sync fallback so registration never blocks.
  private label: ThreadInfo["label"];

  // End-to-end encryption: the AES key derived from the session secret (the worker never has it), and
  // the SEALED label cached so the (sync) registerThread can send it without awaiting. Outbound content
  // is sealed through a serializer so concurrent sends keep their order (a history snapshot must not be
  // overtaken by a later one). Both set in start() before the first send.
  private key!: CryptoKey;
  private sealedLabel!: EncBlob;
  private readonly enqueueSeal = createSerializer();
  // Order inbound decrypts so commands DISPATCH in arrival order (a slow audio decrypt mustn't let a
  // later command overtake it) — parity with the plaintext path before E2E. Handlers still run
  // concurrently once dispatched.
  private readonly enqueueRecv = createSerializer();

  constructor(init: DaemonInit) {
    this.init = init;
    this.label = { title: init.threadId };
    this.turns = new TurnCoordinator({
      inject: (text) => this.injectIntoPane(text),
      onStatusChange: () => this.emitStatus(),
      log: (message) => console.error(message)
    });
  }

  get browserUrl(): string {
    return this.init.browserUrl;
  }

  async start(): Promise<void> {
    // Derive the E2E key + seal the initial label BEFORE connecting, so the first thread_register (sent
    // synchronously on socket open) already carries a sealed label and content can be sealed immediately.
    this.key = await deriveKey(this.init.secret);
    this.sealedLabel = await this.sealLabel(this.label);
    await this.startHookListener();
    this.writeRuntime();
    this.connectBridge();
    console.error(
      `voice-remote ready. cmux surface=${this.init.surface ?? "(none — CMUX_SURFACE_ID was not set!)"} hookPort=${this.port}`
    );
    console.error(`Phone URL: ${this.init.browserUrl}`);
    // Monitor cmux without blocking startup — a hung/missing cmux must not prevent
    // the daemon from coming up and showing the phone URL.
    this.startCmuxMonitor();
  }

  // ---- cmux liveness (optimistic + self-healing) ----------------------------

  // Re-resolve the cmux pane on a timer so `listening` self-heals. OPTIMISTIC: drop to "not listening"
  // only on a POSITIVE pane-gone verdict — a merely-unreachable socket stays listening (locking out on
  // an ambiguous blip was a real bug; a true outage surfaces on the next failed injection). SELF-HEALING:
  // the surface ref survives a workspace move, so a re-probe recovers on its own.
  private startCmuxMonitor(): void {
    void this.refreshCmuxHealth();
    this.healthTimer = setInterval(() => void this.refreshCmuxHealth(), CMUX_HEALTH_INTERVAL_MS);
  }

  private async refreshCmuxHealth(): Promise<void> {
    // Fold the label refresh into the existing tick (the cmux title tracks the running task)
    // instead of adding a second timer; it re-registers only when something actually changed.
    void this.refreshLabel();
    const health = await cmuxHealth(this.init.surface);
    if (health.socketUp !== this.cmuxReachable) {
      this.cmuxReachable = health.socketUp;
      console.error(
        health.socketUp
          ? "[cmux] control socket reachable again"
          : "WARNING: cmux control socket unreachable this tick — staying optimistic (injection will surface any real failure)."
      );
    }
    // listening is false ONLY on a POSITIVE "pane gone" verdict (surfaceAlive===false).
    // A reachable pane, an unknown probe, or a down socket all stay optimistic.
    const healthy = health.surfaceAlive !== false;
    if (healthy === this.cmuxHealthy) return; // only emit on change
    this.cmuxHealthy = healthy;
    console.error(
      healthy
        ? "[cmux] pane reachable — listening"
        : "WARNING: the Claude pane is no longer reachable in cmux (closed?) — restart /voice-control:start in a live pane."
    );
    this.emitStatus();
  }

  // ---- local listener for the Stop hook -------------------------------------

  private startHookListener(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        // POST routes from the plugin's hooks/skills: /turn-open (UserPromptSubmit → a turn started,
        // with the REAL pre-expansion prompt + live permission mode), /turn-close (Stop → the turn's
        // reply), /notify (Notification → permission_prompt = "awaiting", idle_prompt = 60s idle floor),
        // /reset (SessionStart on clear/compact → wipe history), /spawn (the spawn skill).
        const route = req.method === "POST" ? req.url : undefined;
        if (
          route !== "/turn-open" &&
          route !== "/turn-progress" &&
          route !== "/turn-close" &&
          route !== "/notify" &&
          route !== "/reset" &&
          route !== "/pair" &&
          route !== "/spawn"
        ) {
          res.statusCode = 404;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          // /spawn answers with the result so the agent can report where the new session opened;
          // the other routes are fire-and-forget (acked immediately).
          if (route === "/spawn") {
            void this.handleSpawnRequest(body, res);
            return;
          }
          res.statusCode = 204;
          res.end();
          if (route === "/reset") {
            this.handleReset();
            return;
          }
          if (route === "/pair") {
            this.openPairWindow();
            return;
          }
          try {
            if (route === "/turn-open") {
              const { transcriptPath, prompt, permissionMode } = JSON.parse(body || "{}") as {
                transcriptPath?: string;
                prompt?: string;
                permissionMode?: string;
              };
              // Remember the live permission mode so a spawn during this turn inherits it EXACTLY.
              if (typeof permissionMode === "string" && PERMISSION_MODES.has(permissionMode)) {
                this.inheritedPermissionMode = permissionMode;
              }
              this.setTranscript(transcriptPath); // point the live tail at this turn's transcript
              this.pendingQuestionOverlay = undefined; // a new turn supersedes any prior pending question
              const realPrompt = typeof prompt === "string" ? prompt : "";
              this.turns.turnOpened(realPrompt);
              // Claude Code RECEIVED the prompt (this is its UserPromptSubmit) → tell the phone NOW so the
              // message shows instantly with a single check, rather than only when the reply lands. Works for
              // a typed turn too (the daemon otherwise never knew its text). The authoritative native row
              // (its uuid → audio + the "logged" two-check) follows from the transcript via the live tail.
              this.emitPromptAccepted(realPrompt);
              this.syncFromTranscript();
            } else if (route === "/turn-progress") {
              // PreToolUse: Claude is about to run a tool, so it just wrote a step (narration). Re-sync from
              // the transcript; the live tail also catches the step if it flushes a beat after this hook.
              const { transcriptPath, question } = JSON.parse(body || "{}") as {
                transcriptPath?: string;
                question?: { toolUseId?: string; questions?: unknown };
              };
              this.setTranscript(transcriptPath);
              this.turns.noteProgress(); // a tool is running → no longer parked on a permission prompt
              // AskUserQuestion fired: the question is in THIS hook's payload, not the transcript (Claude
              // doesn't flush it until answered). Surface it live as a pending-question overlay.
              if (question) this.setPendingQuestion(question.toolUseId ?? "", question.questions);
              this.syncFromTranscript();
            } else if (route === "/notify") {
              // Notification hook: "permission" = a permission_prompt fired (Claude blocked on the user's
              // approval → "awaiting"); "idle" = idle_prompt (60s+ idle → a floor that clears a stuck-busy
              // lamp if a Stop was dropped). emitStatus re-projects, so the transcript still has final say.
              const { kind } = JSON.parse(body || "{}") as { kind?: string };
              if (kind === "permission") this.turns.notePermissionPrompt();
              else if (kind === "idle") this.turns.forceIdle();
            } else {
              // Stop: the turn ended. Release the idle-gate (so a queued voice prompt can inject) and re-sync.
              // The reply text may still be streaming in (extended thinking) — the live tail shows/speaks it
              // the instant it flushes, so there is nothing to wait for here.
              const { transcriptPath } = JSON.parse(body || "{}") as { transcriptPath?: string };
              this.setTranscript(transcriptPath);
              this.turns.turnClosed();
              this.syncFromTranscript();
            }
          } catch {
            // ignore malformed hook payloads
          }
        });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        this.port = typeof address === "object" && address ? address.port : 0;
        this.httpServer = server;
        resolve();
      });
    });
  }

  private writeRuntime(): void {
    mkdirSync(runtimeDir(), { recursive: true });
    // Render the QR (machine-level — identical bytes for every pane, since the URL is a pure
    // function of the shared secret) before the runtime file so it's present once the start
    // skill reads it. A render failure must never block the URL, so it's best-effort.
    try {
      writeFileSync(qrPath(), `${renderQr(this.init.browserUrl)}\n`);
    } catch (error) {
      console.error(`[qr] render failed: ${errText(error)}`);
    }
    // Per-thread runtime file (runtime/<surfaceId>.json) so panes don't clobber each other's
    // port/pid and this pane's Stop/reset hooks reach THIS daemon. `pairing` mirrors the bridge's signal
    // (is a pairing window open right now?) so the start/status skills know whether scanning pairs a new
    // device; it starts false and is rewritten when the bridge tells us on connect.
    writeFileSync(
      threadRuntimePath(this.init.surface),
      JSON.stringify(
        {
          port: this.port,
          pid: process.pid,
          surface: this.init.surface ?? null,
          sessionUrl: this.init.browserUrl,
          pairing: this.pairingOpen
        },
        null,
        2
      )
    );
  }

  // The bridge signalled whether a pairing window is open (it auto-opens one for an unpaired session).
  // Cache it + rewrite the runtime file so the start/status skills show the right message. When a window
  // opens, also arm a timer to flip the flag back when it expires unused — the bridge enforces expiry
  // lazily by timestamp and doesn't signal the close, so without this the runtime flag could read
  // stale-open. A successful pair signals `false` sooner (which clears the timer).
  private setPairingOpen(open: boolean): void {
    if (this.pairingTimer) {
      clearTimeout(this.pairingTimer);
      this.pairingTimer = undefined;
    }
    if (open) this.pairingTimer = setTimeout(() => this.setPairingOpen(false), PAIRING_WINDOW_MS);
    if (this.pairingOpen === open) return;
    this.pairingOpen = open;
    if (this.port) this.writeRuntime();
  }

  // Handle a /reset POST (SessionStart on clear/compact): a new topic in the SAME pane. Raise the
  // projection floor to now so the previous topic — still sitting in the transcript tail — is hidden, drop
  // our voice state, and push the (now empty) projection so the phone clears the stale thread.
  private handleReset(): void {
    this.floor = Date.now();
    this.audio.clear();
    this.seen.clear();
    this.pendingQuestionOverlay = undefined;
    // /clear or /compact ends the current topic: drop every in-flight/queued/open turn (so a stale
    // turn can't be injected or wedge the idle-gate) — reset() also re-emits idle status.
    this.turns.reset();
    console.error("[reset] cleared voice history for this thread (/clear or /compact)");
    this.syncFromTranscript();
  }

  // Handle a /pair POST (the /voice-control:pair skill): open a device-pairing window so an additional
  // phone can claim a device cookie. Sent now if the bridge socket is up, else deferred to the next
  // connect (so `pair` works even during a brief reconnect).
  private openPairWindow(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.requestClaimWindow();
      console.error("[pair] opened a device-pairing window");
    } else {
      this.pairWindowRequested = true;
      console.error("[pair] bridge socket down — pairing window will open on reconnect");
    }
  }

  // Ask the DO to open a device-pairing window (the one control message both the first-connect path and
  // /voice-control:pair emit).
  private requestClaimWindow(): void {
    this.send({ channel: "control", event: { type: "open_claim_window" } });
  }

  // ---- bridge ----------------------------------------------------------------

  private connectBridge(): void {
    if (this.stopped) return;
    // Pass the threadId on the connect URL so the DO attaches it before the first message —
    // browser→daemon routing keys on it from the very first send.
    const url = toWebSocketUrl(this.init.config.bridgeUrl, this.init.sessionId, "daemon", this.init.threadId);
    // Authenticate the daemon role with the machine-local daemonKey (never in the URL), via a header so
    // it stays out of access logs. The bridge pins it on first connect (trust-on-first-use).
    const ws = new WebSocket(url, { headers: { [BRIDGE_DAEMON_KEY_HEADER]: this.init.daemonKey } });
    this.ws = ws;

    ws.on("open", () => {
      // Register this thread with the DO (so the roster lists it) BEFORE the first status, then
      // refresh the label asynchronously — git/cmux must never block the socket coming up.
      this.registerThread();
      this.emitStatus();
      void this.refreshLabel();
      // The bridge auto-opens a pairing window when this session has no paired device. The only window
      // the daemon opens itself is an explicit /voice-control:pair that was pressed while the socket was
      // down (deferred to now). Plain reconnects never open one.
      if (this.pairWindowRequested) {
        this.pairWindowRequested = false;
        this.requestClaimWindow();
      }
      // Keep this socket alive + detect a half-open drop (zombie OPEN that never fires close).
      this.stopHeartbeat = startBridgeHeartbeat(ws, BRIDGE_PING_INTERVAL_MS);
    });
    ws.on("message", (raw) => {
      let envelope: { channel?: string; threadId?: ThreadId; enc?: EncBlob; event?: SessionSignal };
      try {
        envelope = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // The bridge tells us whether a pairing window is currently open (it decides, based on whether a
      // device is paired). Surface it so the start/status skills show the right message.
      if (envelope.channel === "session" && envelope.event?.type === "pairing") {
        this.setPairingOpen(envelope.event.open);
        return;
      }
      // Only act on events addressed to THIS thread (the DO routes browser→one daemon by threadId, but
      // guard here too so a mis-tagged envelope can't drive the wrong pane). The payload is sealed —
      // decrypt with the shared key; a decryption failure means tampered/foreign data, so ignore it.
      if (envelope.channel === "daemon" && envelope.enc && envelope.threadId === this.init.threadId) {
        const enc = envelope.enc;
        this.enqueueRecv(async () => {
          let event: BrowserToDaemonEvent;
          try {
            event = await openJson<BrowserToDaemonEvent>(this.key, enc, aad("daemon", this.init.threadId));
          } catch (error) {
            console.error(`[e2e] dropped an undecryptable browser message: ${errText(error)}`);
            return;
          }
          this.handleBrowserEvent(event).catch((error) => this.sendError(error));
        });
      }
    });
    ws.on("close", (code) => {
      this.stopHeartbeat?.();
      this.stopHeartbeat = undefined;
      if (this.stopped || this.ws !== ws) return;
      this.ws = undefined;
      // 1008 = the bridge ended the session. Reconnecting would just be rejected, so
      // treat it as terminal rather than hot-looping forever.
      if (code === 1008) {
        this.stopped = true;
        return;
      }
      this.reconnectTimer = setTimeout(() => this.connectBridge(), RECONNECT_DELAY_MS);
    });
    ws.on("error", () => {
      /* the close handler decides whether to reconnect */
    });
  }

  private async handleBrowserEvent(event: BrowserToDaemonEvent): Promise<void> {
    switch (event.type) {
      case "submit_audio":
        // Ack receipt FIRST (before the slow transcription) so the phone stops retransmitting; a duplicate
        // requestId (a retransmit whose earlier ack was lost) is re-acked but skipped — idempotent.
        this.sendToBrowser({ type: "submit_ack", requestId: event.requestId });
        if (!rememberBounded(this.handledSubmits, event.requestId, MAX_HANDLED_SUBMITS)) return;
        await this.handleAudio(event.audioBase64, event.mimeType, event.mode);
        return;
      case "status_request":
        this.queueVoice("Give me a brief spoken status of what you're doing right now.", "queue");
        return;
      case "summary_request":
        this.queueVoice("Briefly summarize what you've done so far, for the phone.", "queue");
        return;
      case "stop_task":
        // Esc the running turn → Claude goes idle; the coordinator drops every open turn and drains
        // the queue (a late Stop for a dropped turn lands on an empty FIFO and is ignored). A pending
        // question is dismissed by the Esc, so drop its overlay too.
        await cmuxInterrupt(this.init.surface);
        this.turns.interrupt();
        this.pendingQuestionOverlay = undefined;
        this.syncFromTranscript();
        return;
      case "sync":
        // The phone (re)connected and wants the current state. Replaces a heartbeat (the daemon otherwise
        // emits status only on change, which a fresh phone misses) and re-sends the thread so a refresh /
        // 2nd browser restores it. Only sync once we know the transcript path: a `history` snapshot is
        // authoritative (the phone replaces with it), so emitting an empty one before the first hook of a
        // freshly-(re)started daemon would wipe the phone's thread. syncFromTranscript also re-speaks a voice
        // reply we never got to (its answer landed while the phone was away) — idempotent via `spoken`.
        if (this.lastTranscriptPath) this.syncFromTranscript();
        else this.emitStatus();
        return;
      case "get_audio":
        // Tap-to-play on a row whose audio isn't cached: serve it, synthesizing on demand for a step (we
        // don't pre-synthesize every step), or tell the phone gracefully if the row is gone from the tail.
        await this.serveAudio(event.requestId);
        return;
      case "set_speak_mode":
        if (event.mode === "off" || event.mode === "final" || event.mode === "all") this.speakMode = event.mode;
        return;
      case "spawn_thread": {
        // The phone "+" : open a NEW cmux workspace running Claude + /voice-control:start. It reads
        // the same session.json → joins this same session as a new thread (same QR). Routed here
        // because this daemon has the cmux trust to spawn for the machine.
        const result = await this.spawnThread(event.cwd);
        if (!result.ok) {
          this.sendToBrowser({ type: "error", message: "Couldn't open a new session (cmux new-workspace failed)." });
        }
        return;
      }
      default:
        return;
    }
  }

  // Spawn a sibling thread via a new cmux workspace (cwd defaults to this daemon's). The spawned pane's
  // own daemon registers once it connects; callers surface a failure (phone error / the /spawn response).
  private async spawnThread(cwd?: string): Promise<{ ok: boolean; ref?: string }> {
    const spawnId = randomUUID();
    const command = this.buildSpawnCommand(spawnId);
    const ref = await spawnWorkspace({ cwd: cwd ?? process.cwd(), command });
    if (ref) {
      console.error(`[spawn] new workspace ${ref} :: ${command}`);
      // Tell the phone to follow this exact spawn (the new daemon echoes the same spawnId in its
      // first register). Works for the "+" AND the /voice-control:spawn skill — both land here.
      this.sendToBrowser({ type: "spawn_pending", spawnId });
    }
    return { ok: Boolean(ref), ref };
  }

  // Handle a /spawn POST (the spawn skill, so the Claude agent can open a new voice-controlled
  // session on request — optionally at a given cwd). Inherits this session's permission mode and
  // answers with { ok, ref } so the agent can tell the user where the new session opened.
  private async handleSpawnRequest(body: string, res: ServerResponse): Promise<void> {
    let cwd: string | undefined;
    try {
      const parsed = JSON.parse(body || "{}") as { cwd?: string };
      if (typeof parsed.cwd === "string" && parsed.cwd.trim()) cwd = parsed.cwd.trim();
    } catch {
      // malformed body → spawn at the daemon's own cwd
    }
    try {
      const result = await this.spawnThread(cwd);
      res.statusCode = result.ok ? 200 : 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      // Never leave the skill's request hanging (or reject an uncaught promise) if the spawn throws.
      console.error(`[spawn] request failed: ${errText(error)}`);
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false }));
    }
  }

  // The shell command a spawned cmux workspace runs to join this session (see spawn-command.ts). cmux
  // focuses the new workspace and reuses the trusted cwd, so there's no first-run trust gate.
  private buildSpawnCommand(spawnId: string): string {
    return buildClaudeSpawnCommand({
      spawnId,
      pluginDir: SPAWN_PLUGIN_DIR,
      permissionMode: this.inheritedPermissionMode
    });
  }

  private async handleAudio(audioBase64: string, mimeType: string, mode: InjectMode): Promise<void> {
    let transcript: string;
    try {
      transcript = await transcribeAudio(this.init.config, Buffer.from(audioBase64, "base64"), mimeType);
    } catch (error) {
      this.sendError(error);
      return;
    }
    if (!transcript) {
      this.sendToBrowser({ type: "error", message: "No speech detected — try again." });
      return;
    }
    // If Claude is paused on an interactive question, the spoken answer IS the picker's custom answer — not a
    // new prompt. Route it into the picker; the answer lands as a tool_result → the card flips to answered.
    const pending = this.pendingQuestion(this.projectedNow());
    if (pending?.question) {
      const payload = pending.question;
      // Only a SINGLE single-select question can be driven via the picker (one custom answer → Enter submits);
      // multi-part / multi-select needs per-sub-question stepping we deliberately don't do — answer those in
      // the terminal (fail loud, never half-answer).
      if (!isVoiceAnswerable(payload)) {
        this.sendToBrowser({
          type: "error",
          message: "This is a multi-part question — please answer it in the terminal."
        });
        return;
      }
      // Coalesce concurrent utterances: a second answer must not re-type into the picker while the first is
      // still being sent (the answered state isn't flushed yet).
      if (this.answeringQuestion) {
        this.sendToBrowser({ type: "error", message: "Still sending your previous answer…" });
        return;
      }
      this.answeringQuestion = true;
      let result: "sent" | "no-picker" | "error";
      try {
        result = await cmuxAnswerQuestion(transcript, this.init.surface);
      } finally {
        this.answeringQuestion = false;
      }
      if (result === "sent") {
        // The answer lands as a tool_result, not a user row or a UserPromptSubmit, so the phone's "sent ✓"
        // path never fires — echo an accepted prompt_status with the answer text so the mic spinner clears
        // (and the answer shows as a "you" row, reconciled to the logged answer the transcript projects).
        // Flip the overlay to answered NOW so the lamp leaves "awaiting" immediately (Claude is processing the
        // answer = working), instead of lingering until the transcript flushes ~1s later; the projection then
        // takes over (the question card's answered state + the answer "you" turn).
        if (this.pendingQuestionOverlay?.question) {
          this.pendingQuestionOverlay = {
            ...this.pendingQuestionOverlay,
            question: { ...this.pendingQuestionOverlay.question, answered: true }
          };
        }
        this.sendToBrowser({ type: "prompt_status", text: transcript, state: "accepted" });
        this.syncFromTranscript();
        return;
      }
      if (result === "error") {
        this.sendToBrowser({
          type: "error",
          message: "Couldn't send your answer — answer the question in the terminal."
        });
        return;
      }
      // result === "no-picker": the question still showed as unanswered but the picker is already gone (a
      // stale/dismissed question). Clear the stale overlay and don't drop the words — fall through and treat
      // them as a normal prompt.
      this.pendingQuestionOverlay = undefined;
    }
    if (mode === "interrupt") await cmuxInterrupt(this.init.surface); // Esc the running turn, run this next
    this.queueVoice(transcript, mode);
  }

  // The interactive question currently awaiting an answer (the picker is up): the LATEST question turn, iff
  // it's still unanswered. Undefined otherwise — used to route a spoken answer into the picker rather than
  // injecting it as a fresh prompt.
  private pendingQuestion(turns: ProjectedTurn[]): ProjectedTurn | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].question) return turns[i].question?.answered ? undefined : turns[i];
    }
    return undefined;
  }

  // Queue a spoken prompt into the injection queue. The conversation itself is projected from the
  // transcript; we've just transcribed the words, so echo them to the phone as a "queued" row (clock): the
  // spoken message shows before it's even injected, and upgrades to one check on UserPromptSubmit
  // (emitPromptAccepted) then the native two-check once it's in the transcript.
  private queueVoice(text: string, mode: InjectMode): void {
    if (mode === "interrupt") this.turns.interruptWith(text);
    else this.turns.enqueueVoice(text);
    this.sendToBrowser({ type: "prompt_status", text, state: "queued" });
    this.syncFromTranscript();
  }

  // ---- injection (driven by the TurnCoordinator) ----------------------------

  // Type one prompt into the live Claude pane. The coordinator calls this ONLY when Claude is idle
  // (it owns the queue and the idle-gate); we own the cmux send and the "listening" lamp. Returns
  // true on success. A successful send positively proves the pane is alive, so it self-heals a stale
  // "not listening"; a failure surfaces an error and re-probes (the coordinator releases the slot).
  private async injectIntoPane(text: string): Promise<boolean> {
    console.error(`[inject] surface=${this.init.surface ?? "(default $CMUX_SURFACE_ID)"} text=${JSON.stringify(text)}`);
    const ok = await cmuxSubmit(text, this.init.surface);
    console.error(`[inject] cmuxSubmit ok=${ok}`);
    if (ok) {
      if (!this.cmuxHealthy) {
        this.cmuxHealthy = true;
        this.emitStatus();
      }
      return true;
    }
    // The coordinator releases its slot. Don't hard-fail "listening" on one send: re-probe (only a
    // positive pane-gone verdict flips it).
    void this.refreshCmuxHealth();
    this.sendToBrowser({
      type: "error",
      message: "Couldn't reach the Claude Code pane (is it still open in cmux?)."
    });
    this.syncFromTranscript();
    return false;
  }

  // ---- the live transcript tail (single source of phone state) ---------------

  // Point the live tail at the transcript a hook handed us and keep a self-healing fs.watch armed on it. The
  // watch re-syncs the phone on every write, so a record that flushes AFTER its hook (a user prompt, a step, a
  // late-streamed reply, a blocking AskUserQuestion) reaches the phone the instant it lands. No-op if we're
  // already watching this exact file; otherwise (re)arm — armWatch handles a not-yet-created file and rotation.
  private setTranscript(path?: string): void {
    if (!path) return;
    this.lastTranscriptPath = path;
    if (path === this.watchedPath && this.transcriptWatcher) return; // already watching this exact file
    this.armWatch();
  }

  // Arm (or re-arm) the self-healing fs.watch on the active transcript — the SINGLE mechanism keeping the phone
  // current, with no backup poll. fs.watch is inode-bound, so it goes DEAD when its file is replaced/rotated
  // (/clear, /compact → a new session file) and THROWS when the file doesn't exist yet (a fresh session's first
  // record flushes after its hook). So: a 'change' re-syncs; a 'rename'/error means the file moved out from
  // under the watch → re-arm onto the live file; a failed arm (ENOENT) retries until the file appears. Once
  // armed there is NO timer — an idle daemon does zero work. The watch reliably catches every write when armed
  // (verified across write patterns); the only job here is keeping it armed on whatever file is now live.
  private armWatch(): void {
    if (this.stopped) return;
    const path = this.lastTranscriptPath;
    if (!path) return;
    if (this.rearmTimer) {
      clearTimeout(this.rearmTimer);
      this.rearmTimer = undefined;
    }
    this.transcriptWatcher?.close();
    this.transcriptWatcher = undefined;
    this.watchedPath = undefined;
    try {
      const watcher = watch(path, (eventType) => {
        if (this.lastTranscriptPath !== path) return; // a newer transcript path has superseded this watch
        this.scheduleSync(); // always pull the latest, even on a 'rename' (it can carry the final content)
        if (eventType === "rename") this.rearmSoon(); // file replaced/removed → our inode watch is dead → re-arm
      });
      watcher.on("error", () => this.rearmSoon());
      this.transcriptWatcher = watcher;
      this.watchedPath = path;
      this.scheduleSync(); // the file just (re)appeared under us → sync whatever is already there
    } catch {
      this.rearmSoon(); // ENOENT: not created yet → retry until it is (a fresh session's first record is imminent)
    }
  }

  // Re-arm the watch after a short delay, coalesced — a single replace can fire several rename/error events.
  // ponytail: retries indefinitely while the file is missing; harmless (a real transcript path always appears,
  // and a hook resets lastTranscriptPath), and it stops the instant the watch arms.
  private rearmSoon(): void {
    if (this.stopped || this.rearmTimer) return;
    this.rearmTimer = setTimeout(() => {
      this.rearmTimer = undefined;
      this.armWatch();
    }, WATCH_REARM_MS);
  }

  // Coalesce a burst of fs.watch events into one read-only re-sync (a single write fires several events).
  private scheduleSync(): void {
    if (this.stopped || this.syncDebounce) return;
    this.syncDebounce = setTimeout(() => {
      this.syncDebounce = undefined;
      this.reflect(this.projectedNow(), false); // guarded send (force=false): skips an unchanged thread
    }, SYNC_DEBOUNCE_MS);
  }

  // Hook/sync-driven re-sync: authoritative, so it ALWAYS sends (force). The ONE call the hooks make;
  // the tail uses reflect() directly with force=false.
  private syncFromTranscript(): void {
    if (!this.lastTranscriptPath) return;
    this.reflect(this.projectedNow(), true);
  }

  // Turn a projection into phone state: send the thread, refresh the working lamp, and synthesize anything
  // that just landed. `force` always sends the thread; without it we skip an unchanged thread (the tail
  // fires on every write, incl. tool output that adds no conversational turn — re-sending the whole thread
  // each time would flood the wire). Idempotent: the `seen` guard means re-running never double-synthesizes,
  // and native uuids mean it never double-shows.
  private reflect(turns: ProjectedTurn[], force: boolean): void {
    const sig = turns
      .map(
        (t) =>
          `${t.uuid}:${t.interim ? "i" : ""}:${t.text.length}:${this.audio.has(t.uuid) ? "a" : ""}:${t.question ? (t.question.answered ? "qa" : "q") : ""}`
      )
      .join("|");
    if (force || sig !== this.lastHistorySig) {
      this.lastHistorySig = sig;
      this.sendToBrowser({
        type: "history",
        turns: turns.map((t) => ({
          requestId: t.uuid,
          timestamp: t.timestamp,
          role: t.role,
          text: t.text,
          hasAudio: this.audio.has(t.uuid),
          interim: t.interim,
          ...(t.question ? { question: t.question } : {})
        }))
      });
    }
    // Only refresh the lamp when it actually flips (or on a forced hook/sync) — the tail fires on every
    // write, and re-emitting an unchanged "working" status each time would spam the bridge for nothing.
    if (force || this.computeState(turns) !== this.lastState) this.emitStatus(turns);
    this.synthesizeReplies(turns); // synthesize + send a just-landed reply (idempotent via `seen`)
  }

  // Record the pending interactive question handed to us by the PreToolUse hook (Claude doesn't flush the
  // AskUserQuestion record to the transcript until it's answered, so this is the ONLY live source for it).
  // Stored as a synthetic claude turn, uuid keyed by content so a NEW question isn't deduped against the last.
  private setPendingQuestion(toolUseId: string, rawQuestions: unknown): void {
    const questions = normalizeQuestions(rawQuestions);
    if (questions.length === 0) return; // malformed/empty → leave the projection untouched, never break it
    const sig = questionContentSig(questions);
    this.pendingQuestionOverlay = {
      uuid: `pending-question:${sig}`,
      timestamp: Date.now(),
      role: "claude",
      text: questionSpeech(questions),
      interim: false,
      question: { toolUseId: toolUseId || `pending:${sig}`, questions, answered: false }
    };
  }

  // Project the recent transcript tail (the conversation the phone mirrors), oldest-first, hiding turns
  // below the topic floor and the start-skill's QR/URL announcement (noise — never shown or spoken). Then
  // inject the pending-question overlay (if any) so a question Claude is blocked on shows live, even though
  // its record isn't in the transcript yet — yielding to the transcript once the same question flushes there.
  private projectedNow(): ProjectedTurn[] {
    const base = this.lastTranscriptPath
      ? dropSessionAnnouncement(
          projectTranscript(this.lastTranscriptPath, MAX_PROJECTED_TURNS).turns.filter(
            (t) => t.timestamp >= this.floor
          ),
          this.init.browserUrl
        )
      : [];
    const overlay = this.pendingQuestionOverlay;
    if (!overlay?.question) return base;
    // Yield once the SAME question (by content) has flushed to the transcript (i.e. been answered) — else the
    // card would show twice. Until then the synthetic turn carries the live show + read + voice-answer.
    const sig = questionContentSig(overlay.question.questions);
    const inTranscript = base.some((t) => t.question && questionContentSig(t.question.questions) === sig);
    return inTranscript ? base : [...base, overlay];
  }

  // Synthesize every claude reply the projection shows, so audio follows the SAME source of truth as text —
  // there is no prompt→reply matching that could diverge (the bug where a typed-prompt reply showed but
  // stayed silent). One reply == one native uuid; `seen` dedups so re-projecting never double-synthesizes.
  //
  //  - FIRST sight establishes a baseline: the replies already in the tail when we start are recorded as
  //    seen but NOT synthesized — they stay tap-to-playable (the phone fetches on demand via get_audio), so
  //    a (re)connect can't blast a wall of TTS. Only replies we then watch LAND auto-synthesize.
  //  - Interim STEPS (narration before a tool call) are synthesized only under speakMode "all"; they're
  //    marked seen either way, so flipping the toggle on never reads out a backlog.
  //  - Synthesis is ALWAYS done regardless of the autoplay setting; the phone decides whether arriving audio
  //    plays by itself or waits for a tap. Of the rows synthesized this pass, only the NEWEST is sent to
  //    auto-play (replay=false); any older ones (a burst caught in one read) are cached without auto-play.
  private synthesizeReplies(turns: ProjectedTurn[]): void {
    if (!this.seeded) {
      this.seeded = true;
      for (const t of turns) if (t.role === "claude") this.remember(this.seen, t.uuid, SEEN_UUID_CAP);
      return; // baseline only — the tail shown on connect is tap-to-play, never auto-synthesized
    }
    const fresh: ProjectedTurn[] = [];
    for (const t of turns) {
      if (t.role !== "claude" || this.seen.has(t.uuid)) continue;
      this.remember(this.seen, t.uuid, SEEN_UUID_CAP); // seen once, never reconsidered
      if (t.interim && this.speakMode !== "all") continue; // steps auto-read only under "all"
      // Never read an ANSWERED question aloud: the pending overlay already spoke it, and the transcript's
      // answered version (a different uuid) flushes only on answer — speaking it would double-read.
      if (t.question?.answered) continue;
      fresh.push(t);
    }
    const newest = fresh.length - 1;
    fresh.forEach((t, i) => void this.speak(t.uuid, t.text, i !== newest));
  }

  // Serve a row's audio to the phone: from the store, else synthesize it on demand (a step isn't
  // pre-synthesized) by looking its text up in the current projection. A miss (row gone from the tail)
  // returns a graceful error.
  private async serveAudio(uuid: string): Promise<void> {
    let audio = this.audio.get(uuid);
    if (!audio) {
      const turn = this.projectedNow().find((t) => t.uuid === uuid);
      if (turn) {
        // Re-synthesizing on demand (tap-to-play / retry) — show the loading indicator while we do.
        this.sendToBrowser({ type: "tts_status", requestId: uuid, state: "pending" });
        try {
          const synth = await synthesizeSpeech(this.init.config, capForSpeech(turn.text));
          if (synth.audioBase64)
            audio = this.storeAudio(uuid, { audioBase64: synth.audioBase64, mimeType: synth.mimeType });
        } catch {
          // synth failed → mark the row retryable below
        }
        if (!audio) {
          this.sendToBrowser({ type: "tts_status", requestId: uuid, state: "failed" });
          return;
        }
      }
    }
    this.sendToBrowser(
      audio
        ? { type: "tts_audio", requestId: uuid, replay: true, ...audio }
        : { type: "error", requestId: uuid, message: "Audio for that reply is no longer available." }
    );
  }

  // Tell the phone the agent RECEIVED this prompt (one check). Sent the instant UserPromptSubmit fires, so
  // a typed or spoken message shows immediately instead of waiting for the reply. Skips a slash command /
  // empty prompt — those are never shown as conversation (parity with isRealUserTurn).
  private emitPromptAccepted(prompt: string): void {
    const text = prompt.trim();
    if (!text || text.startsWith("/")) return;
    this.sendToBrowser({ type: "prompt_status", text, state: "accepted" });
  }

  // Retain synthesized audio keyed by native uuid, evicting the oldest past the cap.
  private storeAudio(uuid: string, audio: Audio): Audio {
    this.audio.set(uuid, audio);
    while (this.audio.size > MAX_AUDIO_ENTRIES) {
      const oldest = this.audio.keys().next().value;
      if (oldest === undefined) break;
      this.audio.delete(oldest);
    }
    return audio;
  }

  // Synthesize a reply/step's audio, retain it (keyed by native uuid) for tap-to-play + reconnect, and push
  // it to the phone. `replay=false` lets the phone auto-play it now (per its autoplay setting); `replay=true`
  // caches it for tap-to-play without auto-playing (an older row caught in a burst, or a connect re-send).
  private async speak(uuid: string, text: string, replay = false): Promise<void> {
    // Tell the phone audio is on its way so the message shows a loading indicator until it lands.
    this.sendToBrowser({ type: "tts_status", requestId: uuid, state: "pending" });
    try {
      const { audioBase64, mimeType } = await synthesizeSpeech(this.init.config, capForSpeech(text));
      if (!audioBase64) return; // nothing to synthesize (empty/whitespace reply)
      this.storeAudio(uuid, { audioBase64, mimeType });
      this.sendToBrowser({ type: "tts_audio", requestId: uuid, audioBase64, mimeType, replay });
    } catch (error) {
      // The text reply already reached the phone; flag the row failed (the phone offers a retry) instead
      // of a transient toast, so a config/model/rate-limit problem is recoverable rather than just lost.
      const message = errText(error);
      console.error(`[tts] synthesis failed for ${uuid}: ${message}`);
      this.sendToBrowser({ type: "tts_status", requestId: uuid, state: "failed" });
    }
  }

  // Add to a bounded set (FIFO eviction) so a long session can't leak.
  private remember(set: Set<string>, value: string, cap: number): void {
    set.add(value);
    while (set.size > cap) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  // ---- thread registry -------------------------------------------------------

  // Snapshot of this thread for the DO roster: id + label + live state/listening. The DO
  // stores this and serves it to phones; the daemon keeps no roster of its own.
  private buildThreadInfo(): WireThreadInfo {
    return {
      threadId: this.init.threadId,
      label: this.sealedLabel, // sealed (EncBlob): the worker stores/relays it without reading it
      state: this.lastState, // cached from the last emitStatus (transcript-derived)
      listening: this.cmuxHealthy,
      spawnId: this.pendingSpawnId
    };
  }

  private sealLabel(label: ThreadInfo["label"]): Promise<EncBlob> {
    return sealJson(this.key, label, aad("label", this.init.threadId));
  }

  // Tell the DO about this thread (register on connect, refresh on label/state change). The DO
  // dedups by threadId and broadcasts a roster delta; sending it again is the refresh path.
  private registerThread(): void {
    this.send({ channel: "registry", event: { type: "thread_register", info: this.buildThreadInfo() } });
    this.pendingSpawnId = undefined; // one-shot: only the FIRST register carries the spawn id
  }

  // Recompute the label (repo·branch·cwd · cmux title) and re-register only if it changed, so
  // the cmux-health tick can call this every 5s without spamming the DO. Best-effort: a failed
  // compute keeps the last good label.
  private async refreshLabel(): Promise<void> {
    // process.cwd() throws if the daemon's working directory was deleted/unmounted; keep the last
    // good label rather than rejecting this floating promise.
    let cwd: string;
    try {
      cwd = process.cwd();
    } catch {
      return;
    }
    const next = await computeLabel(cwd, this.init.surface, this.init.threadId);
    if (sameLabel(next, this.label)) return;
    this.label = next;
    this.sealedLabel = await this.sealLabel(next); // reseal so the next register carries the new label
    if (this.ws?.readyState === WebSocket.OPEN) this.registerThread();
  }

  // ---- helpers ---------------------------------------------------------------

  // The runtime state shown on the phone, derived deterministically from three sources of truth:
  //   • "awaiting" — Claude is blocked on the HUMAN: an interactive question is open (transcript), or a
  //     permission_prompt fired (Notification hook). Takes priority — a wait must never read as "working".
  //   • "working"  — our injection hasn't landed yet (hasInFlight), OR the pane is mid-turn (isBusy), OR the
  //     transcript shows an unanswered user turn. ORed, not ANDed: a dropped Stop can't flip the lamp idle
  //     while a reply is still streaming; `idle_prompt`/the reaper clear a stuck `isBusy`.
  //   • "idle"     — none of the above: the turn is fully answered and Claude is free.
  private computeState(turns: ProjectedTurn[]): SessionRuntimeState {
    if (pendingQuestion(turns) || this.turns.awaitingPermission) return "awaiting";
    if (this.turns.hasInFlight || this.turns.isBusy || isPaneWorking(turns)) return "working";
    return "idle";
  }

  // Status carries this thread's id (so the phone files it correctly); a thread_register rides along to keep
  // the roster's state/listening in lockstep. Pass the turns already projected this cycle to avoid a
  // re-read; callers without them fall back to a pure read (no floor move).
  private emitStatus(turns?: ProjectedTurn[]): void {
    const runtimeState = this.computeState(turns ?? this.projectedNow());
    this.lastState = runtimeState;
    const state: SessionState = {
      sessionId: this.init.sessionId,
      listening: this.cmuxHealthy,
      state: runtimeState
    };
    this.sendToBrowser({ type: "session_status", state, memory: { currentTask: this.turns.currentVoicePrompt } });
    // Keep the roster's state/listening in lockstep with status (idle↔working, listening
    // flips) without a separate channel — register is the refresh path, deduped DO-side.
    if (this.ws?.readyState === WebSocket.OPEN) this.registerThread();
  }

  private sendToBrowser(event: DaemonToBrowserEvent): void {
    // Seal the event end-to-end (the worker relays only ciphertext), tagged with this daemon's threadId
    // so the phone/DO attribute it correctly. Chained so concurrent sends keep their order — a later
    // history snapshot must never overtake an earlier one on the wire.
    const threadId = this.init.threadId;
    this.enqueueSeal(async () => {
      const enc = await sealJson(this.key, event, aad("browser", threadId));
      this.send({ channel: "browser", threadId, enc });
    });
  }

  private send(envelope: BridgeEnvelope): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(envelope));
    } catch {
      // socket closing; reconnect will re-sync
    }
  }

  private sendError(error: unknown): void {
    this.sendToBrowser({ type: "error", message: errText(error) });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    if (this.syncDebounce) clearTimeout(this.syncDebounce);
    if (this.rearmTimer) clearTimeout(this.rearmTimer);
    this.transcriptWatcher?.close();
    this.stopHeartbeat?.();
    // Tell the bridge to drop the session so a leaked URL can't reconnect. Best-effort:
    // if the socket is already gone the session is inert anyway (no daemon to relay to).
    this.send({ channel: "control", event: { type: "terminate" } });
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.httpServer?.close();
    try {
      // Remove only THIS pane's runtime file (siblings keep theirs). qr.txt is machine-level — leave it
      // (a sibling rewrites identical bytes; a stale QR is harmless, the DO revokes the session on exit).
      rmSync(threadRuntimePath(this.init.surface), { force: true });
    } catch {
      // ignore
    }
  }
}

// Structural equality of two labels (all fields), so a refresh re-registers only on a real
// change and the cmux-health tick doesn't spam the DO every 5s.
function sameLabel(a: ThreadInfo["label"], b: ThreadInfo["label"]): boolean {
  return a.title === b.title && a.repo === b.repo && a.branch === b.branch && a.cwd === b.cwd;
}

// Safety ceiling only (see MAX_SPEECH_CHARS): caps a pathological runaway so it can't fan out into
// unbounded TTS calls. Real replies pass untouched.
function capForSpeech(text: string): string {
  return text.length > MAX_SPEECH_CHARS ? `${text.slice(0, MAX_SPEECH_CHARS)}…` : text;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Add `id` to a bounded, insertion-ordered set; return true iff it was NEW (not already present). Past
// `cap` the oldest id is evicted (a Set iterates in insertion order). This is the idempotency guarantee
// behind submit_audio retransmits: a re-sent requestId returns false, so the prompt is handled exactly once.
export function rememberBounded(seen: Set<string>, id: string, cap: number): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > cap) seen.delete(seen.values().next().value as string);
  return true;
}
