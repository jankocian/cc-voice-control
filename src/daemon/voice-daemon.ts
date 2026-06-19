import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import type {
  BridgeEnvelope,
  BrowserToDaemonEvent,
  DaemonToBrowserEvent,
  InjectMode,
  SessionState
} from "../shared/protocol.js";
import { cmuxInterrupt, cmuxPing, cmuxSubmit } from "./cmux.js";
import { qrPath, runtimePath, stateDir, toBrowserUrl, toWebSocketUrl, type VoiceRemoteConfig } from "./config.js";
import { synthesizeSpeech, transcribeAudio } from "./elevenlabs.js";
import { renderQr } from "./qr.js";

// Reconnect backoff for transient bridge drops (network blips, worker redeploys).
// A terminal close (1008) is handled separately and does not reconnect.
const RECONNECT_DELAY_MS = 1500;
// Hard cap on spoken text so a huge reply can't blow past ElevenLabs limits.
const MAX_SPEECH_CHARS = 2500;

export type DaemonInit = {
  config: VoiceRemoteConfig;
  surface?: string;
  sessionId: string;
  token: string;
  browserUrl: string;
};

/** The latest reply, kept so a phone that missed it can be caught up on reconnect. */
type RetainedReply = { requestId: string; text: string; audio?: { audioBase64: string; mimeType: string } };

/**
 * Events to re-send so a reconnecting phone gets the latest reply it missed. Empty when
 * there is nothing to replay or the phone already has it (`lastSeenReplyId` matches). The
 * audio is flagged `replay` so the phone shows it for tap-to-play rather than auto-playing.
 */
export function selectMissedReply(
  lastReply: RetainedReply | undefined,
  lastSeenReplyId: string | undefined
): DaemonToBrowserEvent[] {
  if (!lastReply || lastReply.requestId === lastSeenReplyId) return [];
  const events: DaemonToBrowserEvent[] = [
    { type: "claude_reply", requestId: lastReply.requestId, text: lastReply.text }
  ];
  if (lastReply.audio)
    events.push({ type: "tts_audio", requestId: lastReply.requestId, replay: true, ...lastReply.audio });
  return events;
}

/** Build a fresh session (id, token, phone URL) from config and the current cmux pane. */
export function createDaemonInit(config: VoiceRemoteConfig): DaemonInit {
  const surface = process.env.CMUX_SURFACE_ID;
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const browserUrl = toBrowserUrl(config.bridgeUrl, sessionId, token);
  return { config, surface, sessionId, token, browserUrl };
}

/**
 * Voice daemon for the cmux-hosted interactive Claude Code session.
 *
 * Phone speaks → ElevenLabs STT → `cmux send` types it into the live Claude pane
 * as a real user message. The plugin Stop hook POSTs Claude's reply back here →
 * ElevenLabs TTS → phone. It is the real interactive session — no turn-hijack.
 *
 * Critically, this runs *inside Claude Code's process tree* (hosted by the plugin
 * MCP server), so it keeps cmux's socket trust AND dies with the Claude session: a
 * detached/`nohup` process would be reparented to launchd and would both lose cmux's
 * trust and outlive the session.
 *
 * IMPORTANT: never write to stdout here. When hosted as an MCP server, stdout is
 * the JSON-RPC channel; all logging goes to stderr.
 */
export class VoiceDaemon {
  private readonly init: DaemonInit;
  private ws?: WebSocket;
  private httpServer?: Server;
  private port = 0;
  private cmuxHealthy = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  // One turn is injected at a time. `inFlight` is the exact prompt we typed and are
  // waiting for Claude to finish; `queue` holds prompts captured while a turn was
  // running. A reply is spoken only when its turn's user prompt matches `inFlight`,
  // so terminal-typed turns (and the activation skill's own output) are never read aloud.
  private inFlight?: string;
  private readonly queue: string[] = [];

  // The most recent reply, retained so a phone that missed it (e.g. it finished while the
  // phone was asleep) can be caught up when it reconnects and sends `sync`.
  private lastReply?: RetainedReply;

  constructor(init: DaemonInit) {
    this.init = init;
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
    // Health-check cmux without blocking startup — a hung/missing cmux must not
    // prevent the daemon from coming up and showing the phone URL.
    void this.checkCmuxHealth();
  }

