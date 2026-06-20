import { describe, expect, it } from "vitest";
import { stripSpinnerGlyph } from "./cmux.js";
import { computeLabel, type LabelProbes } from "./labels.js";

// Stub the cmux/git probes so the title-priority and graceful-degrade logic is tested without
// spawning child processes. Each field returned mirrors a real source being present or absent.
function probes(overrides: Partial<LabelProbes> = {}): LabelProbes {
  return {
    surfaceTitle: async () => undefined,
    gitRepoBranch: async () => ({}),
    ...overrides
  };
}

describe("computeLabel — title priority (most specific first)", () => {
  it("prefers the cmux pane title (the live task description) when present", async () => {
    const label = await computeLabel(
      "/work/voice-control",
      "surface:1",
      "surface:1",
      probes({
        surfaceTitle: async () => "Review to-dos and plan next implementation",
        gitRepoBranch: async () => ({ repo: "voice-control", branch: "main" })
      })
    );
    expect(label.title).toBe("Review to-dos and plan next implementation");
    // The other fields are still populated for the chip's secondary line.
    expect(label.repo).toBe("voice-control");
    expect(label.branch).toBe("main");
    expect(label.cwd).toBe("voice-control");
  });

  it("falls back to `repo · branch` when there is no pane title", async () => {
    const label = await computeLabel(
      "/work/voice-control",
      "surface:1",
      "surface:1",
      probes({ gitRepoBranch: async () => ({ repo: "voice-control", branch: "feat/x" }) })
    );
    expect(label.title).toBe("voice-control · feat/x");
  });

  it("falls back to the repo alone when the branch is missing (e.g. detached HEAD)", async () => {
    const label = await computeLabel(
      "/work/voice-control",
      "s",
      "s",
      probes({ gitRepoBranch: async () => ({ repo: "voice-control" }) })
    );
    expect(label.title).toBe("voice-control");
  });

  it("falls back to the cwd basename when it is not a git repo", async () => {
    const label = await computeLabel("/work/scratchpad", "s", "s", probes());
    expect(label.title).toBe("scratchpad");
    expect(label.repo).toBeUndefined();
    expect(label.branch).toBeUndefined();
  });

  it("falls back to the threadId so the chip is never blank", async () => {
    // No title, no git, an empty cwd → the threadId floor.
    const label = await computeLabel("", "surface:99", "surface:99", probes());
    expect(label.title).toBe("surface:99");
  });
});

describe("stripSpinnerGlyph — cmux prefixes the running title with a spinner", () => {
  it("strips a leading Braille spinner glyph + whitespace", () => {
    expect(stripSpinnerGlyph("⠂ Review to-dos and plan")).toBe("Review to-dos and plan");
  });

  it("leaves a clean title untouched", () => {
    expect(stripSpinnerGlyph("Implement the thread switcher")).toBe("Implement the thread switcher");
  });

  it("strips any leading non-word run, not just one glyph", () => {
    expect(stripSpinnerGlyph("⠿⠿   Build")).toBe("Build");
  });
});
