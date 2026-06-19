import { describe, expect, it } from "vitest";
import { toBrowserUrl, toWebSocketUrl } from "./config.js";

describe("voice remote URL helpers", () => {
  it("creates browser session URLs without exposing daemon role", () => {
    expect(toBrowserUrl("https://voice.example.com/base", "abc", "secret")).toBe(
      "https://voice.example.com/s/abc?token=secret"
    );
  });

  it("creates daemon websocket URLs from https bridge URLs", () => {
    expect(toWebSocketUrl("https://voice.example.com", "abc", "secret", "daemon")).toBe(
      "wss://voice.example.com/ws/abc?token=secret&role=daemon"
    );
  });

  it("creates local websocket URLs from http bridge URLs", () => {
    expect(toWebSocketUrl("http://localhost:8787", "abc", "secret", "browser")).toBe(
      "ws://localhost:8787/ws/abc?token=secret&role=browser"
    );
  });
});
