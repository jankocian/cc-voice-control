// Run async tasks strictly in submission order, isolating failures so one rejection can neither wedge
// nor reorder the rest. Used wherever messages cross a socket in order but the per-message work is async
// (seal / open) — the daemon's outbound seals and the phone's inbound decrypts + outbound seals. One
// helper so that "keep order, never break the chain" lives in a single tested place instead of three
// hand-rolled promise tails.
export function createSerializer(): (task: () => Promise<void> | void) => void {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    tail = tail.then(task).catch(() => {
      // A failed task must not break the chain (later tasks still run) — failures are swallowed here;
      // tasks that need to surface an error do so themselves.
    });
  };
}
