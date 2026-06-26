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
import { createSerializer } from "../shared/serialize.js";
import { startBridgeHeartbeat } from "./bridge-heartbeat.js";
import { cmuxAnswerQuestions, cmuxHealth, cmuxInterrupt, cmuxSubmit, spawnWorkspace } from "./cmux.js";
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
import { synthesizeSpeechAacStream, transcribeAudio } from "./openai.js";
import { renderQr } from "./qr.js";
import { buildClaudeSpawnCommand, PERMISSION_MODES } from "./spawn-command.js";
import {
  dropSessionAnnouncement,
  isPaneWorking,
  normalizeQuestions,
  type ProjectedTurn,
  pendingQuestion,
  questionContentSig,
  questionSpeech,
  questionSpeechOne
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
  // True while the wizard's collected answers are being driven into the AskUserQuestion picker, so a racing
  // re-speak can't re-drive the picker before the answer flushes to the transcript. Per-answer collection does
  // NOT take this latch — only submitQuestion does.
  private answeringQuestion = false;
  // The PENDING interactive question, surfaced from the PreToolUse hook because Claude does NOT write the
  // AskUserQuestion record to the transcript until it's answered — so the projection alone can't show it while
  // the user still needs to answer. projectedNow() injects this synthetic turn until the same question (by
  // content) appears in the transcript, then yields. Cleared on a new turn / reset / once the answer is sent.
  private pendingQuestionOverlay?: ProjectedTurn;
  // The toolUseId of the last ABORTED question we reconciled the coordinator for (see reconcileAbort). When
  // the user Escs a question in the TERMINAL (not via the phone's stop_task), the daemon never ran the Esc,
  // so the inject-gate's `isBusy` can stay set; this lets us clear it exactly once when the abort flushes.
  private lastReconciledAbort?: string;
  // The toolUseId of a question whose answers we just submitted to the picker, but whose answer hasn't
  // flushed to the transcript yet — so a racing repeat submit in that window is ignored (see submitQuestion).
  private submittedToolUseId?: string;
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
              // A pending question already shows "awaiting" from the transcript/overlay, and clears itself the
              // instant the answer lands. Don't ALSO arm the sticky permission flag for it — that flag only
              // clears on a later edge (Stop / next tool), so it would leave the lamp stuck on "needs you"
              // after you answered. Arm it only for a genuine tool-permission prompt (no open question).
              if (kind === "permission" && !pendingQuestion(this.projectedNow())) this.turns.notePermissionPrompt();
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
        this.queueVoice("Give me a brief spoken status of what you're doing right now.");
        return;
      case "summary_request":
        this.queueVoice("Briefly summarize what you've done so far, for the phone.");
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
    // If Claude is paused on an interactive question, the spoken transcript is an ANSWER to the wizard's
    // CURRENT sub-question — collect it (collectQuestionAnswer auto-submits once the last one is spoken), not a
    // new prompt. The overlay holds the growing answers; the phone advances to the next sub-question.
    const pending = this.pendingQuestion(this.projectedNow());
    if (pending?.question) {
      this.collectQuestionAnswer(transcript);
      return;
    }
    await this.steerIntoPane(transcript, mode === "interrupt");
  }

  // Steer: type the spoken message STRAIGHT into the pane, even while Claude is working — Claude Code queues
  // it and ingests it at the next tool boundary, no daemon-side idle-wait (that wait was the regression that
  // left a steered message stuck on one check, never reaching the pane). For "interrupt", press Esc AFTER the
  // text: type+Enter queues the message, then Esc propagates that queued message straight into the stream so
  // Claude runs it NOW instead of waiting for the next boundary. The message shows now (one check) and gets
  // the native two-check once Claude logs it to the transcript.
  private async steerIntoPane(text: string, interrupt: boolean): Promise<void> {
    const ok = await cmuxSubmit(text, this.init.surface);
    if (!ok) {
      void this.refreshCmuxHealth();
      this.sendToBrowser({
        type: "error",
        message: "Couldn't reach the Claude Code pane (is it still open in cmux?)."
      });
      return;
    }
    if (interrupt) await cmuxInterrupt(this.init.surface);
    if (!this.cmuxHealthy) {
      this.cmuxHealthy = true; // a successful send proves the pane is alive → self-heal a stale "not listening"
      this.emitStatus();
    }
    this.sendToBrowser({ type: "prompt_status", text, state: "accepted" });
    this.syncFromTranscript();
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

  // When a question is Esc'd in the TERMINAL, Claude flushes an aborted question (a tool_result with no
  // answers map → `aborted`) and the turn ends with no reply coming. isPaneWorking already treats that as
  // idle, but the inject-gate's `isBusy` can still be set (the daemon never ran that Esc, so no Stop reached
  // turnClosed — or it raced). Close the turn on the gate too, exactly once per aborted toolUseId, so the
  // working floor can't pin the lamp. A phone-driven Esc already cleared the gate via interrupt(); this only
  // fires for the terminal path. Idempotent with a real Stop (turnClosed just re-floors to idle).
  private reconcileAbort(turns: ProjectedTurn[]): void {
    let aborted: string | undefined;
    for (let i = turns.length - 1; i >= 0; i--) {
      const q = turns[i].question;
      if (!q) continue;
      if (q.aborted) aborted = q.toolUseId;
      break; // only the newest question matters — an older aborted one is already-resolved history
    }
    if (!aborted || aborted === this.lastReconciledAbort) return;
    this.lastReconciledAbort = aborted;
    this.turns.turnClosed();
  }

  // Collect one spoken answer for the SEQUENTIAL question wizard. The daemon holds the growing answers on the
  // pending overlay, then AUTO-SUBMITS the moment the last sub-question is answered — no confirm tap, so the
  // wizard is fully hands-free. Pushes the next answer; the `else` only fires if a spoken answer races in after
  // the last was already collected (the submit hasn't flushed) — it replaces the last, harmless under the
  // submit latch. Re-projects so the phone advances and clears its mic spinner from the fresh snapshot. If the
  // overlay vanished in a race, don't drop the words — treat them as a prompt.
  private collectQuestionAnswer(transcript: string): void {
    const q = this.pendingQuestionOverlay?.question;
    if (!q) {
      void this.steerIntoPane(transcript, false);
      return;
    }
    if (!q.answers) q.answers = [];
    const answers = q.answers;
    if (answers.length < q.questions.length) answers.push(transcript);
    else answers[answers.length - 1] = transcript;
    this.syncFromTranscript(); // the phone shows the wrap-up; the card flips to answered as the submit flushes
    // Every sub-question now has an answer → drive the picker straight away (atomically, from a known fresh
    // state). The submit latch in submitQuestion makes a racing re-speak a no-op.
    if (answers.length >= q.questions.length) void this.submitQuestion(q.toolUseId);
  }

  // The last answer was spoken: drive the picker with every collected answer, in order. Guarded by toolUseId (a
  // stale submit is ignored) and the answeringQuestion latch (a racing re-speak can't double-type). On success
  // the answer flushes to the transcript and the overlay yields; on a picker miss/failure we surface it so the
  // user can finish in the terminal, leaving the question up.
  private async submitQuestion(toolUseId: string): Promise<void> {
    const q = this.pendingQuestionOverlay?.question;
    if (!q || q.toolUseId !== toolUseId) return; // stale / no pending question
    // A second submit in the gap between a successful drive and the answer flushing to the transcript (the
    // overlay is still up) must NOT re-drive the now-closed picker (which would surface a spurious "no longer
    // open" error). Latch on the submitted toolUseId until a different question supersedes it.
    if (toolUseId === this.submittedToolUseId) return;
    const answers = q.answers ?? [];
    if (answers.length < q.questions.length || this.answeringQuestion) return; // not all answered, or in flight
    this.answeringQuestion = true;
    // Pair each spoken answer with its sub-question's multiSelect flag — the picker commits/advances the two
    // differently (a multiSelect tab needs an extra Ctrl+Enter to leave; see cmuxAnswerQuestions).
    const picks = answers.map((text, i) => ({ text, multiSelect: !!q.questions[i]?.multiSelect }));
    let result: "sent" | "no-picker" | "error";
    try {
      result = await cmuxAnswerQuestions(picks, this.init.surface);
    } finally {
      this.answeringQuestion = false;
    }
    if (result === "sent") {
      this.submittedToolUseId = toolUseId; // ignore any repeat submit until the overlay yields to the answer
      this.syncFromTranscript(); // the answer flushes → the card flips to answered, the overlay yields
      return;
    }
    this.sendToBrowser({
      type: "error",
      message:
        result === "no-picker"
          ? "That question is no longer open — it may have been answered already."
          : "Couldn't submit your answers — finish the question in the terminal."
    });
  }

  // Queue an AUTO prompt (the status/summary requests) behind the running turn — these shouldn't barge into
  // Claude's work, so they inject only once it's idle (the coordinator's idle-gate). Spoken user messages do
  // NOT come here; they steer straight into the pane (see steerIntoPane). Echo a "queued" row (clock) so it
  // shows before it's injected; it upgrades to the native two-check once it lands in the transcript.
  private queueVoice(text: string): void {
    this.turns.enqueueVoice(text);
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
    // A question Esc'd in the TERMINAL flushes as an aborted question; release the inject-gate (the daemon
    // didn't run that Esc, so isBusy can be stuck) BEFORE computing state, so the lamp settles to idle.
    this.reconcileAbort(turns);
    // The start-skill's QR/URL announcement is a real terminal reply: it must settle the working lamp (so
    // computeState below gets the FULL `turns`), but its QR/URL must never be shown or spoken — so it's
    // dropped from the displayed + synthesized set ONLY. Dropping it from the lamp's input is what used to
    // stick the lamp on "working": the concluding reply disappeared, so isPaneWorking never saw an answer.
    const shown = dropSessionAnnouncement(turns, this.init.browserUrl);
    const sig = shown
      .map(
        (t) =>
          `${t.uuid}:${t.interim ? "i" : ""}:${t.text.length}:${this.audio.has(t.uuid) ? "a" : ""}:${t.question ? (t.question.answered ? "qa" : "q") : ""}`
      )
      .join("|");
    if (force || sig !== this.lastHistorySig) {
      this.lastHistorySig = sig;
      this.sendToBrowser({
        type: "history",
        turns: shown.map((t) => ({
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
    this.synthesizeReplies(shown); // synthesize + send a just-landed reply (idempotent via `seen`)
  }

  // Record the pending interactive question handed to us by the PreToolUse hook (Claude doesn't flush the
  // AskUserQuestion record to the transcript until it's answered, so this is the ONLY live source for it).
  // Stored as a synthetic claude turn, uuid keyed by content so a NEW question isn't deduped against the last.
  private setPendingQuestion(toolUseId: string, rawQuestions: unknown): void {
    const questions = normalizeQuestions(rawQuestions);
    if (questions.length === 0) return; // malformed/empty → leave the projection untouched, never break it
    this.submittedToolUseId = undefined; // a fresh question always allows a confirm (clear the submit latch)
    const sig = questionContentSig(questions);
    this.pendingQuestionOverlay = {
      // HASH the content sig for the uuid (not the sig itself): Claude's question text can contain '#', and
      // the uuid is the base of the per-sub-question audio key `${uuid}#${index}` — a raw '#' in it would make
      // that key ambiguous to parse (see audioTextFor). The hash is content-derived (stable, unique per
      // content) and '#'-free. A hash collision just aliases two byte-identical questions — harmless.
      uuid: `pending-question:${hashSig(sig)}`,
      timestamp: Date.now(),
      role: "claude",
      text: questionSpeech(questions),
      interim: false,
      question: { toolUseId: toolUseId || `pending:${sig}`, questions, answered: false, answers: [] }
    };
  }

  // Project the recent transcript tail (the conversation the phone mirrors), oldest-first, hiding turns
  // below the topic floor. Then inject the pending-question overlay (if any) so a question Claude is blocked
  // on shows live, even though its record isn't in the transcript yet — yielding to the transcript once the
  // same question flushes there.
  //
  // The start-skill's QR/URL announcement is NOT dropped here: it's a real terminal reply that must still
  // settle the working lamp. reflect() drops it from the displayed/synthesized set only — never from the set
  // the lamp is derived from. Dropping it here is what used to leave the lamp stuck "working" after
  // /voice-control:start: the very turn that concluded the thread vanished before isPaneWorking could see it.
  private projectedNow(): ProjectedTurn[] {
    const base = this.lastTranscriptPath
      ? projectTranscript(this.lastTranscriptPath, MAX_PROJECTED_TURNS).filter((t) => t.timestamp >= this.floor)
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
    // The fresh-unit KEY for a PENDING wizard question is per-current-sub-question (`uuid#index`), so each
    // sub-question reads aloud as the wizard advances; every other claude turn keys on its native uuid.
    const currentIndex = (t: ProjectedTurn): number => t.question?.answers?.length ?? 0;
    const unitKey = (t: ProjectedTurn): string =>
      t.question && !t.question.answered && !t.question.aborted ? `${t.uuid}#${currentIndex(t)}` : t.uuid;
    if (!this.seeded) {
      this.seeded = true;
      for (const t of turns) if (t.role === "claude") this.remember(this.seen, unitKey(t), SEEN_UUID_CAP);
      return; // baseline only — the tail shown on connect is tap-to-play, never auto-synthesized
    }
    const fresh: { key: string; text: string }[] = [];
    for (const t of turns) {
      if (t.role !== "claude") continue;
      const key = unitKey(t);
      if (this.seen.has(key)) continue;
      this.remember(this.seen, key, SEEN_UUID_CAP); // seen once, never reconsidered
      if (t.interim && this.speakMode !== "all") continue; // steps auto-read only under "all"
      // Never read an ANSWERED/aborted question aloud: the overlay already spoke each sub-question, and the
      // transcript's answered version (a different uuid) flushes only on submit — speaking it would double-read.
      if (t.question?.answered) continue;
      if (t.question) {
        // A pending wizard question: read ONLY the current sub-question (chrome-free), not the flat blob.
        // Past the last sub-question the phone shows the wrap-up + auto-submits — nothing left to read.
        const idx = currentIndex(t);
        if (idx >= t.question.questions.length) continue;
        fresh.push({ key, text: questionSpeechOne(t.question.questions[idx]) });
        continue;
      }
      fresh.push({ key, text: t.text });
    }
    const newest = fresh.length - 1;
    fresh.forEach((u, i) => void this.speak(u.key, u.text, i !== newest));
  }

  // The text to synthesize for a tap-to-play / replay requestId. A plain native uuid → that turn's text; a
  // composite `uuid#index` → that wizard sub-question's chrome-free speech (the phone fetches each
  // sub-question's audio by this key). Undefined if the row / sub-question is gone from the current tail.
  private audioTextFor(requestId: string): string | undefined {
    // The wizard's per-sub-question key is `${uuid}#${index}` with a NUMERIC suffix. Split on the LAST '#'
    // and require a digit tail: the overlay uuid is a hash (no '#') and a native uuid has none, so this is
    // unambiguous even if a sub-question's text/options contain '#'.
    const hash = requestId.lastIndexOf("#");
    if (hash >= 0 && /^\d+$/.test(requestId.slice(hash + 1))) {
      const uuid = requestId.slice(0, hash);
      const idx = Number.parseInt(requestId.slice(hash + 1), 10);
      const q = this.projectedNow().find((t) => t.uuid === uuid)?.question?.questions[idx];
      return q ? questionSpeechOne(q) : undefined;
    }
    // A bare uuid. A PENDING wizard question reads ONLY its current sub-question (chrome-free) — never the
    // flattened all-at-once `.text` blob — so a play-on-land / tap on the bare turn matches the wizard.
    const turn = this.projectedNow().find((t) => t.uuid === requestId);
    const q = turn?.question;
    if (q && !q.answered && !q.aborted) {
      const idx = q.answers?.length ?? 0;
      if (idx < q.questions.length) return questionSpeechOne(q.questions[idx]);
    }
    return turn?.text;
  }

  // Serve a row's audio to the phone: from the store, else synthesize it on demand (a step / a wizard
  // sub-question isn't pre-synthesized) by looking its text up in the current projection. A miss (row gone
  // from the tail) returns a graceful error.
  private async serveAudio(requestId: string): Promise<void> {
    let audio = this.audio.get(requestId);
    if (!audio) {
      const text = this.audioTextFor(requestId);
      if (text !== undefined) {
        // Re-synthesizing on demand (tap-to-play / retry) — show the loading indicator while we do.
        this.sendToBrowser({ type: "tts_status", requestId, state: "pending" });
        try {
          const fullBuffer = await synthesizeSpeechAacStream(this.init.config, capForSpeech(text), undefined, () => {});
          if (fullBuffer.length)
            audio = this.storeAudio(requestId, {
              audioBase64: fullBuffer.toString("base64"),
              mimeType: "audio/aac"
            });
        } catch {
          // synth failed → mark the row retryable below
        }
        if (!audio) {
          this.sendToBrowser({ type: "tts_status", requestId, state: "failed" });
          return;
        }
      }
    }
    this.sendToBrowser(
      audio
        ? { type: "tts_audio", requestId, replay: true, ...audio }
        : { type: "error", requestId, message: "Audio for that reply is no longer available." }
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
  // it to the phone. `replay=false` streams AAC bytes in real-time so audio starts within ~1 s;
  // `replay=true` synthesizes a fresh AAC clip and sends it whole (tap-to-play fetches are always one-shot).
  private async speak(uuid: string, text: string, replay = false): Promise<void> {
    this.sendToBrowser({ type: "tts_status", requestId: uuid, state: "pending" });
    const capped = capForSpeech(text);
    if (!replay) {
      await this.speakStreamingAac(uuid, capped);
      return;
    }
    try {
      const fullBuffer = await synthesizeSpeechAacStream(this.init.config, capped, undefined, () => {});
      if (!fullBuffer.length) return;
      const speech = { audioBase64: fullBuffer.toString("base64"), mimeType: "audio/aac" };
      this.storeAudio(uuid, speech);
      this.sendToBrowser({ type: "tts_audio", requestId: uuid, replay, ...speech });
    } catch (error) {
      const message = errText(error);
      console.error(`[tts] synthesis failed for ${uuid}: ${message}`);
      this.sendToBrowser({ type: "tts_status", requestId: uuid, state: "failed" });
    }
  }

  // Streams a single OpenAI TTS call (AAC) byte-by-byte to the phone so audio starts playing
  // before the full reply is synthesized. After all bytes arrive, caches the full AAC and signals
  // end-of-stream via tts_audio(replay:true) so the phone can replay it with a tap.
  private async speakStreamingAac(uuid: string, text: string): Promise<void> {
    try {
      const fullBuffer = await synthesizeSpeechAacStream(this.init.config, text, undefined, (chunk, seq) => {
        this.sendToBrowser({
          type: "tts_audio_chunk",
          requestId: uuid,
          seq,
          audioBase64: chunk.toString("base64"),
          mimeType: "audio/aac"
        });
      });
      if (!fullBuffer.length) return;
      const speech = { audioBase64: fullBuffer.toString("base64"), mimeType: "audio/aac" };
      this.storeAudio(uuid, speech);
      this.sendToBrowser({ type: "tts_audio", requestId: uuid, replay: true, ...speech });
    } catch (error) {
      const message = errText(error);
      console.error(`[tts] aac streaming failed for ${uuid}: ${message}`);
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

// A short, stable, '#'-free id derived from a string (FNV-1a → base36). Used for the pending-question
// overlay uuid so the per-sub-question audio key `${uuid}#${index}` stays unambiguous even when the question
// text contains '#'. Deterministic, so the same content yields the same uuid across re-projections.
function hashSig(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
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
