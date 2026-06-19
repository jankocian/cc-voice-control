import { describe, expect, it, vi } from "vitest";
import { reconcile } from "./reconcile.js";

function actions(overrides: { flagPresent: boolean; hasDaemon: boolean }) {
  const activate = vi.fn().mockResolvedValue(undefined);
  const ensureRuntime = vi.fn();
  const deactivate = vi.fn();
  return { activate, ensureRuntime, deactivate, ...overrides };
}

describe("reconcile", () => {
  it("activates when the flag appears and no daemon is running", async () => {
    const a = actions({ flagPresent: true, hasDaemon: false });
    await reconcile(a);
    expect(a.activate).toHaveBeenCalledTimes(1);
    expect(a.ensureRuntime).not.toHaveBeenCalled();
    expect(a.deactivate).not.toHaveBeenCalled();
  });

  // The regression: /start deletes runtime.json then re-touches an already-present
  // flag, so no rising-edge activation fires. The poll must re-publish runtime.json
  // for the running daemon instead of silently doing nothing.
  it("re-publishes runtime.json when the flag is present and the daemon is already up", async () => {
    const a = actions({ flagPresent: true, hasDaemon: true });
    await reconcile(a);
    expect(a.ensureRuntime).toHaveBeenCalledTimes(1);
    expect(a.activate).not.toHaveBeenCalled();
    expect(a.deactivate).not.toHaveBeenCalled();
  });

  it("deactivates when the flag is removed while a daemon is running", async () => {
    const a = actions({ flagPresent: false, hasDaemon: true });
    await reconcile(a);
    expect(a.deactivate).toHaveBeenCalledTimes(1);
    expect(a.activate).not.toHaveBeenCalled();
    expect(a.ensureRuntime).not.toHaveBeenCalled();
  });

  it("does nothing when the flag is absent and no daemon is running", async () => {
    const a = actions({ flagPresent: false, hasDaemon: false });
    await reconcile(a);
    expect(a.activate).not.toHaveBeenCalled();
    expect(a.ensureRuntime).not.toHaveBeenCalled();
    expect(a.deactivate).not.toHaveBeenCalled();
  });
});
