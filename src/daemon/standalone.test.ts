import { describe, expect, it } from "vitest";
import { shouldReap } from "./standalone.js";

describe("shouldReap (orphan self-reap guard)", () => {
  it("does not reap while a normal Claude parent is in place", () => {
    expect(shouldReap(4242, 4242)).toBe(false);
  });

  it("reaps when REPARENTED to launchd (ppid changed 4242 → 1)", () => {
    expect(shouldReap(1, 4242)).toBe(true);
  });

  it("does NOT reap a container/Codespaces daemon born under init (ppid was 1 from the start)", () => {
    expect(shouldReap(1, 1)).toBe(false);
  });
});
