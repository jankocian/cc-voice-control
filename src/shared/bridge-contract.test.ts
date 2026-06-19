import { describe, expect, it } from "vitest";
import {
  parseBridgeBrowserSessionPath,
  parseBridgeBrowserSessionUrl,
  parseBridgeClientRole,
  parseBridgeWebSocketPath,
  parseBridgeWebSocketUrl,
  readBridgeAuthQuery,
  toBridgeBrowserSessionPath,
  toBridgeBrowserSessionUrl,
  toBridgeWebSocketPath,
  toBridgeWebSocketUrl
} from "./bridge-contract.js";

describe("bridge URL contract", () => {
  it("builds browser session URLs and parses the worker route/query shape", () => {
    const url = toBridgeBrowserSessionUrl("https://voice.example.com/base", "abc", "secret");

    expect(url).toBe("https://voice.example.com/s/abc?token=secret");
    expect(parseBridgeBrowserSessionUrl(url)).toEqual({ sessionId: "abc", token: "secret" });
  });

  it("maps https bridge URLs to daemon websocket URLs", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "abc", "secret", "daemon");

    expect(url).toBe("wss://voice.example.com/ws/abc?token=secret&role=daemon");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ sessionId: "abc", token: "secret", role: "daemon" });
  });

  it("maps http bridge URLs to browser websocket URLs", () => {
    const url = toBridgeWebSocketUrl("http://localhost:8787", "abc", "secret", "browser");

    expect(url).toBe("ws://localhost:8787/ws/abc?token=secret&role=browser");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ sessionId: "abc", token: "secret", role: "browser" });
  });

  it("keeps path construction and parsing symmetric", () => {
    expect(toBridgeBrowserSessionPath("session/with/slash")).toBe("/s/session%2Fwith%2Fslash");
    expect(parseBridgeBrowserSessionPath("/s/session%2Fwith%2Fslash")).toBe("session/with/slash");

    expect(toBridgeWebSocketPath("session/with/slash")).toBe("/ws/session%2Fwith%2Fslash");
    expect(parseBridgeWebSocketPath("/ws/session%2Fwith%2Fslash")).toBe("session/with/slash");
  });

  it("reads token and role from websocket query params", () => {
    const url = new URL("wss://voice.example.com/ws/abc?token=secret&role=daemon");

    expect(readBridgeAuthQuery(url.searchParams)).toEqual({ token: "secret", role: "daemon" });
  });

  it("rejects invalid or missing roles for websocket URLs", () => {
    expect(parseBridgeClientRole("daemon")).toBe("daemon");
    expect(parseBridgeClientRole("browser")).toBe("browser");
    expect(parseBridgeClientRole("operator")).toBeUndefined();
    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/abc?token=secret&role=operator")).toBeUndefined();
    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/abc?token=secret")).toBeUndefined();
  });
});
