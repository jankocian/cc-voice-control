import { describe, expect, it } from "vitest";
import {
  isBridgeBrowserSessionPath,
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
  it("carries the secret in the fragment, never the path (the worker never sees it)", () => {
    const url = toBridgeBrowserSessionUrl("https://voice.example.com/base", "the-secret");
    expect(url).toBe("https://voice.example.com/s#the-secret");

    // The worker only ever sees the path; the fragment is dropped by the browser before the request.
    const path = new URL(url).pathname;
    expect(isBridgeBrowserSessionPath(path)).toBe(true);
    expect(path).not.toContain("the-secret");
  });

  it("keeps the phone URL the same length as the old /s/<secret> path (QR size unchanged)", () => {
    const secret = "0123456789abcdefghijkl"; // 22-char base64url stand-in
    const url = toBridgeBrowserSessionUrl("https://voice-control.nee.rs", secret);
    expect(url).toBe(`https://voice-control.nee.rs/s#${secret}`);
  });

  it("rejects an empty secret", () => {
    expect(() => toBridgeBrowserSessionUrl("https://voice.example.com", "")).toThrow();
  });

  it("maps https bridge URLs to daemon websocket URLs routed by routingId", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "abc123", "daemon");

    expect(url).toBe("wss://voice.example.com/ws/abc123?role=daemon");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ routingId: "abc123", role: "daemon" });
  });

  it("maps http bridge URLs to browser websocket URLs", () => {
    const url = toBridgeWebSocketUrl("http://localhost:8787", "abc123", "browser");

    expect(url).toBe("ws://localhost:8787/ws/abc123?role=browser");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ routingId: "abc123", role: "browser" });
  });

  it("keeps ws/claim path construction and parsing symmetric", () => {
    expect(toBridgeWebSocketPath("rid")).toBe("/ws/rid");
    expect(parseBridgeWebSocketPath("/ws/rid")).toBe("rid");

    expect(toBridgeClaimPath("rid")).toBe("/claim/rid");
    expect(parseBridgeClaimPath("/claim/rid")).toBe("rid");
  });

  it("isBridgeBrowserSessionPath only matches the exact /s route", () => {
    expect(isBridgeBrowserSessionPath("/s")).toBe(true);
    expect(isBridgeBrowserSessionPath("/s/anything")).toBe(false);
    expect(isBridgeBrowserSessionPath("/ws/rid")).toBe(false);
    expect(isBridgeBrowserSessionPath("/")).toBe(false);
  });

  it("reads the role from websocket query params", () => {
    const url = new URL("wss://voice.example.com/ws/rid?role=daemon");

    expect(readBridgeAuthQuery(url.searchParams)).toEqual({ role: "daemon" });
  });

  it("carries the daemon's threadId on the websocket URL (routing key, not a credential)", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "rid", "daemon", "surface:7");

    expect(url).toBe("wss://voice.example.com/ws/rid?role=daemon&threadId=surface%3A7");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ routingId: "rid", role: "daemon", threadId: "surface:7" });
    expect(readBridgeAuthQuery(new URL(url).searchParams)).toEqual({ role: "daemon", threadId: "surface:7" });
  });

  it("omits threadId for a browser socket (a browser is not bound to one thread)", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "rid", "browser");
    expect(url).toBe("wss://voice.example.com/ws/rid?role=browser");
    expect(parseBridgeWebSocketUrl(url)?.threadId).toBeUndefined();
  });

  it("rejects invalid or missing roles for websocket URLs", () => {
    expect(parseBridgeClientRole("daemon")).toBe("daemon");
    expect(parseBridgeClientRole("browser")).toBe("browser");
    expect(parseBridgeClientRole("operator")).toBeUndefined();
    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/rid?role=operator")).toBeUndefined();
    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/rid")).toBeUndefined();
  });
});
