import { describe, expect, it } from "vitest";
import { deriveStatus, gradeThread, humanizeAgo, RECONNECT_GRACE_MS, type StatusInputs } from "./status";

// A healthy-but-no-daemon baseline: socket OPEN, daemon absent. The three new gradings
// differ only in `daemonLastSeenAt` vs `now`, so each case overrides just those.
const NOW = 1_700_000_000_000;

function noDaemon(over: Partial<StatusInputs>): StatusInputs {
  return {
    connected: true,
    daemonConnected: false,
    daemonLastSeenAt: null,
    now: NOW,
    recording: false,
    transcribing: false,
    speaking: false,
    runtimeState: "idle",
    currentTask: undefined,
    listening: true,
    flash: null,
    ...over
  };
}

describe("deriveStatus — no-daemon grading by elapsed time", () => {
  it("never seen (daemonLastSeenAt null) → 'Waiting for Claude Code'", () => {
    const status = deriveStatus(noDaemon({ daemonLastSeenAt: null }));
    expect(status.key).toBe("waiting");
    expect(status.title).toBe("Waiting for Claude Code");
    expect(status.detail).toBe("Start the daemon in your terminal");
    expect(status.dataState).toBe("offline");
    expect(status.canAct).toBe(false);
  });

  it("dropped recently (within the grace window) → 'Reconnecting…'", () => {
    const status = deriveStatus(noDaemon({ daemonLastSeenAt: NOW - 5_000 }));
    expect(status.key).toBe("reconnecting");
    expect(status.title).toBe("Reconnecting…");
    expect(status.canAct).toBe(false);
  });

  it("just before the grace boundary is still 'Reconnecting…' (not yet offline)", () => {
    const status = deriveStatus(noDaemon({ daemonLastSeenAt: NOW - (RECONNECT_GRACE_MS - 1) }));
    expect(status.key).toBe("reconnecting");
    expect(status.key).not.toBe("offline-stale");
  });

  it("at/after the grace boundary → 'offline-stale' / 'Session offline'", () => {
    const atBoundary = deriveStatus(noDaemon({ daemonLastSeenAt: NOW - RECONNECT_GRACE_MS }));
    expect(atBoundary.key).toBe("offline-stale");

    const stale = deriveStatus(noDaemon({ daemonLastSeenAt: NOW - 14 * 60 * 60 * 1000 }));
    expect(stale.key).toBe("offline-stale");
    expect(stale.title).toBe("Session offline");
    expect(stale.dataState).toBe("offline");
    expect(stale.detail).toContain("Last active 14h ago");
    expect(stale.canAct).toBe(false);
  });

  it("a present daemon ignores the timestamp entirely (still ready/canAct)", () => {
    const status = deriveStatus(noDaemon({ daemonConnected: true, daemonLastSeenAt: NOW - 10 * 60 * 60 * 1000 }));
    expect(status.key).toBe("ready");
    expect(status.canAct).toBe(true);
  });

  it("a closed socket short-circuits to 'connecting' before any grading", () => {
    const status = deriveStatus(noDaemon({ connected: false, daemonLastSeenAt: NOW - 14 * 60 * 60 * 1000 }));
    expect(status.key).toBe("connecting");
  });
});

describe("gradeThread — the per-thread switcher dot (#10 reused per thread)", () => {
  it("a connected, idle thread is success (green)", () => {
    expect(gradeThread({ connected: true, state: "idle", listening: true })).toBe("success");
  });

  it("a connected, working thread is coral", () => {
    expect(gradeThread({ connected: true, state: "working", listening: true })).toBe("coral");
  });

  it("a disconnected thread is faint regardless of its last state", () => {
    expect(gradeThread({ connected: false, state: "working", listening: true })).toBe("faint");
  });

  it("a connected thread whose pane is unreachable is faint (not actionable)", () => {
    expect(gradeThread({ connected: true, state: "idle", listening: false })).toBe("faint");
  });
});

describe("humanizeAgo", () => {
  it("sub-minute reads 'just now'", () => {
    expect(humanizeAgo(0)).toBe("just now");
    expect(humanizeAgo(59_000)).toBe("just now");
  });

  it("floors to whole minutes/hours/days", () => {
    expect(humanizeAgo(60_000)).toBe("1m ago");
    expect(humanizeAgo(3 * 60_000 + 40_000)).toBe("3m ago");
    expect(humanizeAgo(59 * 60_000)).toBe("59m ago");
    expect(humanizeAgo(60 * 60_000)).toBe("1h ago");
    expect(humanizeAgo(14 * 60 * 60 * 1000)).toBe("14h ago");
    expect(humanizeAgo(23 * 60 * 60 * 1000)).toBe("23h ago");
    expect(humanizeAgo(24 * 60 * 60 * 1000)).toBe("1d ago");
    expect(humanizeAgo(2 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000)).toBe("2d ago");
  });
});
