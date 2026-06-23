import { describe, expect, it } from "vitest";
import { TurnCoordinator } from "./turn-coordinator.js";

// Drive the coordinator with an inject spy. inject resolves true unless `failNext` is set. No clock: the
// gate is a level (paneBusy), self-healed by signals, never a timer.
function harness() {
  const injected: string[] = [];
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
    onStatusChange: () => {}
  });
  // Let the microtask from an async inject() settle.
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    coord,
    injected,
    failInjectOnce: () => {
      failNext = true;
    },
    tick
  };
}

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
    h.coord.enqueueVoice("second");
    await h.tick();
    expect(h.injected).toEqual(["first"]); // still gated by the open turn
    h.coord.turnClosed();
    await h.tick();
    expect(h.injected).toEqual(["first", "second"]);
  });

  it("a turn typed in the terminal (not ours) also gates injection until it closes", async () => {
    const h = harness();
    h.coord.turnOpened("user typed this"); // not one of ours
    h.coord.enqueueVoice("queued");
    await h.tick();
    expect(h.injected).toEqual([]); // gated by the open turn
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
  });

  it("noteIdleFromTranscript releases a paneBusy left set by a missed Stop (self-heal, no timer)", async () => {
    const h = harness();
    h.coord.turnOpened("hung turn whose Stop never arrives");
    h.coord.enqueueVoice("waiting");
    await h.tick();
    expect(h.injected).toEqual([]); // gated
    h.coord.noteIdleFromTranscript(); // the transcript shows the pane idle → release the gate
    await h.tick();
    expect(h.injected).toEqual(["waiting"]);
  });

  it("noteIdleFromTranscript never clears an in-flight injection (would double-inject)", async () => {
    const h = harness();
    h.coord.enqueueVoice("typed but not open yet");
    await h.tick();
    expect(h.coord.hasInFlight).toBe(true);
    h.coord.noteIdleFromTranscript(); // paneBusy is false here; must NOT touch inFlight
    await h.tick();
    expect(h.injected).toEqual(["typed but not open yet"]); // not re-injected
    expect(h.coord.hasInFlight).toBe(true);
  });

  it("interrupt drops open turns and drains the queue", async () => {
    const h = harness();
    h.coord.turnOpened("running");
    h.coord.enqueueVoice("after");
    await h.tick();
    expect(h.injected).toEqual([]);
    h.coord.interrupt();
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
