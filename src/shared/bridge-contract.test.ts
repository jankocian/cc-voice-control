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
  it("builds browser session URLs from the single secret and parses the worker route shape", () => {
    const url = toBridgeBrowserSessionUrl("https://voice.example.com/base", "secret");

    expect(url).toBe("https://voice.example.com/s/secret");
    expect(parseBridgeBrowserSessionUrl(url)).toEqual({ secret: "secret" });
  });

  it("maps https bridge URLs to daemon websocket URLs", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "secret", "daemon");

    expect(url).toBe("wss://voice.example.com/ws/secret?role=daemon");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ secret: "secret", role: "daemon" });
  });

  it("maps http bridge URLs to browser websocket URLs", () => {
    const url = toBridgeWebSocketUrl("http://localhost:8787", "secret", "browser");

    expect(url).toBe("ws://localhost:8787/ws/secret?role=browser");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ secret: "secret", role: "browser" });
  });

  it("keeps path construction and parsing symmetric", () => {
    expect(toBridgeBrowserSessionPath("secret/with/slash")).toBe("/s/secret%2Fwith%2Fslash");
    expect(parseBridgeBrowserSessionPath("/s/secret%2Fwith%2Fslash")).toBe("secret/with/slash");

    expect(toBridgeWebSocketPath("secret/with/slash")).toBe("/ws/secret%2Fwith%2Fslash");
    expect(parseBridgeWebSocketPath("/ws/secret%2Fwith%2Fslash")).toBe("secret/with/slash");
  });

  it("reads the role from websocket query params", () => {
    const url = new URL("wss://voice.example.com/ws/secret?role=daemon");

    expect(readBridgeAuthQuery(url.searchParams)).toEqual({ role: "daemon" });
  });

  it("carries the daemon's threadId on the websocket URL (routing key, not a credential)", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "secret", "daemon", "surface:7");

    expect(url).toBe("wss://voice.example.com/ws/secret?role=daemon&threadId=surface%3A7");
    expect(parseBridgeWebSocketUrl(url)).toEqual({ secret: "secret", role: "daemon", threadId: "surface:7" });
    expect(readBridgeAuthQuery(new URL(url).searchParams)).toEqual({ role: "daemon", threadId: "surface:7" });
  });

  it("omits threadId for a browser socket (a browser is not bound to one thread)", () => {
    const url = toBridgeWebSocketUrl("https://voice.example.com", "secret", "browser");
    expect(url).toBe("wss://voice.example.com/ws/secret?role=browser");
    expect(parseBridgeWebSocketUrl(url)?.threadId).toBeUndefined();
  });

  it("rejects invalid or missing roles for websocket URLs", () => {
    expect(parseBridgeClientRole("daemon")).toBe("daemon");
    expect(parseBridgeClientRole("browser")).toBe("browser");
    expect(parseBridgeClientRole("operator")).toBeUndefined();
    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/secret?role=operator")).toBeUndefined();
    expect(parseBridgeWebSocketUrl("wss://voice.example.com/ws/secret")).toBeUndefined();
  });
});