  private async checkCmuxHealth(): Promise<void> {
    this.cmuxHealthy = await cmuxPing();
    if (!this.cmuxHealthy)
      console.error("WARNING: cmux control socket is unreachable — injection will fail until cmux is running.");
    this.emitStatus();
  }

  // ---- local listener for the Stop hook -------------------------------------

  private startHookListener(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        if (req.method !== "POST" || req.url !== "/reply") {
          res.statusCode = 404;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.statusCode = 204;
          res.end();
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
    mkdirSync(stateDir(), { recursive: true });
    // Render the QR before runtime.json so it's guaranteed present once the start
    // skill (which waits on runtime.json) reads it. A render failure must never
    // block the URL, so it's best-effort — the plain URL is the fallback.
    try {
      writeFileSync(qrPath(), `${renderQr(this.init.browserUrl)}\n`);
    } catch (error) {
      console.error(`[qr] render failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    writeFileSync(
      runtimePath(),
      JSON.stringify(
        { port: this.port, pid: process.pid, surface: this.init.surface ?? null, sessionUrl: this.init.browserUrl },
        null,
        2
      )
    );
  }

  /**
   * Re-publish runtime.json if it has gone missing while the daemon is still up.
   * `runtime.json` is derived state, not a one-shot artifact: the `/voice-control:start`
   * skill deletes it as a liveness probe before re-touching an already-present `active`
   * flag, so no rising-edge activation fires to recreate it. The MCP server's reconcile
   * poll calls this every tick; it's cheap and only writes when the file is actually
   * absent, so a running daemon always keeps the phone URL on disk.
   */
  ensureRuntimePublished(): void {
    if (!existsSync(runtimePath())) this.writeRuntime();
  }

  // ---- bridge ----------------------------------------------------------------

  private connectBridge(): void {
    if (this.stopped) return;
    const url = toWebSocketUrl(this.init.config.bridgeUrl, this.init.sessionId, this.init.token, "daemon");
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => this.emitStatus());
    ws.on("message", (raw) => {
      let envelope: { channel?: string; event?: BrowserToDaemonEvent };
      try {
        envelope = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (envelope.channel === "daemon" && envelope.event) {
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
        // Also re-send the latest reply if the phone missed it while disconnected.
        this.emitStatus();
        for (const missed of selectMissedReply(this.lastReply, event.lastSeenReplyId)) this.sendToBrowser(missed);
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
    this.sendToBrowser({ type: "transcript", requestId: randomUUID(), text: transcript });
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
    this.cmuxHealthy = ok;
    console.error(`[inject] cmuxSubmit ok=${ok}`);
    if (!ok) {
      this.inFlight = undefined;
      this.sendToBrowser({
        type: "error",
        message: "Couldn't reach the Claude Code pane (is it still open in cmux?)."
      });
      this.emitStatus();
      void this.pump(); // try the next queued prompt
    }
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
      const requestId = randomUUID();
      this.lastReply = { requestId, text };
      this.sendToBrowser({ type: "claude_reply", requestId, text });
      void this.speak(requestId, text);
    }
    this.emitStatus();
    void this.pump();
  }

  private async speak(requestId: string, text: string): Promise<void> {
    if (!this.init.config.voiceId) return;
    try {
      const { audioBase64, mimeType } = await synthesizeSpeech(this.init.config, capForSpeech(text));
      if (this.lastReply?.requestId === requestId) this.lastReply.audio = { audioBase64, mimeType };
      this.sendToBrowser({ type: "tts_audio", requestId, audioBase64, mimeType });
    } catch {
      // best-effort speech; the text reply already went through
    }
  }

  // ---- helpers ---------------------------------------------------------------

  private emitStatus(): void {
    const state: SessionState = {
      sessionId: this.init.sessionId,
      listening: this.cmuxHealthy,
      state: this.inFlight !== undefined ? "working" : "idle"
    };
    this.sendToBrowser({ type: "session_status", state, memory: { currentTask: this.inFlight } });
  }

  private sendToBrowser(event: DaemonToBrowserEvent): void {
    this.send({ channel: "browser", event });
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
      rmSync(runtimePath(), { force: true });
      rmSync(qrPath(), { force: true });
    } catch {
      // ignore
    }
  }
}

function capForSpeech(text: string): string {
  return text.length > MAX_SPEECH_CHARS ? `${text.slice(0, MAX_SPEECH_CHARS)}…` : text;
}
