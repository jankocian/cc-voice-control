import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceRemoteManager, VoiceRemoteSession } from "./session.js";

const wsMock = vi.hoisted(() => ({
  instances: [] as Array<{
    readyState: number;
    closeCalls: Array<[number | undefined, string | undefined]>;
    sent: string[];
    terminateCalls: number;
    listenerCount: (event: string) => number;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>
}));

vi.mock("ws", () => {
  type Listener = ((...args: unknown[]) => void) & {
    originalListener?: Listener;
  };

  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    closeCalls: Array<[number | undefined, string | undefined]> = [];
    sent: string[] = [];
    terminateCalls = 0;
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor(readonly url: string) {
      wsMock.instances.push(this);
    }

    once(event: string, listener: Listener): this {
      const onceListener: Listener = (...args) => {
        this.off(event, onceListener);
        listener(...args);
      };
      onceListener.originalListener = listener;
      return this.on(event, onceListener);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    off(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event);
      if (!listeners) return this;
      for (const item of listeners) {
        if (item === listener || item.originalListener === listener) {
          listeners.delete(item);
        }
      }
      return this;
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }

    close(code?: number, reason?: string): void {
      this.closeCalls.push([code, reason]);
      this.readyState = MockWebSocket.CLOSING;
    }

    terminate(): void {
      this.terminateCalls += 1;
      this.readyState = MockWebSocket.CLOSED;
    }

    send(data: string): void {
      this.sent.push(data);
    }

    emit(event: string, ...args: unknown[]): boolean {
      const listeners = [...(this.listeners.get(event) ?? [])];
      for (const listener of listeners) listener(...args);
      return listeners.length > 0;
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.size ?? 0;
    }
  }

  return { default: MockWebSocket };
});

const config = {
  elevenlabsApiKey: "test-key",
  agentId: "agent-test",
  bridgeUrl: "https://voice.example.com",
  sessionTimeoutMinutes: 120
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  wsMock.instances.length = 0;
});

describe("VoiceRemoteSession", () => {
  it("reports replies as undelivered when the bridge socket is not open", () => {
    const session = new VoiceRemoteSession(config);

    expect(session.reply("Done.", { requestId: "request-1" })).toBe(false);
  });

  it("terminates and detaches a bridge socket when connect times out", async () => {
    vi.useFakeTimers();
    const session = new VoiceRemoteSession(config);

    const connectPromise = session.connect();
    const expectedRejection = expect(connectPromise).rejects.toThrow("Timed out connecting to bridge");
    await vi.advanceTimersByTimeAsync(15_000);

    await expectedRejection;
    const ws = wsMock.instances.at(-1);
    expect(ws).toBeDefined();
    expect(ws?.terminateCalls).toBe(1);
    expect(ws?.closeCalls).toEqual([]);
    expect(ws?.listenerCount("open")).toBe(0);
    expect(ws?.listenerCount("error")).toBe(0);
    expect(session.isConnected()).toBe(false);
  });

  it("handles bridge socket errors after connect", async () => {
    const session = new VoiceRemoteSession(config);

    const connectPromise = session.connect();
    const ws = wsMock.instances.at(-1);
    expect(ws).toBeDefined();
    if (!ws) return;

    ws.readyState = 1;
    ws.emit("open");
    await connectPromise;

    expect(ws.listenerCount("error")).toBe(1);

    ws.emit("error", new Error("network reset"));

    expect(ws.closeCalls).toEqual([[1000, "socket error"]]);
    expect(ws.listenerCount("error")).toBe(0);
    expect(session.isConnected()).toBe(false);
  });
});

describe("VoiceRemoteManager", () => {
  it("stops an expired session before replacing it", async () => {
    const connect = vi.spyOn(VoiceRemoteSession.prototype, "connect").mockResolvedValue();
    const stop = vi.spyOn(VoiceRemoteSession.prototype, "stop");
    const manager = new VoiceRemoteManager();

    const first = await manager.start({ ...config, sessionTimeoutMinutes: -1 });
    const second = await manager.start({ ...config, sessionTimeoutMinutes: -1 });

    expect(second).not.toBe(first);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop.mock.contexts[0]).toBe(first);
  });
});
