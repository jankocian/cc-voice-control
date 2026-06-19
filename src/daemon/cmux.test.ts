import { describe, expect, it } from "vitest";
import { cmuxTarget } from "./cmux.js";

// The targeting contract is load-bearing for robustness: cmux scopes a `--surface`
// lookup to $CMUX_WORKSPACE_ID when present, so pinning (or inheriting) a workspace
// makes a moved pane invisible. We therefore target by `--surface` ONLY and clear
// the workspace from the spawn env (covered by cmuxEnv). These tests pin the arg
// shape so a future change can't silently reintroduce a `--workspace` pin.
describe("cmuxTarget", () => {
  it("targets by --surface only, never --workspace", () => {
    const args = cmuxTarget("DAB0B26B-ACF9-43D8-BBE4-BD3A5B421308");
    expect(args).toEqual(["--surface", "DAB0B26B-ACF9-43D8-BBE4-BD3A5B421308"]);
    expect(args).not.toContain("--workspace");
  });

  it("accepts short surface refs as well as UUIDs", () => {
    expect(cmuxTarget("surface:42")).toEqual(["--surface", "surface:42"]);
  });

  it("emits no target when the surface is unknown (cmux falls back to caller defaults)", () => {
    expect(cmuxTarget(undefined)).toEqual([]);
    expect(cmuxTarget("")).toEqual([]);
  });
});
