import { describe, expect, it } from "vitest";
import { toBrowserUrl, toWebSocketUrl } from "./config.js";

describe("voice remote URL helpers", () => {
  it("creates browser session URLs from the single secret", () => {
    expect(toBrowserUrl("https://voice.example.com/base", "secret")).toBe("https://voice.example.com/s/secret");
  });

  it("creates daemon websocket URLs from https bridge URLs", () => {
    expect(toWebSocketUrl("https://voice.example.com", "secret", "daemon")).toBe(
      "wss://voice.example.com/ws/secret?role=daemon"
    );
  });

  it("creates local websocket URLs from http bridge URLs", () => {
    expect(toWebSocketUrl("http://localhost:8787", "secret", "browser")).toBe(
      "ws://localhost:8787/ws/secret?role=browser"
    );
  });
});
