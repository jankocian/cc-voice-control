import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
import { cmuxHealth, cmuxInterrupt, cmuxSubmit } from "./cmux.js";
import {
  loadOrCreateSession,
  qrPath,
  runtimeDir,
  threadRuntimePath,
  toBrowserUrl,
  toWebSocketUrl,
  type VoiceRemoteConfig
} from "./config.js";
import { buildHistoryEvent, HistoryRing, selectAudioReply } from "./history-ring.js";
import { computeLabel } from "./labels.js";
import { synthesizeSpeech, transcribeAudio } from "./openai.js";
import { renderQr } from "./qr.js";

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

  // One turn is injected at a time. `inFlight` is the exact prompt we typed and are
  // waiting for Claude to finish; `queue` holds prompts captured while a turn was
  // running. A reply is spoken only when its turn's user prompt matches `inFlight`,
  // so terminal-typed turns (and the activation skill's own output) are never read aloud.
  private inFlight?: string;
  private readonly queue: string[] = [];

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
        // Two POST routes, both from the plugin's hooks: /reply (Stop hook → speak the reply)
        // and /reset (SessionStart on clear/compact → wipe this pane's voice history).
        const route = req.method === "POST" ? req.url : undefined;
        if (route !== "/reply" && route !== "/reset") {
          res.statusCode = 404;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.statusCode = 204;
          res.end();
          if (route === "/reset") {
            this.handleReset();
            return;
          }
          try {
            const { prompt, text } = JSON.parse(body || "{}") as { prompt?: string; text?: string };
            this.onClaudeReply(typeof prompt === "string" ? prompt : "", typeof text === "string" ? text : "");
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
    this.inFlight = undefined; // the cleared topic's in-flight turn is moot after /clear.
    console.error("[reset] cleared voice history for this thread (/clear or /compact)");
    this.sendToBrowser(buildHistoryEvent(this.history));
    this.emitStatus();
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
        this.enqueue("Give me a brief spoken status of what you're doing right now.");
        return;
      case "summary_request":
        this.enqueue("Briefly summarize what you've done so far, for the phone.");
        return;
      case "stop_task":
        await this.interrupt();
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
      default:
        return;
    }
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
    // Record the user turn in the ring (seq + timestamp assigned there) and echo the live
    // transcript carrying those same fields so the phone can reconcile it against history.
    const entry = this.history.add("user", randomUUID(), transcript);
    this.sendToBrowser({
      type: "transcript",
      requestId: entry.requestId,
      seq: entry.seq,
      timestamp: entry.timestamp,
      text: transcript
    });
    if (mode === "interrupt") await this.interruptWith(transcript);
    else this.enqueue(transcript);
  }

  // ---- injection (one turn at a time) ---------------------------------------

  // Queue a prompt and start it if the pane is idle. Claude answers turns in order; we
  // never type a second prompt until the current one's reply has come back.
  private enqueue(text: string): void {
    this.queue.push(text);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.inFlight !== undefined) return; // a turn is already running
    const next = this.queue.shift();
    if (next === undefined) return;
    this.inFlight = next; // set before awaiting so a concurrent pump sees "busy"
    this.emitStatus();
    console.error(`[inject] surface=${this.init.surface ?? "(default $CMUX_SURFACE_ID)"} text=${JSON.stringify(next)}`);
    const ok = await cmuxSubmit(next, this.init.surface);
    console.error(`[inject] cmuxSubmit ok=${ok}`);
    if (ok) {
      // A successful inject positively proves the pane is alive — clear any stale
      // "not listening" without waiting for the next health tick.
      if (!this.cmuxHealthy) {
        this.cmuxHealthy = true;
        this.emitStatus();
      }
      return;
    }
    this.inFlight = undefined;
    // Don't hard-fail "listening" on one send: re-probe (only a positive pane-gone
    // verdict flips it). A transient send error stays optimistic and just retries.
    void this.refreshCmuxHealth();
    this.sendToBrowser({
      type: "error",
      message: "Couldn't reach the Claude Code pane (is it still open in cmux?)."
    });
    this.emitStatus();
    void this.pump(); // try the next queued prompt
  }

  // Esc the running turn and clear our in-flight marker. The cancelled turn's reply (if
  // any) won't match anything, so it won't be spoken.
  private async interrupt(): Promise<void> {
    await cmuxInterrupt(this.init.surface);
    this.inFlight = undefined;
    this.emitStatus();
    void this.pump();
  }

  // Interrupt the running turn and run `text` next, ahead of anything already queued.
  private async interruptWith(text: string): Promise<void> {
    await cmuxInterrupt(this.init.surface);
    this.inFlight = undefined;
    this.queue.unshift(text);
    void this.pump();
  }

  // Stop hook delivered a finished turn. Speak it only if it's the turn we injected;
  // turns typed directly in the terminal carry a prompt we never queued, so we stay quiet.
  private onClaudeReply(prompt: string, text: string): void {
    if (this.inFlight === undefined || prompt !== this.inFlight) return;
    console.error(`[reply] matched in-flight turn, ${text.length} chars`);
    this.inFlight = undefined;
    if (text) {
      // Record the reply in the ring (seq + timestamp assigned there) and emit the live
      // event carrying them so the phone reconciles it against history.
      const entry = this.history.add("claude", randomUUID(), text);
      this.sendToBrowser({
        type: "claude_reply",
        requestId: entry.requestId,
        seq: entry.seq,
        timestamp: entry.timestamp,
        text
      });
      void this.speak(entry.requestId, text);
    }
    this.emitStatus();
    void this.pump();
  }

  private async speak(requestId: string, text: string): Promise<void> {
    try {
      const { audioBase64, mimeType } = await synthesizeSpeech(this.init.config, capForSpeech(text));
      // Stash the audio on the matching reply entry so a reconnecting phone can fetch it on
      // demand (no-op if the entry has since been evicted from the ring).
      this.history.attachAudio(requestId, { audioBase64, mimeType });
      this.sendToBrowser({ type: "tts_audio", requestId, audioBase64, mimeType });
    } catch {
      // best-effort speech; the text reply already went through
    }
  }

  // ---- thread registry -------------------------------------------------------

  // Snapshot of this thread for the DO roster: id + label + live state/listening. The DO
  // stores this and serves it to phones; the daemon keeps no roster of its own.
  private buildThreadInfo(): ThreadInfo {
    return {
      threadId: this.init.threadId,
      label: this.label,
      state: this.inFlight !== undefined ? "working" : "idle",
      listening: this.cmuxHealthy
    };
  }

  // Tell the DO about this thread (register on connect, refresh on label/state change). The DO
  // dedups by threadId and broadcasts a roster delta; sending it again is the refresh path.
  private registerThread(): void {
    this.send({ channel: "registry", event: { type: "thread_register", info: this.buildThreadInfo() } });
  }

  // Recompute the label (repo·branch·cwd · cmux title) and re-register only if it changed, so
  // the cmux-health tick can call this every 5s without spamming the DO. Best-effort: a failed
  // compute keeps the last good label.
  private async refreshLabel(): Promise<void> {
    const next = await computeLabel(process.cwd(), this.init.surface, this.init.threadId);
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
      state: this.inFlight !== undefined ? "working" : "idle"
    };
    this.sendToBrowser({ type: "session_status", state, memory: { currentTask: this.inFlight } });
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
