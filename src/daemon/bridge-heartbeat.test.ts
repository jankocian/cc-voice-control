import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBridgeHeartbeat } from "./bridge-heartbeat.js";

// A fake `ws` socket: records pings/terminations and lets the test deliver pongs.
function fakeSocket(readyState = 1) {
  let onPong: (() => void) | undefined;
  return {
    readyState,
    pings: 0,
    terminated: 0,
    on(_event: "pong", listener: () => void) {
      onPong = listener;
    },
    ping() {
      this.pings++;
    },
    terminate() {
      this.terminated++;
    },
    deliverPong() {
      onPong?.();
    }
  };
}

describe("startBridgeHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps pinging while pongs come back, and never terminates a live socket", () => {
    const socket = fakeSocket();
    startBridgeHeartbeat(socket, 1000);

    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(1);
    socket.deliverPong();

    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(2);
    socket.deliverPong();

    expect(socket.terminated).toBe(0);
  });

  it("terminates a half-open socket (a ping with no pong before the next tick)", () => {
    const socket = fakeSocket();
    startBridgeHeartbeat(socket, 1000);

    vi.advanceTimersByTime(1000); // ping #1
    expect(socket.pings).toBe(1);
    // No pong arrives...
    vi.advanceTimersByTime(1000); // next tick sees awaitingPong → terminate
    expect(socket.terminated).toBe(1);
  });

  it("stop() clears the timer so no further pings fire", () => {
    const socket = fakeSocket();
    const stop = startBridgeHeartbeat(socket, 1000);
    vi.advanceTimersByTime(1000);
    expect(socket.pings).toBe(1);
    stop();
    vi.advanceTimersByTime(5000);
    expect(socket.pings).toBe(1);
  });

  it("does nothing while the socket is not OPEN (no ping, no terminate)", () => {
    const socket = fakeSocket(0 /* CONNECTING */);
    startBridgeHeartbeat(socket, 1000);
    vi.advanceTimersByTime(3000);
    expect(socket.pings).toBe(0);
    expect(socket.terminated).toBe(0);
  });
});
