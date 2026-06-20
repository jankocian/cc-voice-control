import { describe, expect, it } from "vitest";
import { shouldReap } from "./standalone.js";

describe("shouldReap (orphan self-reap guard)", () => {
  it("does not reap while a normal Claude parent is in place", () => {
    expect(shouldReap(4242)).toBe(false);
  });

  it("reaps only when reparented to launchd (ppid → 1)", () => {
    expect(shouldReap(1)).toBe(true);
  });
});
