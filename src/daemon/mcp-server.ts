#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, stateDir } from "./config.js";
import { reconcile } from "./reconcile.js";
import { createDaemonInit, VoiceDaemon } from "./voice-daemon.js";

/**
 * Plugin MCP server that hosts the voice-remote daemon.
 *
 * Why an MCP server: Claude Code spawns it as a CHILD of the Claude process, so
 * it stays inside cmux's process tree and keeps the socket trust needed to type
 * into the pane. (A `nohup &` daemon is reparented to launchd and cmux rejects
 * it.) Claude never calls any tool here — the server is purely a lineage-
 * preserving background host. `/voice-control:start` activates it by creating a
 * flag file; `/voice-control:stop` removes it.
 *
 * stdout is the MCP JSON-RPC channel and MUST stay clean — route every log to
 * stderr (including any stray console.log from dependencies).
 */
console.log = (...args: unknown[]) => console.error(...args);

const ACTIVE_FLAG = join(stateDir(), "active");

let daemon: VoiceDaemon | undefined;
let activating = false;

async function activate(): Promise<void> {
  if (daemon || activating) return;
  activating = true;
  try {
    const config = await loadConfig();
    const next = new VoiceDaemon(createDaemonInit(config));
    await next.start();
    daemon = next;
    console.error("[mcp] voice remote activated");
  } catch (error) {
    console.error(`[mcp] activation failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    activating = false;
  }
}

function deactivate(): void {
  if (!daemon) return;
  daemon.stop();
  daemon = undefined;
  console.error("[mcp] voice remote deactivated");
}

async function pollFlag(): Promise<void> {
  try {
    await reconcile({
      flagPresent: existsSync(ACTIVE_FLAG),
      hasDaemon: daemon !== undefined,
      activate,
      ensureRuntime: () => daemon?.ensureRuntimePublished(),
      deactivate
    });
  } catch (error) {
    console.error(`[mcp] flag poll error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- minimal MCP stdio (JSON-RPC, newline-delimited) ------------------------

function reply(id: unknown, result: unknown): void {
  if (id === undefined || id === null) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function handle(msg: { id?: unknown; method?: string; params?: { protocolVersion?: string } }): void {
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "voice-control", version: "1.0.0" }
      });
      return;
    case "tools/list":
      reply(msg.id, { tools: [] });
      return;
    case "ping":
      reply(msg.id, {});
      return;
    default:
      // Other requests get a benign ack; notifications (no id) are ignored.
      if (msg.id !== undefined && msg.id !== null && msg.method) reply(msg.id, {});
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\n");
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore non-JSON lines
    }
  }
});
process.stdin.on("end", () => shutdown());

function shutdown(): void {
  deactivate();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

mkdirSync(stateDir(), { recursive: true });
setInterval(() => void pollFlag(), 1000);
void pollFlag();
console.error("[mcp] voice-control server up; waiting for /voice-control:start");
