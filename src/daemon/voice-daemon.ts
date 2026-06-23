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
  SessionSignal,
  SessionState,
  SpeakMode,
  ThreadId,
  ThreadInfo,
  WireThreadInfo
} from "../shared/protocol.js";
import { createSerializer } from "../shared/serialize.js";
import { startBridgeHeartbeat } from "./bridge-heartbeat.js";
import { cmuxHealth, cmuxInterrupt, cmuxSubmit, spawnWorkspace } from "./cmux.js";
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
  type ProjectedTurn,
  resolveVoiceReply
} from "./transcript-projection.js";
import { projectTranscript } from "./transcript-reader.js";
import { TurnCoordinator } from "./turn-coordinator.js";

type Audio = { audioBase64: string; mimeType: string };

// A spoken prompt we injected, tracked ONLY until its reply is spoken — reply bookkeeping, never display.
// The phone view is a pure projection of the transcript now (a just-spoken message shows via the phone's
// own local stt_echo until the projection includes it), so this carries nothing for rendering. `opened` is
// set on its UserPromptSubmit (confirming the turn is ours); `userUuid`/`userTs` bind it to its native user
// record (identity for the reply match + the anchor for which steps belong to this turn); `openOffset` is
// the transcript byte position just before the prompt, captured at turn-open so the whole turn — however
// large — is always read back in full (see voiceReadFloor).
type PendingVoice = {
  text: string;
  opened?: boolean;
  userUuid?: string;
  userTs?: number;
  openOffset?: number;
};

