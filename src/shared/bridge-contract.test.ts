import { describe, expect, it } from "vitest";
import {
  parseBridgeBrowserSessionPath,
  parseBridgeClaimPath,
  parseBridgeClientRole,
  parseBridgeWebSocketPath,
  parseBridgeWebSocketUrl,
  readBridgeAuthQuery,
  toBridgeBrowserSessionUrl,
  toBridgeClaimPath,
  toBridgeWebSocketPath,
  toBridgeWebSocketUrl
} from "./bridge-contract.js";

describe("bridge URL contract", () => {
  it("builds the phone URL: sessionId in the path, secret in the fragment", () => {
    const url = toBridgeBrowserSessionUrl("https://voice.example.com/base", "ab12cd34", "the-secret");
    expect(url).toBe("https://voice.example.com/s/ab12cd34#the-secret");

    // The worker only ever sees the path; the fragment is dropped by the browser before the request.
    const path = new URL(url).pathname;
    expect(parseBridgeBrowserSessionPath(path)).toBe("ab12cd34");
    expect(path).not.toContain("the-secret");
  });

  it("rejects an empty secret", () => {
    expect(() => toBridgeBrowserSessionUrl("https://voice.example.com", "ab12cd34", "")).toThrow();
  });

  it("maps https bridge URLs to daemon websocket URLs routed by sessionId", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "ab12cd34", "daemon");

    expect(url).toBe("wss://voice.example.com/ws/ab12cd34?role=daemon");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ sessionId: "ab12cd34", role: "daemon" });
  });

  it("maps http bridge URLs to browser websocket URLs", () => {
    const url = toBridgeWebSocketUrl("http://localhost:8787", "ab12cd34", "browser");

    expect(url).toBe("ws://localhost:8787/ws/ab12cd34?role=browser");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ sessionId: "ab12cd34", role: "browser" });
  });

  it("keeps ws/claim/page path construction and parsing symmetric", () => {
    expect(toBridgeWebSocketPath("sid")).toBe("/ws/sid");
    expect(parseBridgeWebSocketPath("/ws/sid")).toBe("sid");

    expect(toBridgeClaimPath("sid")).toBe("/claim/sid");
    expect(parseBridgeClaimPath("/claim/sid")).toBe("sid");

    expect(parseBridgeBrowserSessionPath("/s/sid")).toBe("sid");
    expect(parseBridgeBrowserSessionPath("/s")).toBeUndefined();
    expect(parseBridgeBrowserSessionPath("/ws/sid")).toBeUndefined();
  });

  it("reads the role from websocket query params", () => {
    const url = new URL("wss://voice.example.com/ws/sid?role=daemon");

    expect(readBridgeAuthQuery(url.searchParams)).toEqual({ role: "daemon" });
  });

  it("carries the daemon's threadId on the websocket URL (routing key, not a credential)", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "sid", "daemon", "surface:7");

    expect(url).toBe("wss://voice.example.com/ws/sid?role=daemon&threadId=surface%3A7");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ sessionId: "sid", role: "daemon", threadId: "surface:7" });
    expect(readBridgeAuthQuery(new URL(url).searchParams)).toEqual({ role: "daemon", threadId: "surface:7" });
  });

  it("omits threadId for a browser socket (a browser is not bound to one thread)", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "sid", "browser");
    expect(url).toBe("wss://voice.example.com/ws/sid?role=browser");
    expect(parseBridgeWebSocketUrl(url)?.threadId).toBeUndefined();
  });

  it("rejects invalid or missing roles for websocket URLs", () => {
    expect(parseBridgeClientRole("daemon")).toBe("daemon");
    expect(parseBridgeClientRole("browser")).toBe("browser");
    expect(parseBridgeClientRole("operator")).toBeUndefined();
    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/sid?role=operator")).toBeUndefined();
    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/sid")).toBeUndefined();
  });
});
