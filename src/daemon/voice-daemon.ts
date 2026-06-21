import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type {
  BridgeEnvelope,
  BrowserToDaemonEvent,
  DaemonToBrowserEvent,
  InjectMode,
  SessionState,
  ThreadId,
  ThreadInfo
} from "../shared/protocol.js";
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
import { buildHistoryEvent, HistoryRing, selectAudioReply } from "./history-ring.js";
import { computeLabel } from "./labels.js";
import { synthesizeSpeech, transcribeAudio } from "./openai.js";
import { renderQr } from "./qr.js";
import { TurnCoordinator } from "./turn-coordinator.js";

// Reconnect backoff for transient bridge drops (network blips, worker redeploys).
// A terminal close (1008) is handled separately and does not reconnect.
const RECONNECT_DELAY_MS = 1500;
// How often the daemon re-resolves its cmux pane so `listening` self-heals (a moved
// pane / transient cmux hiccup recovers automatically instead of latching false).
const CMUX_HEALTH_INTERVAL_MS = 5000;
// Replies are no longer truncated for speech: synthesizeSpeech chunks anything past the
// per-call TTS input limit on sentence boundaries and concatenates the audio. This is a
// pure safety ceiling — far above any normal coding reply — to bound the number of TTS
// calls (and so cost/latency) if some runaway output arrives. ~40k chars ≈ 10 chunks.
const MAX_SPEECH_CHARS = 40_000;
// How many of the most recent Claude replies (with their parent user messages) the daemon
// retains so a refreshed/2nd phone can restore the thread on reconnect. Tunable: bigger =
// more scrollback survives a refresh, at the cost of holding more reply audio in memory.
const HISTORY_REPLIES = 7;

// This module's plugin-load root, derived from its own location: bundled, the daemon runs at
// <root>/dist/daemon/standalone.js; in dev at <root>/src/daemon/voice-daemon.ts — three dirs up is
// <root> either way. Only used to point a spawned `claude` at a `--plugin-dir`-loaded plugin (below).
const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// In DEV the plugin is loaded with `--plugin-dir`, so a spawned `claude` must be pointed at it too —
// Claude Code marks an `--plugin-dir` load with an `-inline` suffix on the plugin-data dir
// (stateDir()). An INSTALLED plugin is global to every `claude`, so passing `--plugin-dir` would be
// redundant/wrong: omit it. So the directory is added ONLY for an inline (dev) load.
const PLUGIN_DIR_ARG = stateDir().endsWith("-inline") ? `--plugin-dir '${PLUGIN_ROOT}' ` : "";

// The permission modes Claude Code accepts for `--permission-mode` (the same vocabulary it reports
// in hook input as `permission_mode`). We pass the spawning session's live mode straight through so a
// spawned thread inherits it EXACTLY. Allowlisted because the value is interpolated into the spawn
// command — an unrecognized value is dropped (spawn falls back to the user's default) not passed on.
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);

// Build the `--permission-mode` fragment for the spawn command (trailing space so it concatenates).
// Allowlisted: a missing or unrecognized mode yields "" — the spawn falls back to the user's default
// rather than interpolating an unknown value into the spawned command. Exported for tests.
export function permissionModeArg(mode?: string): string {
  return mode && PERMISSION_MODES.has(mode) ? `--permission-mode ${mode} ` : "";
}

export type DaemonInit = {
  config: VoiceRemoteConfig;
  surface?: string;
  // Non-secret, stable per pane: the thread's routing key (its CMUX_SURFACE_ID, or a
  // per-process uuid outside cmux). Tags every event so the phone attributes it to one thread
  // and a reconnecting pane re-registers to the SAME slot. NOT the session secret.
  threadId: ThreadId;
  // The whole capability: one MACHINE-level secret (session.json) that both routes the
  // session and authorizes joining it. Shared by every pane → every pane derives the same
  // phone URL/QR. Carried in the URL path; never sent over the wire as a separate value.
  secret: string;
  // A short, non-secret label derived from `secret` (its hash). Safe to relay in status
  // events and log; never the secret itself.
  sessionId: string;
  browserUrl: string;
};

