import { randomUUID } from "node:crypto";
import {
  type BrowserToDaemonEvent,
  type DaemonToBrowserEvent,
  type SessionMemory,
  type SessionRuntimeState,
  type SessionState,
  type TaskRecord,
  type VoiceMessage,
  isInterruptText
} from "../shared/protocol.js";

type QueueWaiter = {
  resolve: (message: VoiceMessage | undefined) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const QUEUED_INSTRUCTION_REPLY = "Queued after the current task.";

export type InterruptRecord = {
  requestId: string;
  text: string;
  createdAt: number;
};

export type DaemonSessionRuntimeOptions = {
  sessionId: string;
  expiresAt: number;
  createdAt?: number;
  daemonConnected?: boolean;
  browserConnected?: boolean;
  state?: SessionRuntimeState;
  memory?: Partial<SessionMemory>;
  now?: () => number;
  voiceSignedUrlProvider?: () => string | Promise<string>;
  idFactory?: () => string;
};

export type DaemonSessionRuntimeStatus = SessionState & {
  memory: SessionMemory;
};

export class DaemonSessionRuntime {
  private readonly sessionId: string;
  private readonly createdAt: number;
  private readonly expiresAt: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly voiceSignedUrlProvider?: () => string | Promise<string>;
  private daemonConnected: boolean;
  private browserConnected: boolean;
  private state: SessionRuntimeState;
  private queue: VoiceMessage[] = [];
  private waiters: QueueWaiter[] = [];
  private outbound: DaemonToBrowserEvent[] = [];
  private interrupt?: InterruptRecord;
  private memory: SessionMemory;

  constructor(options: DaemonSessionRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.createdAt = options.createdAt ?? Date.now();
    this.expiresAt = options.expiresAt;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.voiceSignedUrlProvider = options.voiceSignedUrlProvider;
    this.daemonConnected = options.daemonConnected ?? false;
    this.browserConnected = options.browserConnected ?? false;
    this.state = options.state ?? "idle";
    this.memory = cloneMemory({
      currentTask: options.memory?.currentTask,
      lastSummary: options.memory?.lastSummary,
      lastResponse: options.memory?.lastResponse,
      steeringNotes: options.memory?.steeringNotes ?? [],
      taskHistory: options.memory?.taskHistory ?? []
    });
  }

  async handleBrowserEvent(event: BrowserToDaemonEvent): Promise<void> {
    switch (event.type) {
      case "request_voice_signed_url":
        await this.handleVoiceSignedUrlRequest(event.requestId);
        return;

      case "voice_instruction": {
        const createdAt = this.now();
        const isInterrupt = isInterruptText(event.text);
        const message: VoiceMessage = {
          id: event.requestId,
          kind: isInterrupt ? "interrupt" : "instruction",
          text: event.text,
          createdAt,
          priority: isInterrupt ? "high" : "normal"
        };
        if (isInterrupt) {
          this.recordInterrupt(message);
        }
        const queueBehindActiveTask = !isInterrupt && Boolean(this.memory.currentTask);
        this.enqueue(message);
        if (queueBehindActiveTask) {
          this.push({ type: "claude_reply", requestId: event.requestId, text: QUEUED_INSTRUCTION_REPLY });
        } else {
          this.push({ type: "ack", requestId: event.requestId, message: "Sent to Claude Code." });
        }
        return;
      }

      case "status_request":
        this.enqueue({
          id: event.requestId,
          kind: "status_request",
          text: "User requested a status update.",
          createdAt: this.now(),
          priority: "normal"
        });
        this.push({ type: "ack", requestId: event.requestId, message: "Status request sent." });
        return;

      case "summary_request":
        if (this.memory.lastSummary) {
          this.push({ type: "claude_reply", requestId: event.requestId, text: this.memory.lastSummary });
          return;
        }
        this.enqueue({
          id: event.requestId,
          kind: "summary_request",
          text: "User requested the last summary.",
          createdAt: this.now(),
          priority: "normal"
        });
        this.push({ type: "ack", requestId: event.requestId, message: "Summary request sent." });
        return;

      case "steering_note":
        this.memory.steeringNotes.push(event.text);
        this.push({ type: "ack", requestId: event.requestId, message: "Steering note saved." });
        this.emitStatus();
        return;

      case "interrupt":
      case "stop_task": {
        const text = event.type === "stop_task" ? "Stop the active task." : event.text;
        const createdAt = this.now();
        const message: VoiceMessage = {
          id: event.requestId,
          kind: "interrupt",
          text,
          createdAt,
          priority: "high"
        };
        this.recordInterrupt(message);
        this.enqueue(message);
        this.push({ type: "ack", requestId: event.requestId, message: "Interrupt sent." });
        this.emitStatus();
        return;
      }
    }
  }

  setConnectionStatus(status: Partial<Pick<SessionState, "daemonConnected" | "browserConnected">>): void {
    this.daemonConnected = status.daemonConnected ?? this.daemonConnected;
    this.browserConnected = status.browserConnected ?? this.browserConnected;
    this.emitStatus();
  }

  stop(): void {
    this.state = "stopping";
    this.resolveAllWaiters(undefined);
    this.emitStatus();
  }

  async nextMessage(timeoutMs: number): Promise<VoiceMessage | undefined> {
    const immediate = this.dequeueNextMessage();
    if (immediate) {
      this.emitStatus();
      return immediate;
    }

    if (this.state === "stopping") {
      return undefined;
    }

    return new Promise((resolve) => {
      const waiter: QueueWaiter = {
        resolve,
        timeout: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          resolve(undefined);
        }, Math.max(0, timeoutMs))
      };
      this.waiters.push(waiter);
    });
  }

  reply(
    text: string,
    options: { requestId?: string; summary?: string; taskState?: SessionRuntimeState; backgroundMode?: boolean } = {}
  ): void {
    this.memory.lastResponse = text;
    if (options.summary) {
      this.memory.lastSummary = options.summary;
      const activeTask = this.memory.taskHistory.find((task) => task.status === "active");
      if (activeTask) {
        activeTask.summary = options.summary;
      }
    }

    if (options.taskState) {
      this.state = options.taskState;
      if (options.taskState === "idle") {
        this.completeActiveTask(options.summary ?? text);
      }
    } else if (options.backgroundMode) {
      this.state = "voice_suspended";
    }

    this.push({
      type: "claude_reply",
      requestId: options.requestId ?? this.idFactory(),
      text,
      backgroundMode: options.backgroundMode
    });
    this.emitStatus();
  }

  getStatus(): DaemonSessionRuntimeStatus {
    return {
      ...this.stateSnapshot(),
      memory: this.getMemory()
    };
  }

  getMemory(): SessionMemory {
    return cloneMemory(this.memory);
  }

  getSteeringNotes(clear = false): string[] {
    const notes = [...this.memory.steeringNotes];
    if (clear) {
      this.memory.steeringNotes = [];
      this.emitStatus();
    }
    return notes;
  }

  checkInterrupt(clear = true): InterruptRecord | undefined {
    const result = this.interrupt ? { ...this.interrupt } : undefined;
    if (clear) {
      if (result) {
        this.removeQueuedMessage(result.requestId);
      }
      this.interrupt = undefined;
    }
    return result;
  }

  checkControlMessage(clear = true): VoiceMessage | undefined {
    const index = this.queue.findIndex((message) => message.kind === "status_request" || message.kind === "summary_request");
    if (index === -1) return undefined;

    const [message] = clear ? this.queue.splice(index, 1) : [this.queue[index]];
    return message ? { ...message } : undefined;
  }

  drainOutboundEvents(): DaemonToBrowserEvent[] {
    const events = this.outbound;
    this.outbound = [];
    return events;
  }

  private async handleVoiceSignedUrlRequest(requestId: string): Promise<void> {
    if (!this.voiceSignedUrlProvider) {
      this.push({ type: "error", requestId, message: "Voice signed URL provider is not configured." });
      return;
    }

    try {
      const signedUrl = await this.voiceSignedUrlProvider();
      this.state = "voice_connected";
      this.browserConnected = true;
      this.push({ type: "voice_signed_url", requestId, signedUrl });
      this.emitStatus();
    } catch (error) {
      this.push({ type: "error", requestId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private enqueue(message: VoiceMessage): void {
    if (message.priority === "high") {
      this.queue.unshift(message);
    } else {
      this.queue.push(message);
    }

    this.trackQueuedInstruction(message);

    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve(this.dequeueNextMessage());
    }

    this.emitStatus();
  }

  private dequeueNextMessage(): VoiceMessage | undefined {
    const message = this.queue.shift();
    if (message) {
      if (message.kind === "interrupt" && this.interrupt?.requestId === message.id) {
        this.interrupt = undefined;
      }
      this.promoteDequeuedInstruction(message);
    }
    return message;
  }

  private trackQueuedInstruction(message: VoiceMessage): void {
    if (message.kind !== "instruction" || this.findTask(message.id)) return;

    const isActive = !this.memory.currentTask;
    this.memory.taskHistory.push({
      id: message.id,
      text: message.text,
      startedAt: message.createdAt,
      status: isActive ? "active" : "pending"
    });

    if (isActive) {
      this.memory.currentTask = message.text;
      this.state = "working";
    }
  }

  private promoteDequeuedInstruction(message: VoiceMessage): void {
    if (message.kind !== "instruction") return;

    const task = this.findTask(message.id);
    if (task) {
      task.status = "active";
      task.startedAt = this.now();
    } else {
      this.memory.taskHistory.push({
        id: message.id,
        text: message.text,
        startedAt: this.now(),
        status: "active"
      });
    }

    this.memory.currentTask = message.text;
    this.state = "working";
  }

  private findTask(id: string): TaskRecord | undefined {
    return this.memory.taskHistory.find((task) => task.id === id);
  }

  private recordInterrupt(message: VoiceMessage): void {
    this.interrupt = {
      requestId: message.id,
      text: message.text,
      createdAt: message.createdAt
    };
    this.state = "paused_for_user";
  }

  private removeQueuedMessage(id: string): VoiceMessage | undefined {
    const index = this.queue.findIndex((message) => message.id === id);
    if (index === -1) return undefined;
    return this.queue.splice(index, 1)[0];
  }

  private completeActiveTask(summary: string): void {
    const activeTask = this.memory.taskHistory.find((task) => task.status === "active");
    if (activeTask) {
      activeTask.status = "completed";
      activeTask.finishedAt = this.now();
      activeTask.summary ??= summary;
    }
    this.memory.currentTask = undefined;
  }

  private stateSnapshot(): SessionState {
    return {
      sessionId: this.sessionId,
      daemonConnected: this.daemonConnected,
      browserConnected: this.browserConnected,
      state: this.state,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt
    };
  }

  private emitStatus(): void {
    this.push({
      type: "session_status",
      state: this.stateSnapshot(),
      memory: {
        currentTask: this.memory.currentTask,
        lastSummary: this.memory.lastSummary,
        lastResponse: this.memory.lastResponse,
        steeringNotes: [...this.memory.steeringNotes]
      }
    });
  }

  private push(event: DaemonToBrowserEvent): void {
    this.outbound.push(event);
  }

  private resolveAllWaiters(message: VoiceMessage | undefined): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    }
  }
}

function cloneMemory(memory: SessionMemory): SessionMemory {
  return {
    currentTask: memory.currentTask,
    lastSummary: memory.lastSummary,
    lastResponse: memory.lastResponse,
    steeringNotes: [...memory.steeringNotes],
    taskHistory: memory.taskHistory.map((task) => ({ ...task }))
  };
}
