import { describe, expect, it } from "vitest";
import { cmuxTarget, parseWorkspaceRef } from "./cmux.js";

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

// `spawnWorkspace` (spawn-by-voice) relies on `new-workspace` printing `OK workspace:<N>` on
// stdout to learn the new ref deterministically (probe §0.6-B). Pin the parser so trailing log
// noise or a missing line can't silently break the spawn-ref resolution.
describe("parseWorkspaceRef", () => {
  it("extracts the workspace ref from the documented `OK workspace:<N>` stdout", () => {
    expect(parseWorkspaceRef("OK workspace:22\n")).toBe("workspace:22");
  });

  it("tolerates surrounding/trailing output and still finds the ref", () => {
    expect(parseWorkspaceRef("some banner\nOK workspace:7 created\n")).toBe("workspace:7");
  });

  it("returns undefined when stdout has no workspace ref", () => {
    expect(parseWorkspaceRef("ERROR: could not create\n")).toBeUndefined();
    expect(parseWorkspaceRef("")).toBeUndefined();
  });
});