// Reconnect backoff for transient bridge drops (a terminal 1008 close is handled separately).
const RECONNECT_DELAY_MS = 1500;
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
// Cap the set of already-spoken reply/step uuids (the dedup guard against re-speaking on re-projection).
// It tracks more uuids than we keep audio for — every interim step a long turn speaks, plus replies — so
// it's a multiple of the audio cap rather than equal to it.
const SPOKEN_UUID_CAP = MAX_AUDIO_ENTRIES * 4;
// Cap untracked-but-queued voice prompts (bounds memory if injections never open turns).
const MAX_PENDING_VOICE = 16;
// After a turn closes we wait for the voice reply to FLUSH to the transcript, reacting to the actual file
// write (fs.watch) rather than guessing a timeout — see waitForTranscript. The Stop hook can fire well
// before the answer TEXT lands: an extended-thinking turn writes the thinking block as its own `end_turn`
// record first, then streams the answer seconds-to-minutes later (≈19s behind for a ~4k-char answer in
// the wild; a long answer streams longer). These caps are only the safety backstop for the abnormal case
// where the answer never comes (e.g. an interrupted turn) — the watch resolves the normal case at once.
const REPLY_FLUSH_CAP_MS = 120_000;
// fs.watch can coalesce/miss events on some filesystems, so a slow poll backs it up. Promptness comes from
// the watch; this only bounds how long a missed event can stall us.
const FLUSH_POLL_MS = 1_000;

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

  // Last derived working state, cached so buildThreadInfo (and any registerThread caller) reflects it
  // without re-reading the transcript. Authoritatively recomputed in emitStatus.
  private lastWorking = false;

  // The ONLY state we keep of our own; everything the phone shows is projected from Claude's transcript.
  //  - `audio`: synthesized reply audio keyed by native reply uuid, for tap-to-play + reconnect.
  //  - `lastTranscriptPath`: the transcript the hooks last pointed us at, so `sync` can re-project without
  //    a hook firing.
  //  - `pending`: spoken prompts we injected, each tracked until its reply is spoken. While a prompt isn't
  //    yet visible in the transcript it shows as an OPTIMISTIC row (`id`/`ts`); on its UserPromptSubmit we
  //    BIND it to that native user record (`userUuid`/`userTs`) — from then on it's identified by native
  //    uuid, not text, so a duplicate phrase or a terminal-typed collision can't mis-speak or mis-retire.
  //  - `spoken`: reply uuids already spoken, so re-projecting on every event never double-speaks.
  //  - `floor`: epoch ms below which projected turns are hidden (set on /clear|/compact so a new topic
  //    doesn't show the previous one still sitting in the transcript tail).
  private readonly audio = new Map<string, Audio>();
  private lastTranscriptPath?: string;
  // The transcript size as of our last read. Captured as a turn's `openOffset` when it opens (the prompt is
  // written just after this point), so the turn — however large it grows — is always read back in full.
  // Undefined until the first read, so the first turn after a (re)start falls back to the tail.
  private lastEof?: number;
  private readonly pending: PendingVoice[] = [];
  private readonly spoken = new Set<string>();
  private floor = 0;
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
        // reply), /reset (SessionStart on clear/compact → wipe history), /spawn (the spawn skill).
        const route = req.method === "POST" ? req.url : undefined;
        if (
          route !== "/turn-open" &&
          route !== "/turn-progress" &&
          route !== "/turn-close" &&
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
              if (transcriptPath) this.lastTranscriptPath = transcriptPath;
              const realPrompt = typeof prompt === "string" ? prompt : "";
              this.turns.turnOpened(realPrompt);
              this.bindVoicePrompt(realPrompt); // mark the turn ours + record its read floor (openOffset)
              this.projectAndEmit(); // the new user turn is in the transcript now → show it, keyed natively
            } else if (route === "/turn-progress") {
              // PreToolUse: Claude wrote a step (narration) before this tool call → re-project so it shows
              // live, and (if opted in) speak it on a voice turn.
              const { transcriptPath } = JSON.parse(body || "{}") as { transcriptPath?: string };
              if (transcriptPath) this.lastTranscriptPath = transcriptPath;
              const turns = this.projectedNow();
              this.sendToBrowser(this.historyFrom(turns));
              this.speakNewSteps(turns);
            } else {
              const { transcriptPath } = JSON.parse(body || "{}") as { transcriptPath?: string };
              if (transcriptPath) this.lastTranscriptPath = transcriptPath;
              this.turns.turnClosed();
              void this.handleTurnClose(); // re-project (waiting for the flush) + speak a voice reply
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
    this.spoken.clear();
    this.pending.length = 0;
    // /clear or /compact ends the current topic: drop every in-flight/queued/open turn (so a stale
    // turn can't be spoken or wedge the idle-gate) — reset() also re-emits idle status.
    this.turns.reset();
    console.error("[reset] cleared voice history for this thread (/clear or /compact)");
    this.projectAndEmit();
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
        // the queue (a late Stop for a dropped turn lands on an empty FIFO and is ignored).
        await cmuxInterrupt(this.init.surface);
        this.pending.length = 0;
        this.turns.interrupt();
        this.projectAndEmit();
        return;
      case "sync":
        // The phone (re)connected and wants the current state. Replaces a heartbeat (the daemon otherwise
        // emits status only on change, which a fresh phone misses), then re-projects the thread so a
        // refresh / 2nd browser restores it. Only emit history once we know the transcript path: a `history`
        // snapshot is authoritative (the phone replaces with it), so emitting an empty one before the first
        // hook of a freshly-(re)started daemon would wipe the phone's thread. Text only — audio on demand,
        // EXCEPT a voice reply we never got to speak (its answer landed after the turn-close settle window,
        // or the phone was backgrounded when it did): speak it now so a reconnect/refresh isn't left with a
        // silent final answer. Idempotent (`spoken`), so a reconnect never re-speaks an already-spoken one.
        this.emitStatus();
        if (this.lastTranscriptPath) {
          const turns = this.projectedNow();
          this.sendToBrowser(this.historyFrom(turns));
          this.speakReadyVoiceReplies(turns);
        }
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
    if (mode === "interrupt") await cmuxInterrupt(this.init.surface); // Esc the running turn, run this next
    this.queueVoice(transcript, mode);
  }

  // Queue a spoken prompt: track it (so we know to speak its reply when it lands), then hand it to the
  // injection queue. Tracking is reply bookkeeping only — the phone shows the words instantly via its own
  // stt_echo (sent from handleAudio), and the conversation itself is projected from the transcript.
  private queueVoice(text: string, mode: InjectMode): void {
    if (mode === "interrupt") this.pending.length = 0; // Esc dropped the backlog → its reply tracking goes too
    this.pending.push({ text });
    while (this.pending.length > MAX_PENDING_VOICE) this.pending.shift();
    if (mode === "interrupt") this.turns.interruptWith(text);
    else this.turns.enqueueVoice(text);
    this.projectAndEmit();
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
    // The coordinator releases its slot; drop the prompt we couldn't deliver (it never reached the
    // transcript) so its optimistic row doesn't linger and can't be mis-bound later.
    const i = this.pending.findIndex((p) => p.userUuid === undefined && p.text.trim() === text.trim());
    if (i >= 0) this.pending.splice(i, 1);
    // Don't hard-fail "listening" on one send: re-probe (only a positive pane-gone verdict flips it).
    void this.refreshCmuxHealth();
    this.sendToBrowser({
      type: "error",
      message: "Couldn't reach the Claude Code pane (is it still open in cmux?)."
    });
    this.projectAndEmit();
    return false;
  }

  // ---- transcript projection (the conversation source of truth) --------------

  // Project the transcript into the phone thread and send it, then refresh the derived working lamp from
  // the same ground truth. Called on every turn event + on sync, so the phone's view AND its lamp always
  // converge together. Pure read; never throws into the caller.
  private projectAndEmit(): void {
    const turns = this.projectedNow();
    this.sendToBrowser(this.historyFrom(turns));
    this.emitStatus(turns); // reuse the same projection — no second file read
  }

  // Project the transcript for display/reply resolution. `captureFloor` advances `lastEof` — the byte
  // anchor the NEXT turn-open captures as its read floor (see bindVoicePrompt). Only the canonical display
  // path captures it; a pure read (the working-lamp derivation) must pass false, or a read landing between
  // a prompt being written and bindVoicePrompt would push the floor PAST the prompt and lose the reply.
  private projectedNow(captureFloor = true): ProjectedTurn[] {
    if (!this.lastTranscriptPath) return [];
    // Read from the start of the oldest open voice turn (so its prompt is always present for the reply
    // match, however large the turn) or the tail (recent history for the phone).
    const { turns, eof } = projectTranscript(this.lastTranscriptPath, MAX_PROJECTED_TURNS, this.voiceReadFloor());
    if (captureFloor) this.lastEof = eof;
    // Hide the start-skill's "voice remote is live" QR/URL reply — it's noise on the phone (and must
    // never be spoken). Matched on our own session URL, so it's prose-independent. See the helper.
    return dropSessionAnnouncement(
      turns.filter((t) => t.timestamp >= this.floor),
      this.init.browserUrl
    );
  }

  // The earliest read floor among voice turns still awaiting their reply — so projectedNow reads from the
  // start of the oldest unresolved voice turn, guaranteeing its prompt record is present for the identity
  // match no matter how much the turn wrote. Undefined when no voice turn is open → projectedNow uses the
  // tail. Once a turn's reply is spoken its entry is dropped, so the window shrinks back to the tail.
  private voiceReadFloor(): number | undefined {
    let floor: number | undefined;
    for (const p of this.pending) {
      if (p.opened && p.openOffset !== undefined)
        floor = floor === undefined ? p.openOffset : Math.min(floor, p.openOffset);
    }
    return floor;
  }

  // Mark a just-opened turn as ours if it matches a queued voice prompt (by the hook's REAL prompt text —
  // the one authoritative point where text is trusted, at the instant the turn opens). We also record the
  // turn's read floor: `lastEof` is the transcript size as of our previous read, i.e. just BEFORE this
  // prompt was written, so reading from there always includes the prompt (and everything the turn goes on to
  // write). From here the entry is bound to its native user record by uuid (bindPending), so duplicates /
  // terminal collisions can't mis-target it.
  private bindVoicePrompt(prompt: string): void {
    const text = prompt.trim();
    if (!text) return;
    const entry = this.pending.find((p) => !p.opened && p.text.trim() === text);
    if (entry) {
      entry.opened = true;
      entry.openOffset = this.lastEof;
    }
  }

  // Bind each opened-but-unbound voice entry to its native user record (the newest matching one not already
  // claimed), capturing its uuid + timestamp. Runs on every projection, so a prompt whose record wasn't
  // flushed at turn-open binds as soon as it appears.
  //
  // Two tolerances make the merged/glued-prompt case work (Claude Code combined two fast utterances "A" and
  // "B" into one on-path "A.B" record, leaving "A" a dead/orphaned sibling the active branch drops):
  //   1. A binding whose native record fell OFF the active branch (the entry bound to "A" at turn-open,
  //      before "A.B" existed, then "A" became an orphan) is released so it can re-bind below.
  //   2. The match is substring-tolerant — the native turn CONTAINS the injected text — so the entry
  //      re-binds to the surviving "A.B" ("A.B" contains "A"). The reply then resolves and is spoken once.
  private bindPending(turns: ProjectedTurn[]): void {
    const present = new Set(turns.map((t) => t.uuid));
    for (const entry of this.pending) {
      if (entry.userUuid && !present.has(entry.userUuid)) {
        entry.userUuid = undefined; // its record fell off the active branch → re-bind to the survivor
        entry.userTs = undefined;
      }
    }
    const claimed = new Set(this.pending.map((p) => p.userUuid).filter(Boolean));
    // Bind in two passes so an EXACT match always wins over a substring one. Otherwise a short prompt
    // ("status") could claim a longer turn ("status of the build") and starve the longer prompt's own
    // entry, mis-speaking or losing a reply. Pass 1: exact. Pass 2: substring for whatever's left — the
    // merged/glued survivor "A.B" (no exact match for injected "A") binds because it CONTAINS "A".
    const bindBy = (matches: (turnText: string, entryText: string) => boolean): void => {
      for (const entry of this.pending) {
        if (!entry.opened || entry.userUuid) continue;
        for (let i = turns.length - 1; i >= 0; i--) {
          const t = turns[i];
          if (t.role !== "user" || claimed.has(t.uuid)) continue;
          if (matches(t.text.trim(), entry.text.trim())) {
            entry.userUuid = t.uuid;
            entry.userTs = t.timestamp;
            claimed.add(t.uuid);
            break;
          }
        }
      }
    };
    bindBy((turnText, entryText) => turnText === entryText);
    bindBy((turnText, entryText) => turnText.includes(entryText));
  }

  // Build the `history` snapshot — a PURE PROJECTION of the transcript's active branch, nothing else. The
  // phone reconciles its instant stt_echo against this (dropping the echo once the real row appears), so the
  // daemon never emits a daemon-side row that could orphan. We still bind pending voice prompts here, but
  // only for reply resolution (see bindPending) — they are never rendered.
  private historyFrom(turns: ProjectedTurn[]): Extract<DaemonToBrowserEvent, { type: "history" }> {
    this.bindPending(turns);
    return {
      type: "history",
      turns: turns.map((t) => ({
        requestId: t.uuid,
        timestamp: t.timestamp,
        role: t.role,
        text: t.text,
        hasAudio: this.audio.has(t.uuid),
        interim: t.interim
      }))
    };
  }

  // "read every step" is on AND a VOICE turn is in progress → speak its newly-appeared steps as they land
  // (final replies still speak via handleTurnClose). Gated to the in-flight voice turn (steps after its
  // prompt) so turning the toggle on doesn't read out a backlog, and a terminal-typed turn is never read.
  private speakNewSteps(turns: ProjectedTurn[]): void {
    if (this.speakMode !== "all") return;
    const voice = this.pending.find((p) => p.opened && p.userTs !== undefined);
    if (!voice) return;
    for (const t of turns) {
      if (!t.interim || this.spoken.has(t.uuid) || t.timestamp < (voice.userTs ?? 0)) continue;
      this.remember(this.spoken, t.uuid, SPOKEN_UUID_CAP);
      void this.speak(t.uuid, t.text);
    }
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

  // After a turn closes: wait until every voice turn we're tracking has its FINAL reply flushed, then
  // re-project and speak each unspoken voice reply. We wait on POSITIVE evidence (the answer record is in
  // the transcript) reacting to the actual file write — never a fixed timeout — because the Stop hook can
  // fire long before the answer TEXT lands (an extended-thinking turn flushes the thinking block as its own
  // `end_turn` record first, then streams the answer seconds-to-minutes later). Replies are matched to our
  // prompts by native uuid (the prompt is always in the read window — see voiceReadFloor), so a duplicate
  // phrase / terminal-typed turn can't be mis-spoken; `spoken` makes it idempotent + self-healing.
  private async handleTurnClose(): Promise<void> {
    if (!this.lastTranscriptPath) return;
    this.sendToBrowser(this.historyFrom(this.projectedNow())); // show the turn promptly, before the reply
    await this.waitForTranscript(() => this.repliesSettled(), REPLY_FLUSH_CAP_MS);
    const turns = this.projectedNow();
    this.sendToBrowser(this.historyFrom(turns));
    this.emitStatus(turns); // the reply has flushed → the lamp flips to idle from the transcript
    this.speakReadyVoiceReplies(turns);
  }

  // True once every opened voice prompt we're tracking has its final reply present in the transcript. Binds
  // pending entries as it goes, so the wait both binds the prompt's uuid and detects its answer.
  private repliesSettled(): boolean {
    const turns = this.projectedNow();
    this.bindPending(turns);
    return this.pending.every((p) => !p.opened || this.findReply(turns, p) !== undefined);
  }

  // Resolve when `ready()` is true, driven by the transcript's actual writes (fs.watch) so we react the
  // instant a record flushes — no fixed-timeout guessing, and an answer that streams in long after the Stop
  // hook is still caught. A slow poll backs up fs.watch (it can coalesce/miss events on some filesystems);
  // `capMs` is the backstop for the abnormal case where the awaited record never arrives. Resolves at once
  // when already ready (the common case: the answer was flushed before the Stop hook fired) or once the
  // daemon is stopping, so a pending wait can never keep a torn-down daemon's event loop alive.
  private waitForTranscript(ready: () => boolean, capMs: number): Promise<void> {
    return new Promise((resolve) => {
      const path = this.lastTranscriptPath;
      if (!path || this.stopped || ready()) return resolve();
      let watcher: FSWatcher | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      let cap: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        watcher?.close();
        if (poll) clearInterval(poll);
        if (cap) clearTimeout(cap);
        resolve();
      };
      const check = () => {
        if (this.stopped || ready()) finish();
      };
      try {
        watcher = watch(path, check);
      } catch {
        // fs.watch unsupported here → the poll alone carries it
      }
      poll = setInterval(check, FLUSH_POLL_MS);
      cap = setTimeout(finish, capMs);
    });
  }

  // Speak the FINAL reply of every opened voice prompt whose answer has now flushed, retiring its pending
  // entry. Idempotent via `spoken`, and it only ever resolves a final reply (never an interim step), so a
  // voice entry whose answer hasn't landed yet is left untouched — to be spoken when it does, on the turn
  // close OR a later event (a reconnect `sync`, the next turn). That late-retry is what saves the reply
  // when the answer streams in after the settle window (a long extended-thinking turn).
  private speakReadyVoiceReplies(turns: ProjectedTurn[]): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const entry = this.pending[i];
      if (!entry.opened) continue;
      const reply = this.findReply(turns, entry);
      if (!reply || this.spoken.has(reply.uuid)) continue;
      this.pending.splice(i, 1);
      this.remember(this.spoken, reply.uuid, SPOKEN_UUID_CAP);
      // ALWAYS synthesize the final reply — synthesis is independent of autoplay. The phone's autoplay
      // setting decides only whether the arriving audio plays by itself or waits for a tap; it must NOT
      // suppress synthesis (else "off" would leave nothing to tap-play — the bug this fixes). speakMode
      // still gates auto-reading interim STEPS (see speakNewSteps), which is a separate "all" behaviour.
      void this.speak(reply.uuid, reply.text);
    }
  }

  // The reply to a bound voice prompt (see resolveVoiceReply): the FINAL reply whose immediately-preceding
  // user record IS our prompt (by uuid). NEVER an interim step. Undefined until the answer text has flushed.
  private findReply(turns: ProjectedTurn[], entry: PendingVoice): ProjectedTurn | undefined {
    return resolveVoiceReply(turns, entry.userUuid);
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

  // Synthesize a reply/step's audio, retain it (keyed by native uuid) for tap-to-play + reconnect, and
  // push it to the phone to auto-play now.
  private async speak(uuid: string, text: string): Promise<void> {
    // Tell the phone audio is on its way so the message shows a loading indicator until it lands.
    this.sendToBrowser({ type: "tts_status", requestId: uuid, state: "pending" });
    try {
      const { audioBase64, mimeType } = await synthesizeSpeech(this.init.config, capForSpeech(text));
      if (!audioBase64) return; // nothing to synthesize (empty/whitespace reply)
      this.storeAudio(uuid, { audioBase64, mimeType });
      this.sendToBrowser({ type: "tts_audio", requestId: uuid, audioBase64, mimeType });
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
      state: this.lastWorking ? "working" : "idle", // cached from the last emitStatus (transcript-derived)
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

  // Working = our injection hasn't landed yet (the gap before the transcript catches up), OR the pane is
  // mid-turn (the inject gate's `isBusy`) AND the transcript's active branch shows the newest user turn
  // still awaiting its final reply. The AND is the whole robustness story: a missed Stop leaves `isBusy`
  // stuck, but the transcript going idle (a final reply landed) still flips it; an interrupt clears
  // `isBusy`, so the lamp idles at once; and the transcript can't read "working" past a real reply.
  private isWorking(turns: ProjectedTurn[]): boolean {
    return this.turns.hasInFlight || (this.turns.isBusy && isPaneWorking(turns));
  }

  // Status carries this thread's id (so the phone files it correctly); a thread_register rides along to keep
  // the roster's state/listening in lockstep. Pass the turns already projected this cycle to avoid a
  // re-read; callers without them fall back to a pure read (no floor move).
  private emitStatus(turns?: ProjectedTurn[]): void {
    const working = this.isWorking(turns ?? this.projectedNow(false));
    this.lastWorking = working;
    const state: SessionState = {
      sessionId: this.init.sessionId,
      listening: this.cmuxHealthy,
      state: working ? "working" : "idle"
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
