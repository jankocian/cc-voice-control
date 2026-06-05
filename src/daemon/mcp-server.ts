#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { VoiceRemoteManager } from "./session.js";

const manager = new VoiceRemoteManager();

const server = new McpServer({
  name: "voice-command",
  version: "1.0.0"
});

server.registerTool(
  "voice_remote_start",
  {
    title: "Start voice remote session",
    description: "Start or return the active phone voice remote session.",
    outputSchema: {
      sessionId: z.string(),
      url: z.string(),
      expiresAt: z.string()
    }
  },
  async () => {
    const config = await loadConfig();
    const session = await manager.start(config);
    const structuredContent = {
      sessionId: session.sessionId,
      url: session.browserUrl,
      expiresAt: new Date(session.expiresAt).toISOString()
    };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent
    };
  }
);

server.registerTool(
  "voice_remote_stop",
  {
    title: "Stop voice remote session",
    description: "Terminate the active voice remote session.",
    outputSchema: {
      stopped: z.boolean()
    }
  },
  async () => {
    const structuredContent = { stopped: manager.stop() };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent
    };
  }
);

server.registerTool(
  "voice_remote_status",
  {
    title: "Voice remote status",
    description: "Return the active voice remote session status and memory.",
    outputSchema: {
      active: z.boolean(),
      status: z.unknown().optional()
    }
  },
  async () => {
    const session = manager.current();
    const structuredContent = {
      active: Boolean(session),
      status: session?.getStatus()
    };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent
    };
  }
);

server.registerTool(
  "voice_next_message",
  {
    title: "Wait for next voice message",
    description: "Blocking queue retrieval for the next instruction or control message from the phone.",
    inputSchema: {
      timeoutMs: z.number().int().min(1000).max(300000).default(300000)
    },
    outputSchema: {
      message: z.unknown().optional()
    }
  },
  async ({ timeoutMs }) => {
    const session = manager.current();
    const message = await session?.nextMessage(timeoutMs);
    const structuredContent = { message };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent
    };
  }
);

server.registerTool(
  "voice_reply",
  {
    title: "Send Claude reply to voice remote",
    description: "Send Claude Code's response to the phone UI and voice layer.",
    inputSchema: {
      requestId: z.string().optional(),
      text: z.string().min(1),
      summary: z.string().optional(),
      backgroundMode: z.boolean().default(false),
      taskState: z.enum(["idle", "working", "voice_connected", "voice_suspended", "paused_for_user", "stopping"]).optional()
    },
    outputSchema: {
      delivered: z.boolean()
    }
  },
  async ({ requestId, text, summary, backgroundMode, taskState }) => {
    const session = manager.current();
    const delivered = session?.reply(text, { requestId, summary, backgroundMode, taskState }) ?? false;
    const structuredContent = { delivered };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent
    };
  }
);

server.registerTool(
  "voice_get_steering_notes",
  {
    title: "Get steering notes",
    description: "Return active steering notes collected while Claude Code is working.",
    inputSchema: {
      clear: z.boolean().default(false)
    },
    outputSchema: {
      notes: z.array(z.string())
    }
  },
  async ({ clear }) => {
    const notes = manager.current()?.getSteeringNotes(clear) ?? [];
    const structuredContent = { notes };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent
    };
  }
);

server.registerTool(
  "voice_check_control_message",
  {
    title: "Check control message",
    description: "Return status or summary requests collected while Claude Code is working.",
    inputSchema: {
      clear: z.boolean().default(true)
    },
    outputSchema: {
      message: z.unknown().optional()
    }
  },
  async ({ clear }) => {
    const message = manager.current()?.checkControlMessage(clear);
    const structuredContent = { message };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent
    };
  }
);

server.registerTool(
  "voice_check_interrupt",
  {
    title: "Check interrupt",
    description: "Return high-priority user interrupts such as stop, cancel, wait, or do not do that.",
    inputSchema: {
      clear: z.boolean().default(true)
    },
    outputSchema: {
      interrupted: z.boolean(),
      requestId: z.string().optional(),
      text: z.string().optional(),
      createdAt: z.number().optional()
    }
  },
  async ({ clear }) => {
    const interrupt = manager.current()?.checkInterrupt(clear);
    const structuredContent = {
      interrupted: Boolean(interrupt),
      requestId: interrupt?.requestId,
      text: interrupt?.text,
      createdAt: interrupt?.createdAt
    };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("voice-command MCP server running on stdio");
