import { describe, expect, it } from "vitest";
import {
  parseBridgeBrowserSessionPath,
  parseBridgeBrowserSessionUrl,
  parseBridgeClientRole,
  parseBridgeExpiresAt,
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
    const url = toBridgeBrowserSessionUrl("https://voice.example.com/base", "abc", "secret", 123456);

    expect(url).toBe("https://voice.example.com/s/abc?token=secret&expiresAt=123456");
    expect(parseBridgeBrowserSessionUrl(url)).toEqual({
      sessionId: "abc",
      token: "secret",
      expiresAt: 123456
    });
  });

  it("maps https bridge URLs to daemon websocket URLs", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "abc", "secret", "daemon", 123456);

    expect(url).toBe("wss://voice.example.com/ws/abc?token=secret&role=daemon&expiresAt=123456");
    expect(parseBridgeWebSocketUrl(url)).toEqual({
      sessionId: "abc",
      token: "secret",
      role: "daemon",
      expiresAt: 123456
    });
  });

  it("maps http bridge URLs to browser websocket URLs", () => {
    const url = toBridgeWebSocketUrl("http://localhost:8787", "abc", "secret", "browser");

    expect(url).toBe("ws://localhost:8787/ws/abc?token=secret&role=browser");
    expect(parseBridgeWebSocketUrl(url)).toEqual({
      sessionId: "abc",
      token: "secret",
      role: "browser"
    });
  });

  it("keeps path construction and parsing symmetric", () => {
    expect(toBridgeBrowserSessionPath("session/with/slash")).toBe("/s/session%2Fwith%2Fslash");
    expect(parseBridgeBrowserSessionPath("/s/session%2Fwith%2Fslash")).toBe("session/with/slash");

    expect(toBridgeWebSocketPath("session/with/slash")).toBe("/ws/session%2Fwith%2Fslash");
    expect(parseBridgeWebSocketPath("/ws/session%2Fwith%2Fslash")).toBe("session/with/slash");
  });

  it("reads token role and expiresAt from websocket query params", () => {
    const url = new URL("wss://voice.example.com/ws/abc?token=secret&role=daemon&expiresAt=123456");

    expect(readBridgeAuthQuery(url.searchParams)).toEqual({
      token: "secret",
      role: "daemon",
      expiresAt: 123456
    });
  });

  it("rejects invalid roles", () => {
    expect(parseBridgeClientRole("daemon")).toBe("daemon");
    expect(parseBridgeClientRole("browser")).toBe("browser");
    expect(parseBridgeClientRole("operator")).toBeUndefined();
    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/abc?token=secret&role=operator")).toBeUndefined();
  });

  it("treats missing and invalid expiresAt values as absent", () => {
    expect(parseBridgeExpiresAt(null)).toBeUndefined();
    expect(parseBridgeExpiresAt("")).toBeUndefined();
    expect(parseBridgeExpiresAt("not-a-number")).toBeUndefined();
    expect(parseBridgeExpiresAt("0")).toBeUndefined();
    expect(parseBridgeExpiresAt("-1")).toBeUndefined();

    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/abc?token=secret&role=daemon")).toEqual({
      sessionId: "abc",
      token: "secret",
      role: "daemon"
    });
    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/abc?token=secret&role=daemon&expiresAt=nope")).toEqual({
      sessionId: "abc",
      token: "secret",
      role: "daemon"
    });
  });
});
