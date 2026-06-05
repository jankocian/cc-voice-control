import { describe, expect, it } from "vitest";
import { isInterruptText } from "./protocol.js";

describe("isInterruptText", () => {
  it("detects high priority stop language", () => {
    expect(isInterruptText("stop what you are doing")).toBe(true);
    expect(isInterruptText("cancel that migration")).toBe(true);
    expect(isInterruptText("wait, don't modify the DB")).toBe(true);
  });

  it("does not treat ordinary instructions as interrupts", () => {
    expect(isInterruptText("check the auth middleware first")).toBe(false);
    expect(isInterruptText("write the documentation")).toBe(false);
  });
});
