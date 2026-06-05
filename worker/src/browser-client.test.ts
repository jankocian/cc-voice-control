import { describe, expect, it } from "vitest";
import {
  BROWSER_CLIENT_WAIT_CONTRACT,
  ELEVENLABS_CLIENT_TOOL_MAPPINGS,
  renderBrowserClientModuleScript
} from "./browser-client.js";

describe("browser voice client contract", () => {
  it("maps every configured ElevenLabs client tool to its daemon event type", () => {
    expect(Object.fromEntries(ELEVENLABS_CLIENT_TOOL_MAPPINGS.map((mapping) => [mapping.toolName, mapping]))).toEqual({
      forward_to_claude: {
        toolName: "forward_to_claude",
        eventType: "voice_instruction",
        waitFor: "claude_reply",
        textParameter: "instruction",
        defaultText: ""
      },
      request_status: {
        toolName: "request_status",
        eventType: "status_request",
        waitFor: "claude_reply"
      },
      repeat_summary: {
        toolName: "repeat_summary",
        eventType: "summary_request",
        waitFor: "claude_reply"
      },
      add_steering_note: {
        toolName: "add_steering_note",
        eventType: "steering_note",
        waitFor: "ack",
        textParameter: "note",
        defaultText: ""
      },
      interrupt_claude: {
        toolName: "interrupt_claude",
        eventType: "interrupt",
        waitFor: "claude_reply",
        textParameter: "instruction",
        defaultText: "Stop."
      }
    });
  });

  it("renders the wait-for signed-url, reply, and ack paths", () => {
    const script = renderBrowserClientModuleScript({ sessionId: "session-1", token: "token-1" });

    expect(BROWSER_CLIENT_WAIT_CONTRACT).toEqual({
      signedUrl: {
        requestType: "request_voice_signed_url",
        responseType: "voice_signed_url",
        timeoutMs: 15000
      },
      reply: {
        responseType: "claude_reply",
        timeoutMs: 300000
      },
      ack: {
        responseType: "ack",
        timeoutMs: 15000
      }
    });
    expect(script).toContain('sendDaemon({ type: waitContract.signedUrl.requestType })');
    expect(script).toContain("withTimeout(requestId, waitContract.signedUrl.responseType");
    expect(script).toContain("withTimeout(requestId, waitContract.reply.responseType");
    expect(script).toContain("withTimeout(requestId, waitContract.ack.responseType");
    expect(script).toContain("waiting.resolve(event.signedUrl)");
    expect(script).toContain("waiting.resolve(event.text)");
    expect(script).toContain("waiting.resolve(event.message)");
    expect(script).toContain('if (event.type === "error")');
    expect(script).toContain("waiting.reject(new Error(event.message))");
  });

  it("keeps background-mode Claude replies as voice session termination", () => {
    const script = renderBrowserClientModuleScript({ sessionId: "session-1", token: "token-1" });

    expect(script).toMatch(/if \(event\.backgroundMode\) \{\s+try \{ conversation\?\.endSession\?\.\(\); \} catch \{\}/);
  });

  it("delegates microphone capture to the ElevenLabs session", () => {
    const script = renderBrowserClientModuleScript({ sessionId: "session-1", token: "token-1" });

    expect(script).not.toContain("navigator.mediaDevices.getUserMedia");
    expect(script).toContain("conversation = await Conversation.startSession({");
  });

  it("renders JSON-safe session credentials and preserves expiresAt forwarding", () => {
    const sessionId = 'a</script>&"\u2028';
    const token = "tok</script><img src=x>&\u2029";
    const script = renderBrowserClientModuleScript({ sessionId, token });

    expect(readConst(script, "sessionId")).toBe(sessionId);
    expect(readConst(script, "token")).toBe(token);
    expect(script).not.toContain(sessionId);
    expect(script).not.toContain(token);
    expect(script).not.toContain("</script>");
    expect(script).toContain('const expiresAt = new URL(location.href).searchParams.get("expiresAt") || "";');
    expect(script).toContain('if (expiresAt) wsUrl.searchParams.set("expiresAt", expiresAt);');
    expect(script).toContain('wsUrl.searchParams.set("token", token);');
    expect(script).toContain('wsUrl.searchParams.set("role", "browser");');
  });

  it("renders clientTools from the exported mapping list", () => {
    const script = renderBrowserClientModuleScript({ sessionId: "session-1", token: "token-1" });

    for (const mapping of ELEVENLABS_CLIENT_TOOL_MAPPINGS) {
      expect(script).toContain(`"toolName":"${mapping.toolName}"`);
      expect(script).toContain(`"eventType":"${mapping.eventType}"`);
      expect(script).toContain(`"waitFor":"${mapping.waitFor}"`);
    }
    expect(script).toContain("clientTools: buildClientTools()");
    expect(script).toContain("mapping.waitFor === waitContract.ack.responseType");
  });
});

function readConst(script: string, name: string): unknown {
  const match = script.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!match) throw new Error(`Missing ${name} const`);
  return JSON.parse(match[1] ?? "");
}
