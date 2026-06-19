import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import WebSocket from "ws";
import { stateDir, runtimePath, toBrowserUrl, toWebSocketUrl, type VoiceRemoteConfig } from "./config.js";
import { synthesizeSpeech, transcribeAudio } from "./elevenlabs.js";
import { cmuxInterrupt, cmuxPing, cmuxSubmit } from "./cmux.js";
import type {
  BrowserToDaemonEvent,
  DaemonToBrowserEvent,
  SessionRuntimeState,
  SessionState
} from "../shared/protocol.js";

export type DaemonInit = {
  config: VoiceRemoteConfig;
  surface?: string;
  sessionId: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  browserUrl: string;
};

/** Build a fresh session (id, token, phone URL) from config and the current cmux pane. */
export function createDaemonInit(config: VoiceRemoteConfig): DaemonInit {
  const surface = process.env.CMUX_SURFACE_ID;
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const createdAt = Date.now();
  const expiresAt = createdAt + config.sessionTimeoutMinutes * 60_000;
  const browserUrl = toBrowserUrl(config.bridgeUrl, sessionId, token, expiresAt);
  return { config, surface, sessionId, token, createdAt, expiresAt, browserUrl };
}

/**
 * Voice daemon for the cmux-hosted interactive Claude Code session.
 *
 * Phone speaks → ElevenLabs STT → `cmux send` types it into the live Claude pane
 * as a real user message. The plugin Stop hook POSTs Claude's reply back here →
 * ElevenLabs TTS → phone. It is the real interactive session — no turn-hijack.
 *
 * Critically, this runs *inside Claude Code's process tree* (hosted by the plugin
 * MCP server), so it keeps cmux's socket trust. A detached/`nohup` process would
 * be reparented to launchd and cmux would reject its keystrokes.
 *
 * IMPORTANT: never write to stdout here. When hosted as an MCP server, stdout is
 * the JSON-RPC channel; all logging goes to stderr.
 */
export class VoiceDaemon {
  private readonly init: DaemonInit;
  private ws?: WebSocket;
  private httpServer?: Server;
  private port = 0;
  private state: SessionRuntimeState = "idle";
  private currentTask?: string;
  private cmuxHealthy = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private statusTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

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
    console.error(`voice-remote ready. cmux surface=${this.init.surface ?? "(none — CMUX_SURFACE_ID was not set!)"} hookPort=${this.port}`);
    console.error(`Phone URL: ${this.init.browserUrl}`);
    // Health-check cmux without blocking startup — a hung/missing cmux must not
    // prevent the daemon from coming up and showing the phone URL.
    void this.checkCmuxHealth();
    // The bridge only announces presence to browsers, so the daemon can't know
    // when a phone (re)connects. A light status heartbeat keeps the phone's lamp
    // truthful within a few seconds regardless of join/reconnect timing.
    this.statusTimer = setInterval(() => this.emitStatus(), 4000);
  }

  private async checkCmuxHealth(): Promise<void> {
    this.cmuxHealthy = await cmuxPing();
    if (!this.cmuxHealthy) console.error("WARNING: cmux control socket is unreachable — injection will fail until cmux is running.");
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
            const { text } = JSON.parse(body || "{}") as { text?: string };
            if (typeof text === "string") this.onClaudeReply(text);
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
    writeFileSync(
      runtimePath(),
      JSON.stringify(
        { port: this.port, pid: process.pid, surface: this.init.surface ?? null, sessionUrl: this.init.browserUrl },
        null,
        2
      )
    );
  }

  // ---- bridge ----------------------------------------------------------------

  private connectBridge(): void {
    if (this.stopped) return;
    const url = toWebSocketUrl(this.init.config.bridgeUrl, this.init.sessionId, this.init.token, "daemon", this.init.expiresAt);
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
    ws.on("close", () => {
      if (this.stopped || this.ws !== ws) return;
      this.ws = undefined;
      this.reconnectTimer = setTimeout(() => this.connectBridge(), 1500);
    });
    ws.on("error", () => {
      /* close handler schedules reconnect */
    });
  }

  private async handleBrowserEvent(event: BrowserToDaemonEvent): Promise<void> {
    switch (event.type) {
      case "submit_audio":
        await this.handleAudio(event.audioBase64, event.mimeType);
        return;
      case "status_request":
        await this.inject("Give me a brief spoken status of what you're doing right now.");
        return;
      case "summary_request":
        await this.inject("Briefly summarize what you've done so far, for the phone.");
        return;
      case "stop_task":
        await cmuxInterrupt(this.init.surface);
        this.setState("idle");
        return;
      default:
        return;
    }
  }

  private async handleAudio(audioBase64: string, mimeType: string): Promise<void> {
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
    await this.inject(transcript);
  }

  // Type into the live Claude pane and mark the session as working.
  private async inject(text: string): Promise<void> {
    this.currentTask = text;
    this.setState("working");
    console.error(`[inject] surface=${this.init.surface ?? "(default $CMUX_SURFACE_ID)"} text=${JSON.stringify(text)}`);
    const ok = await cmuxSubmit(text, this.init.surface);
    console.error(`[inject] cmuxSubmit ok=${ok}`);
    this.cmuxHealthy = ok;
    if (!ok) {
      this.setState("idle"); // also re-emits status with listening=false
      this.sendToBrowser({ type: "error", message: "Couldn't reach the Claude Code pane (is it still open in cmux?)." });
    }
  }

  // Stop hook delivered Claude's reply — mirror it to the phone and speak it,
  // whether the turn came from voice or was typed directly in the terminal.
  private onClaudeReply(text: string): void {
    console.error(`[reply] received ${text.length} chars`);
    this.setState("idle");
    const requestId = randomUUID();
    this.sendToBrowser({ type: "claude_reply", requestId, text });
    void this.speak(requestId, text);
  }

  private async speak(requestId: string, text: string): Promise<void> {
    if (!this.init.config.voiceId) return;
    try {
      const { audioBase64, mimeType } = await synthesizeSpeech(this.init.config, capForSpeech(text));
      this.sendToBrowser({ type: "tts_audio", requestId, audioBase64, mimeType });
    } catch {
      // best-effort speech; the text reply already went through
    }
  }

  // ---- helpers ---------------------------------------------------------------

  private setState(state: SessionRuntimeState): void {
    this.state = state;
    if (state === "idle") this.currentTask = undefined;
    this.emitStatus();
  }

  private emitStatus(): void {
    const state: SessionState = {
      sessionId: this.init.sessionId,
      daemonConnected: true,
      browserConnected: true,
      listening: this.cmuxHealthy,
      state: this.state,
      createdAt: this.init.createdAt,
      expiresAt: this.init.expiresAt
    };
    this.sendToBrowser({ type: "session_status", state, memory: { currentTask: this.currentTask } });
  }

  private sendToBrowser(event: DaemonToBrowserEvent): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ channel: "browser", event }));
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
    if (this.statusTimer) clearInterval(this.statusTimer);
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.httpServer?.close();
    try {
      rmSync(runtimePath(), { force: true });
    } catch {
      // ignore
    }
  }
}

function capForSpeech(text: string): string {
  const MAX = 2500;
  return text.length > MAX ? `${text.slice(0, MAX)}…` : text;
}
