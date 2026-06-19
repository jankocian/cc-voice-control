import { describe, expect, it } from "vitest";
import { renderBrowserClientModuleScript } from "./browser-client.js";

describe("push-to-talk browser client", () => {
  const script = renderBrowserClientModuleScript({ sessionId: "session-1", token: "token-1" });

  it("records audio and sends it to the daemon for transcription", () => {
    expect(script).toContain("navigator.mediaDevices.getUserMedia({ audio: true })");
    expect(script).toContain("new MediaRecorder(");
    expect(script).toContain('sendDaemon({ type: "submit_audio", audioBase64, mimeType })');
    expect(script).toContain('case "transcript":');
    expect(script).toContain('addLog("You", event.text)');
  });

  it("shows a live audio-reactive visualizer while recording", () => {
    expect(script).toContain("createAnalyser()");
    expect(script).toContain("getByteFrequencyData(freqData)");
    expect(script).toContain("requestAnimationFrame(drawWave)");
    expect(script).toContain("roundRect(");
  });

  it("auto-plays replies and lets any message be replayed by tapping it", () => {
    expect(script).toContain('case "claude_reply":');
    expect(script).toContain('case "tts_audio":');
    expect(script).toContain("function attachAudio(requestId, audioBase64, mimeType)");
    expect(script).toContain("if (!recording) playEntry(requestId)");
    expect(script).toContain('entry.classList.add("playable")');
    expect(script).toContain("setPlayingClass(currentPlayingId");
    expect(script).toContain("function blobFromBase64(base64, mimeType)");
  });

  it("controls playback speed and persists it", () => {
    expect(script).toContain("function cycleSpeed()");
    expect(script).toContain("player.playbackRate = playbackRate");
    expect(script).toContain("localStorage.setItem(RATE_KEY, String(playbackRate))");
  });

  it("keeps the activity log clean — only the user transcript and Claude's real reply are logged", () => {
    expect(script).toContain('addLog("You", event.text)');
    expect(script).toContain('addLog("Claude Code", event.text, event.requestId)');
    expect(script).not.toContain("Queued after the current task");
    expect(script).not.toContain("Connected to Claude Code bridge");
  });

  it("reacts to bridge presence and rich daemon status", () => {
    expect(script).toContain('case "bridge_presence":');
    expect(script).toContain('case "session_status":');
    expect(script).toContain("runtime.currentTask = event.memory && event.memory.currentTask");
  });

  it("wires the control buttons to daemon control events", () => {
    expect(script).toContain('sendControl({ type: "summary_request" })');
    expect(script).toContain('sendControl({ type: "status_request" })');
    expect(script).toContain('sendControl({ type: "stop_task" })');
  });

  it("runs no third-party voice SDK in the browser", () => {
    expect(script).not.toContain("ElevenLabsClient");
    expect(script).not.toContain("Conversation.startSession");
    expect(script).not.toContain("clientTools");
  });

  it("renders JSON-safe session credentials and forwards expiresAt", () => {
    const sessionId = 'a</script>&"x';
    const token = "tok</script><img src=x>&y";
    const tainted = renderBrowserClientModuleScript({ sessionId, token });

    expect(readConst(tainted, "sessionId")).toBe(sessionId);
    expect(readConst(tainted, "token")).toBe(token);
    expect(tainted).not.toContain("</script>");
    expect(tainted).toContain('const expiresAt = new URL(location.href).searchParams.get("expiresAt") || "";');
    expect(tainted).toContain('if (expiresAt) wsUrl.searchParams.set("expiresAt", expiresAt);');
    expect(tainted).toContain('wsUrl.searchParams.set("token", token);');
    expect(tainted).toContain('wsUrl.searchParams.set("role", "browser");');
  });
});

function readConst(script: string, name: string): unknown {
  const match = script.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!match) throw new Error(`Missing ${name} const`);
  return JSON.parse(match[1] ?? "");
}
