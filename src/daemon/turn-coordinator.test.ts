import { describe, expect, it } from "vitest";
import { isSlashCommand, TurnCoordinator } from "./turn-coordinator.js";

describe("isSlashCommand (keep plugin/CLI commands out of the phone's mirrored history)", () => {
  it("flags slash commands so they aren't mirrored", () => {
    expect(isSlashCommand("/voice-control:start")).toBe(true);
    expect(isSlashCommand("  /clear")).toBe(true);
  });

  it("lets real typed messages through", () => {
    expect(isSlashCommand("fix the spawn bug")).toBe(false);
    expect(isSlashCommand("what's the status?")).toBe(false);
  });
});

// Let any pending pump()/inject() microtasks settle before asserting (inject is async).
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A coordinator wired to spies and a manual clock, so every turn path is observable with no I/O.
function harness() {
  let clock = 1_000_000;
  let injectOk = true;
  const injected: string[] = [];
  const spoken: string[] = [];
  const mirrored: Array<{ prompt: string; reply: string }> = [];
  let statusChanges = 0;
  const coord = new TurnCoordinator({
    inject: async (text) => {
      injected.push(text);
      return injectOk;
    },
    speakReply: (reply) => spoken.push(reply),
    mirrorTypedTurn: (prompt, reply) => mirrored.push({ prompt, reply }),
    onStatusChange: () => {
      statusChanges += 1;
    },
    now: () => clock
  });
  return {
    coord,
    injected,
    spoken,
    mirrored,
    advance: (ms: number) => {
      clock += ms;
    },
    failNextInjects: () => {
      injectOk = false;
    },
    allowInjects: () => {
      injectOk = true;
    },
    statusChanges: () => statusChanges
  };
}

// Comfortably past TURN_TTL_MS (20 min) so reaping triggers without coupling the test to the constant.
const PAST_TTL_MS = 60 * 60 * 1000;

