import { describe, expect, it } from "vitest";
import { TurnCoordinator } from "./turn-coordinator.js";

// Drive the coordinator with a fake clock + an inject spy. inject resolves true unless `failNext` is set.
function harness() {
  const injected: string[] = [];
  let now = 1_000_000;
  let failNext = false;
  const coord = new TurnCoordinator({
    inject: async (text) => {
      injected.push(text);
      if (failNext) {
        failNext = false;
        return false;
      }
      return true;
    },
    onStatusChange: () => {},
    now: () => now
  });
  // Let the microtask from an async inject() settle.
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    coord,
    injected,
    advance: (ms: number) => {
      now += ms;
    },
    failInjectOnce: () => {
      failNext = true;
    },
    tick
  };
}

const TTL = 20 * 60 * 1000;

describe("TurnCoordinator (voice injection queue + idle-gate)", () => {
  it("injects a queued voice prompt immediately when Claude is idle", async () => {
    const h = harness();
    h.coord.enqueueVoice("hello");
    await h.tick();
    expect(h.injected).toEqual(["hello"]);
    expect(h.coord.hasInFlight).toBe(true); // in flight until its turn opens
    expect(h.coord.currentVoicePrompt).toBe("hello");
  });

  it("holds the next prompt until the open turn closes (one at a time)", async () => {
    const h = harness();
    h.coord.enqueueVoice("first");
    await h.tick();
    h.coord.turnOpened("first"); // our injection landed → in-flight retires, but the open turn gates
    expect(h.coord.hasInFlight).toBe(false);
    expect(h.coord.isBusy).toBe(true);
    h.coord.enqueueVoice("second");
    await h.tick();
    expect(h.injected).toEqual(["first"]); // still gated by the open turn
    h.coord.turnClosed();
    await h.tick();
    expect(h.injected).toEqual(["first", "second"]);
    expect(h.coord.isBusy).toBe(false);
  });

  it("a turn typed in the terminal (not ours) also gates injection until it closes", async () => {
    const h = harness();
    h.coord.turnOpened("user typed this"); // not one of ours
    expect(h.coord.isBusy).toBe(true);
    h.coord.enqueueVoice("queued");
    await h.tick();
    expect(h.injected).toEqual([]); // gated
    h.coord.turnClosed();
    await h.tick();
    expect(h.injected).toEqual(["queued"]);
  });

  it("two UserPromptSubmit but one Stop STILL releases the gate (the merged/glued-prompt bug)", async () => {
    // The incident: a glued prompt fired two opens but one close. A counter would be left at 1 and the gate
    // (and the old lamp) would stick. As a LEVEL, a single Stop means idle no matter how many opens preceded.
    const h = harness();
    h.coord.turnOpened("Я вот смышто это к ничему.");
    h.coord.turnOpened("Я вот смышто это к ничему.Mluvím česky, ty vole."); // merged sibling, second open
    h.coord.enqueueVoice("next");
    await h.tick();
    expect(h.injected).toEqual([]); // gated while busy
    h.coord.turnClosed(); // ONE Stop
    await h.tick();
    expect(h.injected).toEqual(["next"]); // gate released — not stuck
    expect(h.coord.isBusy).toBe(false);
  });

  it("interrupt drops open turns and drains the queue", async () => {
    const h = harness();
    h.coord.turnOpened("running");
    h.coord.enqueueVoice("after");
    await h.tick();
    expect(h.injected).toEqual([]);
    h.coord.interrupt();
    expect(h.coord.isBusy).toBe(false); // the lamp can idle immediately on Esc
    await h.tick();
    expect(h.injected).toEqual(["after"]);
  });

  it("interruptWith jumps the queue", async () => {
    const h = harness();
    h.coord.turnOpened("running");
    h.coord.enqueueVoice("queued");
    h.coord.interruptWith("urgent");
    await h.tick();
    expect(h.injected).toEqual(["urgent"]);
  });

  it("reset drops everything (in-flight, queued, open)", async () => {
    const h = harness();
    h.coord.enqueueVoice("a");
    await h.tick();
    h.coord.reset();
    expect(h.coord.hasInFlight).toBe(false);
    expect(h.coord.isBusy).toBe(false);
    expect(h.coord.currentVoicePrompt).toBeUndefined();
  });

  it("a failed inject releases the slot and tries the next queued prompt", async () => {
    const h = harness();
    h.failInjectOnce();
    h.coord.enqueueVoice("flaky");
    h.coord.enqueueVoice("next");
    await h.tick();
    await h.tick();
    expect(h.injected).toEqual(["flaky", "next"]);
  });

  it("reaps a stale OPEN turn past the TTL so the gate can release (missed Stop backstop)", async () => {
    const h = harness();
    h.coord.turnOpened("hung");
    h.coord.enqueueVoice("waiting");
    await h.tick();
    expect(h.injected).toEqual([]);
    h.advance(TTL + 1);
    h.coord.enqueueVoice("trigger"); // pump() reaps the stale turn first
    await h.tick();
    expect(h.injected).toContain("waiting");
  });

  it("reaps a stuck injection whose turn-open never arrived", async () => {
    const h = harness();
    h.coord.enqueueVoice("stuck");
    await h.tick();
    expect(h.coord.hasInFlight).toBe(true); // in-flight, no turn-open
    h.advance(TTL + 1);
    h.coord.enqueueVoice("after");
    await h.tick();
    expect(h.injected).toEqual(["stuck", "after"]);
  });

  it("drops a stale inject result by token when the SAME prompt is re-injected", async () => {
    const h = harness();
    h.coord.enqueueVoice("status");
    await h.tick();
    h.coord.turnOpened("status");
    h.coord.turnClosed(); // idle again
    h.coord.interrupt(); // bumps injectSeq, invalidating any late await
    h.coord.enqueueVoice("status"); // same text, new token
    await h.tick();
    expect(h.injected.filter((t) => t === "status")).toHaveLength(2);
    expect(h.coord.hasInFlight).toBe(true);
  });
});
