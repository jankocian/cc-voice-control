/**
 * Pure reconcile step for the MCP server's flag-watch loop. Kept in its own module
 * (mcp-server.ts has import-time side effects: the poll interval, stdin handlers and
 * a console.log override) so the decision logic can be unit-tested in isolation.
 *
 * The `active` flag is the *desired* state; the live daemon and runtime.json are the
 * *actual* state, reconciled toward the flag on every poll:
 *
 *   flag present, no daemon  -> activate   (start the daemon, which writes runtime.json)
 *   flag present, daemon up  -> ensureRuntime  (re-publish runtime.json if it went missing)
 *   flag absent,  daemon up  -> deactivate (stop the daemon, which removes runtime.json)
 *   flag absent,  no daemon  -> nothing
 *
 * The middle branch is the fix for the "/start reports NOT_RUNNING" bug: the start
 * skill deletes runtime.json and re-touches an already-present flag, so the
 * rising-edge `activate()` never fires. Without an explicit re-publish the URL file
 * would stay gone for the life of the daemon. Treating runtime.json as derived state
 * the poll keeps in sync makes `/start` idempotent and self-healing.
 */
export type ReconcileActions = {
  /** Is the `active` flag file present this tick? */
  flagPresent: boolean;
  /** Is a daemon currently running? */
  hasDaemon: boolean;
  /** Start the daemon (writes runtime.json). May reject; caller logs. */
  activate: () => Promise<void>;
  /** Re-publish runtime.json if missing. Cheap; safe to call every tick. */
  ensureRuntime: () => void;
  /** Stop the daemon (removes runtime.json). */
  deactivate: () => void;
};

export async function reconcile(actions: ReconcileActions): Promise<void> {
  if (actions.flagPresent) {
    if (!actions.hasDaemon) await actions.activate();
    else actions.ensureRuntime();
  } else if (actions.hasDaemon) {
    actions.deactivate();
  }
}
