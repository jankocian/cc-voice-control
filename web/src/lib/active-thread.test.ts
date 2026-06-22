import { beforeEach, describe, expect, it } from "vitest";
import { initialThread, storeActiveThread } from "./active-thread";

// The vitest env here is node (no jsdom dep), so shim the two browser globals this module reads: an
// in-memory localStorage and a window.location whose `search` we can drive.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(): string | null {
    return null;
  }
  get length(): number {
    return this.m.size;
  }
}

let search = "";
const setSearch = (s: string): void => {
  search = s;
};

beforeEach(() => {
  search = "";
  (globalThis as { localStorage: Storage }).localStorage = new MemStorage();
  (globalThis as { window: unknown }).window = {
    location: {
      get search() {
        return search;
      }
    }
  };
});

describe("active-thread store", () => {
  it("returns null with no deep link and nothing stored", () => {
    expect(initialThread()).toBeNull();
  });

  it("restores the last stored thread on a plain load", () => {
    storeActiveThread("B");
    expect(initialThread()).toBe("B");
  });

  it("a fresh ?t= deep link wins once and becomes the stored thread", () => {
    storeActiveThread("B");
    setSearch("?t=A");
    expect(initialThread()).toBe("A");
    setSearch(""); // a later plain load restores it from storage
    expect(initialThread()).toBe("A");
  });

  it("ignores a ?t= it already consumed (the same one rides every PWA relaunch)", () => {
    setSearch("?t=A");
    expect(initialThread()).toBe("A"); // consumed
    storeActiveThread("B"); // user then switched to B
    setSearch("?t=A"); // the pinned launch URL still carries ?t=A
    expect(initialThread()).toBe("B"); // stored wins; the stale hint is ignored
  });
});
