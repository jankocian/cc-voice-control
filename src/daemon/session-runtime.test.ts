import { describe, expect, it } from "vitest";
import { DaemonSessionRuntime, type DaemonSessionRuntimeOptions } from "./session-runtime.js";

function createRuntime(options: Partial<DaemonSessionRuntimeOptions> = {}) {
  let now = options.createdAt ?? 1_700_000_000_000;
  return new DaemonSessionRuntime({
    sessionId: "session-1",
    createdAt: now,
    expiresAt: now + 60_000,
    now: () => ++now,
    idFactory: () => "generated-request",
    ...options
  });
}

describe("DaemonSessionRuntime", () => {
  it("queues instructions, tracks task memory, and completes the active task from a reply", async () => {
    const runtime = createRuntime();

    await runtime.handleBrowserEvent({
      type: "voice_instruction",
      requestId: "request-1",
      text: "Refactor auth middleware"
    });

    expect(runtime.getStatus()).toMatchObject({
      state: "working",
      memory: {
        currentTask: "Refactor auth middleware",
        taskHistory: [
          expect.objectContaining({
            id: "request-1",
            status: "active",
            text: "Refactor auth middleware"
          })
        ]
      }
    });
    expect(runtime.drainOutboundEvents()).toEqual([
      expect.objectContaining({ type: "session_status" }),
      { type: "ack", requestId: "request-1", message: "Sent to Claude Code." }
    ]);

    await expect(runtime.nextMessage(0)).resolves.toMatchObject({
      id: "request-1",
      kind: "instruction",
      priority: "normal",
      text: "Refactor auth middleware"
    });
    runtime.drainOutboundEvents();

    runtime.reply("Done.", {
      requestId: "request-1",
      taskState: "idle",
      summary: "Refactored auth middleware."
    });

    expect(runtime.getStatus()).toMatchObject({
      state: "idle",
      memory: {
        currentTask: undefined,
        lastResponse: "Done.",
        lastSummary: "Refactored auth middleware.",
        taskHistory: [
          expect.objectContaining({
            id: "request-1",
            status: "completed",
            summary: "Refactored auth middleware.",
            finishedAt: expect.any(Number)
          })
        ]
      }
    });
    expect(runtime.drainOutboundEvents()).toEqual([
      {
        type: "claude_reply",
        requestId: "request-1",
        text: "Done.",
        backgroundMode: undefined
      },
      expect.objectContaining({ type: "session_status" })
    ]);
  });

  it("serves known summaries immediately and otherwise queues summary and status requests", async () => {
    const runtime = createRuntime();

    await runtime.handleBrowserEvent({ type: "status_request", requestId: "status-1" });
    await runtime.handleBrowserEvent({ type: "summary_request", requestId: "summary-1" });

    await expect(runtime.nextMessage(0)).resolves.toMatchObject({
      id: "status-1",
      kind: "status_request",
      text: "User requested a status update."
    });
    await expect(runtime.nextMessage(0)).resolves.toMatchObject({
      id: "summary-1",
      kind: "summary_request",
      text: "User requested the last summary."
    });
    runtime.drainOutboundEvents();

    runtime.reply("Latest summary.", { requestId: "reply-1", summary: "Short summary." });
    runtime.drainOutboundEvents();

    await runtime.handleBrowserEvent({ type: "summary_request", requestId: "summary-2" });

    expect(runtime.drainOutboundEvents()).toEqual([
      { type: "claude_reply", requestId: "summary-2", text: "Short summary." }
    ]);
    await expect(runtime.nextMessage(0)).resolves.toBeUndefined();
  });

  it("records interrupts, prioritizes stop_task, and supports interrupt clearing", async () => {
    const runtime = createRuntime();

    await runtime.handleBrowserEvent({
      type: "voice_instruction",
      requestId: "request-1",
      text: "Ship the normal task"
    });
    await runtime.handleBrowserEvent({
      type: "interrupt",
      requestId: "interrupt-1",
      text: "pause for a second"
    });

    expect(runtime.checkInterrupt(false)).toMatchObject({
      requestId: "interrupt-1",
      text: "pause for a second",
      createdAt: expect.any(Number)
    });
    expect(runtime.checkInterrupt(true)).toMatchObject({
      requestId: "interrupt-1",
      text: "pause for a second"
    });
    expect(runtime.checkInterrupt(false)).toBeUndefined();

    await runtime.handleBrowserEvent({ type: "stop_task", requestId: "stop-1" });

    expect(runtime.checkInterrupt(false)).toMatchObject({
      requestId: "stop-1",
      text: "Stop the active task."
    });
    await expect(runtime.nextMessage(0)).resolves.toMatchObject({
      id: "stop-1",
      kind: "interrupt",
      priority: "high",
      text: "Stop the active task."
    });
    await expect(runtime.nextMessage(0)).resolves.toMatchObject({
      id: "request-1",
      kind: "instruction",
      priority: "normal",
      text: "Ship the normal task"
    });
  });

  it("treats interrupt-like voice instructions as high-priority interrupts", async () => {
    const runtime = createRuntime();

    await runtime.handleBrowserEvent({
      type: "voice_instruction",
      requestId: "request-2",
      text: "wait, stop what you are doing"
    });

    expect(runtime.getStatus().state).toBe("paused_for_user");
    expect(runtime.checkInterrupt(false)).toMatchObject({
      requestId: "request-2",
      text: "wait, stop what you are doing",
      createdAt: expect.any(Number)
    });
    await expect(runtime.nextMessage(0)).resolves.toMatchObject({
      id: "request-2",
      kind: "interrupt",
      priority: "high",
      text: "wait, stop what you are doing"
    });
    expect(runtime.checkInterrupt(false)).toBeUndefined();
  });

  it("lets active work service status controls without consuming queued instructions", async () => {
    const runtime = createRuntime();

    await runtime.handleBrowserEvent({
      type: "voice_instruction",
      requestId: "request-1",
      text: "Keep working on the implementation"
    });
    await runtime.handleBrowserEvent({ type: "status_request", requestId: "status-1" });
    await runtime.handleBrowserEvent({
      type: "voice_instruction",
      requestId: "request-2",
      text: "Queue the follow-up task"
    });

    expect(runtime.getMemory().taskHistory).toEqual([
      expect.objectContaining({ id: "request-1", status: "active" }),
      expect.objectContaining({ id: "request-2", status: "pending" })
    ]);
    expect(runtime.drainOutboundEvents()).toContainEqual({
      type: "claude_reply",
      requestId: "request-2",
      text: "Queued after the current task."
    });

    expect(runtime.checkControlMessage(false)).toMatchObject({
      id: "status-1",
      kind: "status_request",
      text: "User requested a status update."
    });
    expect(runtime.checkControlMessage(true)).toMatchObject({
      id: "status-1",
      kind: "status_request"
    });
    expect(runtime.checkControlMessage(false)).toBeUndefined();

    await expect(runtime.nextMessage(0)).resolves.toMatchObject({
      id: "request-1",
      kind: "instruction",
      text: "Keep working on the implementation"
    });
    await expect(runtime.nextMessage(0)).resolves.toMatchObject({
      id: "request-2",
      kind: "instruction",
      text: "Queue the follow-up task"
    });
  });

  it("stores steering notes and clears them through the public note API", async () => {
    const runtime = createRuntime();

    await runtime.handleBrowserEvent({ type: "steering_note", requestId: "note-1", text: "Keep the patch small." });
    await runtime.handleBrowserEvent({ type: "steering_note", requestId: "note-2", text: "Avoid worker edits." });

    expect(runtime.getSteeringNotes(false)).toEqual(["Keep the patch small.", "Avoid worker edits."]);
    expect(runtime.getMemory().steeringNotes).toEqual(["Keep the patch small.", "Avoid worker edits."]);
    expect(runtime.getSteeringNotes(true)).toEqual(["Keep the patch small.", "Avoid worker edits."]);
    expect(runtime.getMemory().steeringNotes).toEqual([]);
    expect(runtime.drainOutboundEvents()).toContainEqual(
      expect.objectContaining({
        type: "session_status",
        memory: expect.objectContaining({ steeringNotes: [] })
      })
    );
  });

  it("resolves waiting message pollers on enqueue and stop", async () => {
    const runtime = createRuntime();

    const next = runtime.nextMessage(1000);
    await runtime.handleBrowserEvent({
      type: "voice_instruction",
      requestId: "request-1",
      text: "Answer the waiting poll"
    });
    await expect(next).resolves.toMatchObject({
      id: "request-1",
      kind: "instruction",
      text: "Answer the waiting poll"
    });

    const stopped = runtime.nextMessage(1000);
    runtime.stop();

    await expect(stopped).resolves.toBeUndefined();
    expect(runtime.getStatus().state).toBe("stopping");
    await expect(runtime.nextMessage(0)).resolves.toBeUndefined();
  });

  it("uses an injected provider for voice signed URL requests", async () => {
    const runtime = createRuntime({
      voiceSignedUrlProvider: () => "wss://voice.example.com/signed"
    });

    await runtime.handleBrowserEvent({
      type: "request_voice_signed_url",
      requestId: "voice-url-1"
    });

    expect(runtime.getStatus()).toMatchObject({
      state: "voice_connected",
      browserConnected: true
    });
    expect(runtime.drainOutboundEvents()).toEqual([
      {
        type: "voice_signed_url",
        requestId: "voice-url-1",
        signedUrl: "wss://voice.example.com/signed"
      },
      expect.objectContaining({ type: "session_status" })
    ]);
  });
});