/**
 * Build the daemon init from config and the current cmux pane. The secret is the SHARED
 * machine secret (loadOrCreateSession), so every pane derives the same URL/QR (TODO #2).
 * `threadId = CMUX_SURFACE_ID` (already the cmux `--surface` target) so a re-quit pane
 * re-registers to the same thread; outside cmux we fall back to a per-process uuid (loses
 * dedup-on-reconnect, never collides).
 */
export function createDaemonInit(config: VoiceRemoteConfig): DaemonInit {
  const surface = process.env.CMUX_SURFACE_ID;
  const threadId = surface ?? randomUUID();
  const { secret, sessionId } = loadOrCreateSession();
  const browserUrl = toBrowserUrl(config.bridgeUrl, secret);
  return { config, surface, threadId, secret, sessionId, browserUrl };
}

/**
 * Voice daemon for the cmux-hosted interactive Claude Code session.
 *
 * Phone speaks → OpenAI STT → `cmux send` types it into the live Claude pane
 * as a real user message. The plugin Stop hook POSTs Claude's reply back here →
 * OpenAI TTS → phone. It is the real interactive session — no turn-hijack.
 *
 * Critically, this runs *inside Claude Code's process tree* (hosted as a background
 * Bash task by `/voice-control:start`), so it keeps cmux's socket trust AND dies with
 * the Claude session: a detached/`nohup` process would be reparented to launchd and
 * would both lose cmux's trust and outlive the session.
 *
 * Logging goes to stderr (teed to ${stateDir}/daemon.log by the entry point); the
 * standalone entry reserves stdout for its short "voice active" banner.
 */
export class VoiceDaemon {
  private readonly init: DaemonInit;
  private ws?: WebSocket;
  private httpServer?: Server;
  private port = 0;
  // `cmuxHealthy` drives the phone's "listening" lamp; it starts optimistic (true)
  // and only drops on a POSITIVE "pane gone" verdict (see refreshCmuxHealth).
  // `cmuxReachable` tracks the socket separately, purely so we log its transitions
  // without spamming and without ever locking the user out on an ambiguous blip.
  private cmuxHealthy = true;
  private cmuxReachable = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  // The turn state machine (inject queue, open-turn FIFO, classification, dedup, reaping). All the
  // turn logic lives here, driven by the two hooks; the daemon just wires its side-effects (type into
  // cmux, speak/mirror a reply, re-emit status). See turn-coordinator.ts.
  private readonly turns: TurnCoordinator;

  // The spawning session's LIVE permission mode, forwarded by the Stop hook each turn. A spawned
  // thread is launched with `--permission-mode <this>` so it inherits the user's mode EXACTLY (a
  // child `claude` does not inherit it via env/process tree). Undefined until the first turn reports
  // it — until then a spawn omits the flag and falls back to the user's own default mode.
  private inheritedPermissionMode?: string;

  // If THIS daemon was spawned by another (phone "+" / spawn skill), it was launched with a
  // VOICE_SPAWN_ID env var. We send it once, in our FIRST thread_register, so the phone can follow
  // the exact thread it asked for (then clear it — refreshes don't carry it).
  private pendingSpawnId = process.env.VOICE_SPAWN_ID;

  // The durable conversation thread: the last HISTORY_REPLIES Claude replies (with audio)
  // plus their parent user messages. A reconnecting phone is caught up from this via a
  // `history` event, and reply audio is served from it on demand (`get_audio`). Replaces
  // the single-reply retention that lost the whole thread on a refresh.
  private readonly history = new HistoryRing(HISTORY_REPLIES);

  // Last-computed thread label (repo·branch·cwd · cmux task title). Sent in thread_register
  // on connect and refreshed on the cmux-health tick when the title changes (no extra timer).
  // Starts with a cheap synchronous fallback so registration never blocks on git/cmux.
  private label: ThreadInfo["label"];

