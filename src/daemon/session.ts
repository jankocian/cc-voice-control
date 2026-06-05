import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { getElevenLabsSignedUrl } from "./elevenlabs.js";
import { toBrowserUrl, toWebSocketUrl, type VoiceRemoteConfig } from "./config.js";
import {
  DaemonSessionRuntime,
  type InterruptRecord
} from "./session-runtime.js";
import {
  type BrowserToDaemonEvent,
  type DaemonToBrowserEvent,
  type SessionMemory,
  type SessionRuntimeState,
  type SessionState,
  type VoiceMessage
} from "../shared/protocol.js";

export class VoiceRemoteSession {
  readonly sessionId: string;
  readonly token: string;
  readonly browserUrl: string;
  readonly expiresAt: number;

  private readonly config: VoiceRemoteConfig;
  private readonly runtime: DaemonSessionRuntime;
  private ws?: WebSocket;

  constructor(config: VoiceRemoteConfig) {
    this.config = config;
    this.sessionId = randomUUID();
    this.token = randomBytes(32).toString("base64url");

    const createdAt = Date.now();
    this.expiresAt = createdAt + config.sessionTimeoutMinutes * 60_000;
    this.browserUrl = toBrowserUrl(config.bridgeUrl, this.sessionId, this.token, this.expiresAt);
    this.runtime = new DaemonSessionRuntime({
      sessionId: this.sessionId,
      createdAt,
      expiresAt: this.expiresAt,
      voiceSignedUrlProvider: () => getElevenLabsSignedUrl(this.config)
    });
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;

    const wsUrl = toWebSocketUrl(this.config.bridgeUrl, this.sessionId, this.token, "daemon", this.expiresAt);
    this.closeBridgeSocket("reconnecting");
    this.runtime.setConnectionStatus({ daemonConnected: false });
    this.flushRuntimeEvents();

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    const onEstablishedError = () => {
      if (this.ws !== ws) return;
      this.runtime.setConnectionStatus({ daemonConnected: false });
      this.flushRuntimeEvents();
      this.closeBridgeSocket("socket error");
    };

    await new Promise<void>((resolve, reject) => {
      const onFailure = (error: Error) => {
        clearTimeout(timer);
        ws.off("open", onOpen);
        ws.off("error", onError);
        if (this.ws === ws) {
          this.closeBridgeSocket("connect failed");
        } else {
          closeWebSocket(ws, "connect failed");
        }
        reject(error);
      };
      const onOpen = () => {
        clearTimeout(timer);
        ws.off("error", onError);
        ws.on("error", onEstablishedError);
        this.runtime.setConnectionStatus({ daemonConnected: true });
        this.flushRuntimeEvents();
        resolve();
      };
      const onError = (error: Error) => onFailure(error);
      const timer = setTimeout(() => onFailure(new Error("Timed out connecting to bridge")), 15_000);

      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    ws.on("message", (raw) => {
      this.handleBridgeMessage(raw.toString()).catch((error) => {
        this.sendToBrowser({ type: "error", message: error instanceof Error ? error.message : String(error) });
      });
    });

    ws.on("close", () => {
      this.runtime.setConnectionStatus({ daemonConnected: false });
      this.flushRuntimeEvents();
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  stop(): void {
    this.runtime.stop();
    this.runtime.setConnectionStatus({ daemonConnected: false });
    this.flushRuntimeEvents();
    this.closeBridgeSocket("session stopped");
  }

  getStatus(): SessionState & { browserUrl: string; memory: SessionMemory } {
    return {
      ...this.runtime.getStatus(),
      browserUrl: this.browserUrl
    };
  }

  async nextMessage(timeoutMs: number): Promise<VoiceMessage | undefined> {
    const message = await this.runtime.nextMessage(timeoutMs);
    this.flushRuntimeEvents();
    return message;
  }

  reply(
    text: string,
    options: { requestId?: string; summary?: string; taskState?: SessionRuntimeState; backgroundMode?: boolean } = {}
  ): boolean {
    this.runtime.reply(text, options);
    return this.flushRuntimeEvents((event) => {
      if (event.type !== "claude_reply") return false;
      return options.requestId ? event.requestId === options.requestId : true;
    });
  }

  getSteeringNotes(clear: boolean): string[] {
    const notes = this.runtime.getSteeringNotes(clear);
    this.flushRuntimeEvents();
    return notes;
  }

  checkInterrupt(clear: boolean): InterruptRecord | undefined {
    return this.runtime.checkInterrupt(clear);
  }

  checkControlMessage(clear: boolean): VoiceMessage | undefined {
    return this.runtime.checkControlMessage(clear);
  }

  private async handleBridgeMessage(raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as { channel?: string; event?: BrowserToDaemonEvent };
    if (envelope.channel !== "daemon" || !envelope.event) return;
    await this.runtime.handleBrowserEvent(envelope.event);
    this.flushRuntimeEvents();
  }

  private flushRuntimeEvents(match?: (event: DaemonToBrowserEvent) => boolean): boolean {
    let sawMatchedEvent = false;
    let matchedEventDelivered = false;

    for (const event of this.runtime.drainOutboundEvents()) {
      const delivered = this.sendToBrowser(event);
      if (!match || match(event)) {
        sawMatchedEvent = true;
        matchedEventDelivered ||= delivered;
      }
    }

    return sawMatchedEvent ? matchedEventDelivered : false;
  }

  private sendToBrowser(event: DaemonToBrowserEvent): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify({ channel: "browser", event }));
      return true;
    } catch {
      return false;
    }
  }

  private closeBridgeSocket(reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = undefined;
    closeWebSocket(ws, reason);
  }
}

export class VoiceRemoteManager {
  private session?: VoiceRemoteSession;

  async start(config: VoiceRemoteConfig): Promise<VoiceRemoteSession> {
    if (this.session && this.session.expiresAt <= Date.now()) {
      this.session.stop();
      this.session = undefined;
    }

    if (this.session) {
      if (!this.session.isConnected()) {
        try {
          await this.session.connect();
        } catch {
          this.session.stop();
          this.session = new VoiceRemoteSession(config);
          await this.session.connect();
        }
      }
      return this.session;
    }
    this.session = new VoiceRemoteSession(config);
    await this.session.connect();
    return this.session;
  }

  current(): VoiceRemoteSession | undefined {
    if (this.session && this.session.expiresAt <= Date.now()) {
      this.session.stop();
      this.session = undefined;
    }
    return this.session;
  }

  stop(): boolean {
    if (!this.session) return false;
    this.session.stop();
    this.session = undefined;
    return true;
  }
}

function closeWebSocket(ws: WebSocket, reason: string): void {
  ws.removeAllListeners();
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
    return;
  }
  ws.close(1000, reason);
}
