import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";

export type ClaudeDriverEvents = {
  /** The headless session finished initializing (system/init received). */
  onReady?: (sessionId: string) => void;
  /** A text block from the assistant (may arrive in segments across a turn). */
  onAssistantText?: (text: string) => void;
  /** The assistant started using a tool — useful for a "working" indicator. */
  onToolUse?: (toolName: string) => void;
  /** A turn completed; `text` is the final assistant result for that turn. */
  onResult?: (text: string, isError: boolean) => void;
  /** A fatal driver problem (spawn failure, auth/billing error, crash). */
  onError?: (message: string) => void;
  /** The `claude` process exited. */
  onExit?: (code: number | null) => void;
};

export type ClaudeDriverOptions = {
  /** Working directory the agent operates in (the project you want to control). */
  cwd: string;
  /** "default" | "acceptEdits" | "bypassPermissions" | "plan". */
  permissionMode?: string;
  model?: string;
  appendSystemPrompt?: string;
  /** Path to the `claude` binary; defaults to "claude" on PATH. */
  binary?: string;
  events: ClaudeDriverEvents;
};

type StreamEvent = {
  type?: string;
  subtype?: string;
  result?: unknown;
  is_error?: boolean;
  error?: string;
  session_id?: string;
  message?: { content?: Array<{ type?: string; text?: string; name?: string }> };
};

/**
 * Drives a real `claude` CLI process in headless streaming-input mode. Each
 * `send()` is a genuine user turn; assistant/result events stream back. Because
 * this is the logged-in `claude` binary (not the Agent SDK), it bills against the
 * Claude Code subscription and has the full skill/subagent/hook/MCP environment.
 */
export class ClaudeDriver {
  readonly sessionId = randomUUID();
  private child?: ChildProcessWithoutNullStreams;
  private reader?: Interface;
  private stopped = false;
  private readonly options: ClaudeDriverOptions;

  constructor(options: ClaudeDriverOptions) {
    this.options = options;
  }

  start(): void {
    if (this.child) return;
    this.stopped = false;

    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--session-id",
      this.sessionId
    ];
    if (this.options.permissionMode) args.push("--permission-mode", this.options.permissionMode);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.appendSystemPrompt) args.push("--append-system-prompt", this.options.appendSystemPrompt);

    const child = spawn(this.options.binary ?? "claude", args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    this.child = child;

    child.on("error", (error) => {
      this.options.events.onError?.(
        error instanceof Error ? `Failed to launch claude: ${error.message}` : String(error)
      );
    });
    child.on("exit", (code) => {
      this.child = undefined;
      this.options.events.onExit?.(code);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) console.error(`[claude] ${text}`);
    });

    this.reader = createInterface({ input: child.stdout });
    this.reader.on("line", (line) => this.handleLine(line));
  }

  /** Send a user message as a real turn. */
  send(text: string): boolean {
    if (!this.child || this.stopped) return false;
    const message = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
    try {
      return this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      return false;
    }
  }

  /** Best-effort interrupt of the in-flight turn. */
  interrupt(): void {
    if (!this.child || this.stopped) return;
    const control = { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } };
    try {
      this.child.stdin.write(`${JSON.stringify(control)}\n`);
    } catch {
      // ignore — caller may also kill via stop()
    }
  }

  isRunning(): boolean {
    return Boolean(this.child) && !this.stopped;
  }

  stop(): void {
    this.stopped = true;
    this.reader?.close();
    this.reader = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    child.kill("SIGTERM");
  }

  private handleLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return;
    }

    switch (event.type) {
      case "system":
        if (event.subtype === "init") this.options.events.onReady?.(event.session_id ?? this.sessionId);
        if (event.subtype === "api_retry" && event.error === "billing_error") {
          this.options.events.onError?.("Claude billing/rate limit error.");
        }
        return;

      case "assistant":
        for (const block of event.message?.content ?? []) {
          if (block.type === "text" && block.text) this.options.events.onAssistantText?.(block.text);
          else if (block.type === "tool_use" && block.name) this.options.events.onToolUse?.(block.name);
        }
        return;

      case "result":
        this.options.events.onResult?.(
          typeof event.result === "string" ? event.result : "",
          event.is_error === true
        );
        return;

      default:
        return;
    }
  }
}