  constructor(init: DaemonInit) {
    this.init = init;
    this.label = { title: init.threadId };
    this.turns = new TurnCoordinator({
      inject: (text) => this.injectIntoPane(text),
      speakReply: (reply) => void this.speak(this.emitClaudeTurn(reply), reply),
      mirrorTypedTurn: (prompt, reply) => {
        // The user typed this in the terminal: show their REAL prompt, then speak the reply (their pick).
        this.emitUserTurn(prompt, true);
        void this.speak(this.emitClaudeTurn(reply), reply);
      },
      onStatusChange: () => this.emitStatus(),
      log: (message) => console.error(message)
    });
  }

  get browserUrl(): string {
    return this.init.browserUrl;
  }

  async start(): Promise<void> {
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

  // Re-resolve the cmux pane on a timer so `listening` always reflects reality and
  // self-heals. Two design rules learned the hard way:
  //
  //  1. OPTIMISTIC. We only declare "not listening" when cmux POSITIVELY confirms the
  //     pane is gone (identify resolves but the surface no longer exists). A cmux
  //     socket that's merely unreachable this tick (cold CLI, app momentarily busy)
  //     keeps us listening — locking the user out on an ambiguous signal is the bug
  //     that made a perfectly-alive pane read "Claude isn't listening". If cmux is
  //     truly down, the next injection fails and tells the user *then*.
  //  2. SELF-HEALING. The surface ref is stable across a workspace move, so a re-probe
  //     re-validates it and recovers on its own — no restart, no user action.
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
        if (route !== "/turn-open" && route !== "/turn-close" && route !== "/reset" && route !== "/spawn") {
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
          try {
            if (route === "/turn-open") {
              const { prompt, permissionMode } = JSON.parse(body || "{}") as {
                prompt?: string;
                permissionMode?: string;
              };
              // Remember the live permission mode so a spawn during this turn inherits it EXACTLY.
              if (typeof permissionMode === "string" && PERMISSION_MODES.has(permissionMode)) {
                this.inheritedPermissionMode = permissionMode;
              }
              this.turns.turnOpened(typeof prompt === "string" ? prompt : "");
            } else {
              const { reply, replyUuid } = JSON.parse(body || "{}") as { reply?: string; replyUuid?: string };
              this.turns.turnClosed(
                typeof reply === "string" ? reply : "",
                typeof replyUuid === "string" ? replyUuid : undefined
              );
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
      console.error(`[qr] render failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Per-thread runtime file (runtime/<surfaceId>.json) so panes don't clobber each other's
    // port/pid and this pane's Stop/reset hooks reach THIS daemon.
    writeFileSync(
      threadRuntimePath(this.init.surface),
      JSON.stringify(
        { port: this.port, pid: process.pid, surface: this.init.surface ?? null, sessionUrl: this.init.browserUrl },
        null,
        2
      )
    );
  }

  // Handle a /reset POST (SessionStart on clear/compact): a new topic in the SAME pane, so wipe
  // the voice history and push an empty `history` so the phone drops the stale thread view.
  private handleReset(): void {
    this.history.clear();
    // /clear or /compact ends the current topic: drop every in-flight/queued/open turn (so a stale
    // turn can't be spoken or wedge the idle-gate) — reset() also re-emits idle status.
    this.turns.reset();
    console.error("[reset] cleared voice history for this thread (/clear or /compact)");
    this.sendToBrowser(buildHistoryEvent(this.history));
  }

  // ---- bridge ----------------------------------------------------------------

  private connectBridge(): void {
    if (this.stopped) return;
    // Pass the threadId on the connect URL so the DO attaches it before the first message —
    // browser→daemon routing keys on it from the very first send.
    const url = toWebSocketUrl(this.init.config.bridgeUrl, this.init.secret, "daemon", this.init.threadId);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      // Register this thread with the DO (so the roster lists it) BEFORE the first status, then
      // refresh the label asynchronously — git/cmux must never block the socket coming up.
      this.registerThread();
      this.emitStatus();
      void this.refreshLabel();
    });
    ws.on("message", (raw) => {
      let envelope: { channel?: string; threadId?: ThreadId; event?: BrowserToDaemonEvent };
      try {
        envelope = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Only act on events addressed to THIS thread (the DO routes browser→one daemon by
      // threadId, but guard here too so a mis-tagged envelope can't drive the wrong pane).
      if (envelope.channel === "daemon" && envelope.event && envelope.threadId === this.init.threadId) {
        this.handleBrowserEvent(envelope.event).catch((error) => this.sendError(error));
      }
    });
    ws.on("close", (code) => {
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
        this.turns.enqueueVoice("Give me a brief spoken status of what you're doing right now.");
        return;
      case "summary_request":
        this.turns.enqueueVoice("Briefly summarize what you've done so far, for the phone.");
        return;
      case "stop_task":
        // Esc the running turn → Claude goes idle; the coordinator drops every open turn and drains
        // the queue (a late Stop for a dropped turn lands on an empty FIFO and is ignored).
        await cmuxInterrupt(this.init.surface);
        this.turns.interrupt();
        return;
      case "sync":
        // The phone (re)connected and wants the current state. Replaces a heartbeat:
        // the daemon otherwise emits status only on change, which a fresh phone misses.
        // Then send the retained thread so a refresh / 2nd browser restores history. Text
        // only — no audio is pushed here (iOS reconnects constantly; the phone fetches each
        // reply's audio on demand via `get_audio`, which it treats as tap-to-play).
        this.emitStatus();
        this.sendToBrowser(buildHistoryEvent(this.history));
        return;
      case "get_audio":
        // Tap-to-play on a row whose audio isn't cached locally: serve it from the ring, or
        // tell the phone gracefully when it has been evicted.
        this.sendToBrowser(selectAudioReply(this.history, event.requestId));
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

  // Spawn a sibling thread via a new cmux workspace, inheriting this session's permission mode
  // (buildSpawnCommand). cwd defaults to THIS daemon's cwd (a new session "next to" the current
  // one). Returns the new workspace ref; the spawned pane's own daemon registers itself once it
  // connects. Callers decide how to surface a failure (phone error, or the /spawn HTTP response).
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
      console.error(`[spawn] request failed: ${error instanceof Error ? error.message : String(error)}`);
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false }));
    }
  }

  // The command a spawned cmux workspace runs to join this session as a new thread.
  //   VOICE_SPAWN_ID=<id>     a one-shot correlation id the new daemon echoes in its first register
  //                           so the phone follows THIS exact thread (read through claude → the start
  //                           skill's background task). cmux runs --command in a shell, so the env
  //                           prefix takes effect.
  //   --plugin-dir <root>     dev-only (see PLUGIN_DIR_ARG); installed plugins are global → omitted.
  //   --permission-mode <m>   mirrors the spawning session's LIVE mode (from the turn-open hook) so
  //                           the new session has the SAME permissions the user already granted.
  //   /voice-control:start    a positional slash command — auto-submits + runs on startup (verified).
  // cmux must focus the new workspace (spawnWorkspace passes --focus true) to start the command; the
  // workspace uses the spawning pane's cwd (already trusted), so there's no first-run trust gate.
  private buildSpawnCommand(spawnId: string): string {
    return `VOICE_SPAWN_ID=${spawnId} claude ${PLUGIN_DIR_ARG}${permissionModeArg(this.inheritedPermissionMode)}/voice-control:start`;
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
    // Record + echo the user turn so the phone shows it and can reconcile it against history.
    this.emitUserTurn(transcript);
    if (mode === "interrupt") {
      await cmuxInterrupt(this.init.surface); // Esc the running turn, then run this transcript next
      this.turns.interruptWith(transcript);
    } else {
      this.turns.enqueueVoice(transcript);
    }
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
    // Don't hard-fail "listening" on one send: re-probe (only a positive pane-gone verdict flips it).
    void this.refreshCmuxHealth();
    this.sendToBrowser({
      type: "error",
      message: "Couldn't reach the Claude Code pane (is it still open in cmux?)."
    });
    return false;
  }

  // Add a user turn to the ring and echo it live so the phone shows it (and can reconcile it against
  // history). Used for both a voice transcript and a mirrored terminal-typed message.
  private emitUserTurn(text: string, mirrored = false): void {
    const entry = this.history.add("user", randomUUID(), text);
    this.sendToBrowser({
      type: "transcript",
      requestId: entry.requestId,
      seq: entry.seq,
      timestamp: entry.timestamp,
      text,
      mirrored
    });
  }

  // Add a Claude reply to the ring and echo it live; returns its requestId so the caller can attach
  // synthesized audio (voice turns auto-speak; mirrored terminal replies stay text-only).
  private emitClaudeTurn(text: string): string {
    const entry = this.history.add("claude", randomUUID(), text);
    this.sendToBrowser({
      type: "claude_reply",
      requestId: entry.requestId,
      seq: entry.seq,
      timestamp: entry.timestamp,
      text
    });
    return entry.requestId;
  }

  private async speak(requestId: string, text: string): Promise<void> {
    try {
      const { audioBase64, mimeType } = await synthesizeSpeech(this.init.config, capForSpeech(text));
      // An empty result means there was nothing to synthesize (empty/whitespace reply) — no audio.
      if (!audioBase64) return;
      // Stash the audio on the matching reply entry so a reconnecting phone can fetch it on
      // demand (no-op if the entry has since been evicted from the ring).
      this.history.attachAudio(requestId, { audioBase64, mimeType });
      this.sendToBrowser({ type: "tts_audio", requestId, audioBase64, mimeType });
    } catch (error) {
      // The text reply already reached the phone; surface the audio failure (don't swallow it) so a
      // config/model/rate-limit problem is visible instead of "the voice just didn't arrive".
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tts] synthesis failed for ${requestId}: ${message}`);
      this.sendToBrowser({
        type: "error",
        message: "Couldn't speak that reply — its text is shown, but audio failed."
      });
    }
  }

  // ---- thread registry -------------------------------------------------------

  // Snapshot of this thread for the DO roster: id + label + live state/listening. The DO
  // stores this and serves it to phones; the daemon keeps no roster of its own.
  private buildThreadInfo(): ThreadInfo {
    return {
      threadId: this.init.threadId,
      label: this.label,
      state: this.turns.isWorking() ? "working" : "idle",
      listening: this.cmuxHealthy,
      spawnId: this.pendingSpawnId
    };
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
    if (this.ws?.readyState === WebSocket.OPEN) this.registerThread();
  }

  // ---- helpers ---------------------------------------------------------------

  // Status carries this thread's id so the phone files it (and the roster's per-thread #10
  // grading) under the right thread; a thread_register also rides along so the roster's
  // state/listening stay current as the daemon's runtime state changes.
  private emitStatus(): void {
    const state: SessionState = {
      sessionId: this.init.sessionId,
      listening: this.cmuxHealthy,
      state: this.turns.isWorking() ? "working" : "idle"
    };
    this.sendToBrowser({ type: "session_status", state, memory: { currentTask: this.turns.currentVoicePrompt } });
    // Keep the roster's state/listening in lockstep with status (idle↔working, listening
    // flips) without a separate channel — register is the refresh path, deduped DO-side.
    if (this.ws?.readyState === WebSocket.OPEN) this.registerThread();
  }

  private sendToBrowser(event: DaemonToBrowserEvent): void {
    // Tag every outbound event with this daemon's threadId so the phone (and the DO) attribute
    // it to the right thread. The DO trusts the socket's attachment, but tagging keeps the
    // envelope self-describing and matches the browser→daemon direction.
    this.send({ channel: "browser", threadId: this.init.threadId, event });
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
    this.sendToBrowser({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
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
      // Remove only THIS pane's runtime file (sibling panes keep theirs). qr.txt is
      // machine-level: leave it as long as any pane might still be live — a sibling rewrites
      // identical bytes on its next tick, and a fully-idle machine's stale QR is harmless
      // (the DO revoke-on-exit kills the session it points at). Removing it here would yank
      // the QR out from under a still-running sibling pane.
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

// Safety ceiling only. Normal (even long) coding replies pass through untouched and are
// chunked by synthesizeSpeech; this just caps a pathological runaway output so it can't
// fan out into an unbounded number of TTS calls. The threshold is high enough that real
// replies are never truncated.
function capForSpeech(text: string): string {
  return text.length > MAX_SPEECH_CHARS ? `${text.slice(0, MAX_SPEECH_CHARS)}…` : text;
}