describe("TurnCoordinator", () => {
  it("injects a voice prompt when idle, then speaks its reply", async () => {
    const h = harness();
    h.coord.enqueueVoice("hello there");
    await tick();
    expect(h.injected).toEqual(["hello there"]);
    expect(h.coord.isWorking()).toBe(true);
    expect(h.coord.currentVoicePrompt).toBe("hello there");

    h.coord.turnOpened("hello there"); // exact content → classified voice
    h.coord.turnClosed("hello there", "hi!", "u1");
    await tick();
    expect(h.spoken).toEqual(["hi!"]);
    expect(h.mirrored).toEqual([]);
    expect(h.coord.isWorking()).toBe(false);
    expect(h.coord.currentVoicePrompt).toBeUndefined();
  });

  it("idle-gates: a voice prompt waits while another turn is open, then injects once idle", async () => {
    const h = harness();
    h.coord.turnOpened("/voice-control:start"); // a plugin turn is running → busy
    h.coord.enqueueVoice("do the thing");
    await tick();
    expect(h.injected).toEqual([]); // gated — Claude is mid-turn

    h.coord.turnClosed("/voice-control:start", "ready", "u1"); // plugin turn closes (ignored) → idle
    await tick();
    expect(h.injected).toEqual(["do the thing"]);
  });

  it("mirrors a typed terminal turn (show the real prompt + speak the reply)", () => {
    const h = harness();
    h.coord.turnOpened("refactor the parser");
    h.coord.turnClosed("refactor the parser", "done", "u1");
    expect(h.mirrored).toEqual([{ prompt: "refactor the parser", reply: "done" }]);
    expect(h.spoken).toEqual([]);
  });

  it("ignores a plugin (slash-command) turn", () => {
    const h = harness();
    h.coord.turnOpened("/clear");
    h.coord.turnClosed("/clear", "cleared", "u1");
    expect(h.spoken).toEqual([]);
    expect(h.mirrored).toEqual([]);
  });

  it("ignores a reply with no open turn (daemon started mid-turn)", () => {
    const h = harness();
    h.coord.turnClosed("whatever", "stray reply", "u1");
    expect(h.spoken).toEqual([]);
    expect(h.mirrored).toEqual([]);
  });

  it("dedups a double-fired Stop by reply uuid", () => {
    const h = harness();
    h.coord.turnOpened("fix it");
    h.coord.turnClosed("fix it", "fixed", "u1");
    h.coord.turnClosed("fix it", "fixed", "u1"); // same uuid → ignored
    expect(h.mirrored).toEqual([{ prompt: "fix it", reply: "fixed" }]);
  });

  it("pairs each reply to its OWN turn by prompt identity", () => {
    const h = harness();
    h.coord.turnOpened("first");
    h.coord.turnOpened("second");
    h.coord.turnClosed("first", "r1", "u1"); // Claude answers a pane's turns in order
    h.coord.turnClosed("second", "r2", "u2");
    expect(h.mirrored).toEqual([
      { prompt: "first", reply: "r1" },
      { prompt: "second", reply: "r2" }
    ]);
  });

  it("pairs by identity + self-heals when a /turn-close is dropped (the off-by-one bug)", () => {
    const h = harness();
    // Three typed turns; the FIRST never gets its close (dropped — the real failure).
    h.coord.turnOpened("turn A");
    h.coord.turnOpened("turn B");
    h.coord.turnClosed("turn B", "reply B", "uB"); // B's reply arrives; A's close was lost
    // B pairs with B (NOT A); A is reaped (its reply was already lost) so it can't shift later turns.
    expect(h.mirrored).toEqual([{ prompt: "turn B", reply: "reply B" }]);

    h.coord.turnOpened("turn C");
    h.coord.turnClosed("turn C", "reply C", "uC");
    expect(h.mirrored).toEqual([
      { prompt: "turn B", reply: "reply B" },
      { prompt: "turn C", reply: "reply C" } // C pairs with C — NOT shifted by the lost A
    ]);
    expect(h.coord.isWorking()).toBe(false); // A reaped → the working lamp self-healed
  });

  it("falls back to the oldest open turn when the prompt can't be extracted (empty)", () => {
    const h = harness();
    h.coord.turnOpened("only turn");
    h.coord.turnClosed("", "the reply", "u1"); // empty prompt → fall back to the oldest open turn
    expect(h.mirrored).toEqual([{ prompt: "only turn", reply: "the reply" }]);
  });

  it("interrupt() drops the running turn, goes idle, and ignores its late Stop", async () => {
    const h = harness();
    h.coord.turnOpened("long task");
    expect(h.coord.isWorking()).toBe(true);
    h.coord.interrupt();
    expect(h.coord.isWorking()).toBe(false);
    h.coord.turnClosed("long task", "cancelled", "u1"); // late Stop for the dropped turn
    await tick();
    expect(h.spoken).toEqual([]);
    expect(h.mirrored).toEqual([]);
  });

  it("interruptWith() runs the new prompt immediately, ahead of the running turn", async () => {
    const h = harness();
    h.coord.turnOpened("long task");
    h.coord.interruptWith("urgent fix");
    await tick();
    expect(h.injected).toEqual(["urgent fix"]);
  });

  it("reset() clears in-flight, queued and open turns", async () => {
    const h = harness();
    h.coord.turnOpened("busy");
    h.coord.enqueueVoice("queued"); // gated behind the open turn
    await tick();
    h.coord.reset();
    expect(h.coord.isWorking()).toBe(false);
    h.coord.turnClosed("busy", "late", "u1"); // nothing open → ignored
    await tick();
    expect(h.injected).toEqual([]); // the queued prompt was dropped by reset
    expect(h.spoken).toEqual([]);
  });

  it("reaps a stale open turn so the queue can drain after a missed Stop", async () => {
    const h = harness();
    h.coord.turnOpened("hung turn"); // never closes
    h.coord.enqueueVoice("after"); // gated
    await tick();
    expect(h.injected).toEqual([]);

    h.advance(PAST_TTL_MS);
    h.coord.enqueueVoice("after2"); // a pump trigger: reaps the stale turn, then drains the queue head
    await tick();
    expect(h.injected).toEqual(["after"]); // unblocked — head injected (one prompt at a time)
  });

  it("reaps a stuck injection whose turn-open never arrived", async () => {
    const h = harness();
    h.coord.enqueueVoice("typed1"); // injected, inFlight set, but no turnOpened ever arrives
    await tick();
    expect(h.coord.isWorking()).toBe(true);

    h.advance(PAST_TTL_MS);
    h.coord.enqueueVoice("typed2"); // pump reaps the stuck injection, then injects typed2
    await tick();
    expect(h.injected).toEqual(["typed1", "typed2"]);
  });

  it("releases the slot when an inject fails, so the next prompt can still be sent", async () => {
    const h = harness();
    h.failNextInjects();
    h.coord.enqueueVoice("a");
    await tick();
    expect(h.injected).toEqual(["a"]);
    expect(h.coord.isWorking()).toBe(false); // failure released the in-flight slot

    h.allowInjects();
    h.coord.enqueueVoice("b");
    await tick();
    expect(h.injected).toEqual(["a", "b"]);
  });

  it("evicts the oldest reply uuid past the cap so the dedup set can't grow unbounded", () => {
    const h = harness();
    // Fill the dedup set with 100 unique uuids via orphan closes (uuids recorded, nothing to mirror).
    for (let i = 0; i < 100; i++) h.coord.turnClosed("", `r${i}`, `u${i}`);
    expect(h.mirrored.length).toBe(0);

    // A recent uuid still dedups: a duplicate Stop must NOT consume an open turn.
    h.coord.turnOpened("kept");
    h.coord.turnClosed("kept", "dup", "u99");
    expect(h.mirrored.length).toBe(0);

    // The 101st unique uuid pushes the set over the cap → evicts the oldest (u0); this close is new,
    // so it consumes the still-open "kept" turn.
    h.coord.turnClosed("kept", "r100", "u100");
    expect(h.mirrored).toEqual([{ prompt: "kept", reply: "r100" }]);

    // u0 was evicted, so a Stop carrying it is no longer deduped → it acts on a fresh open turn.
    h.coord.turnOpened("after-evict");
    h.coord.turnClosed("after-evict", "r0-again", "u0");
    expect(h.mirrored).toContainEqual({ prompt: "after-evict", reply: "r0-again" });
  });

  it("drops a stale inject result that resolves after an interrupt re-injected (no clobber)", async () => {
    // A controllable inject: the FIRST call hangs until released; later calls resolve immediately.
    let releaseFirst: (() => void) | undefined;
    const calls: string[] = [];
    const coord = new TurnCoordinator({
      inject: (text) => {
        calls.push(text);
        if (calls.length === 1) return new Promise<boolean>((res) => (releaseFirst = () => res(false)));
        return Promise.resolve(true);
      },
      speakReply: () => {},
      mirrorTypedTurn: () => {},
      onStatusChange: () => {},
      now: () => 1
    });

    coord.enqueueVoice("x"); // inject("x") starts and hangs; inFlight = "x"
    await tick();
    expect(calls).toEqual(["x"]);

    coord.interruptWith("y"); // clears, re-injects "y" (resolves true); inFlight = "y"
    await tick();
    expect(calls).toEqual(["x", "y"]);
    expect(coord.currentVoicePrompt).toBe("y");

    releaseFirst?.(); // the stale first inject finally fails — must NOT clobber the live "y"
    await tick();
    expect(coord.currentVoicePrompt).toBe("y");
    expect(coord.isWorking()).toBe(true);
  });

  it("identifies a stale inject by token, not text, when the SAME prompt is re-injected", async () => {
    // The status/summary prompts are fixed canned strings, so an interrupt can re-inject identical
    // text while the first inject is still in flight — a string-equality guard would mis-pass it.
    let releaseFirst: (() => void) | undefined;
    const calls: string[] = [];
    let speaks = 0;
    const coord = new TurnCoordinator({
      inject: (text) => {
        calls.push(text);
        if (calls.length === 1) return new Promise<boolean>((res) => (releaseFirst = () => res(false)));
        return Promise.resolve(true);
      },
      speakReply: () => {
        speaks += 1;
      },
      mirrorTypedTurn: () => {},
      onStatusChange: () => {},
      now: () => 1
    });

    coord.enqueueVoice("status"); // inject #1 ("status") hangs
    await tick();
    coord.interruptWith("status"); // re-inject the SAME text; inject #2 resolves true
    await tick();
    expect(calls).toEqual(["status", "status"]);

    releaseFirst?.(); // stale #1 fails — token mismatch must drop it, leaving #2's injection intact
    await tick();
    expect(coord.currentVoicePrompt).toBe("status");
    expect(coord.isWorking()).toBe(true);

    // #2 is still a live VOICE injection: its turn opens + closes and is SPOKEN (not misclassified).
    coord.turnOpened("status");
    coord.turnClosed("status", "here's your status", "u1");
    await tick();
    expect(speaks).toBe(1);
  });
});
