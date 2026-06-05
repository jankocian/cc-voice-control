import type { BrowserToDaemonEvent, DaemonToBrowserEvent } from "../../src/shared/protocol";

export type BrowserClientScriptInput = {
  sessionId: string;
  token: string;
};

type ToolDaemonEventType = Extract<
  BrowserToDaemonEvent["type"],
  "voice_instruction" | "status_request" | "summary_request" | "steering_note" | "interrupt"
>;
type BrowserWaitEventType = Extract<DaemonToBrowserEvent["type"], "voice_signed_url" | "claude_reply" | "ack">;
type ClientToolWaitFor = Extract<BrowserWaitEventType, "claude_reply" | "ack">;

export type ElevenLabsClientToolMapping = {
  toolName: string;
  eventType: ToolDaemonEventType;
  waitFor: ClientToolWaitFor;
  textParameter?: string;
  defaultText?: string;
};

export const ELEVENLABS_CLIENT_TOOL_MAPPINGS = [
  {
    toolName: "forward_to_claude",
    eventType: "voice_instruction",
    waitFor: "claude_reply",
    textParameter: "instruction",
    defaultText: ""
  },
  {
    toolName: "request_status",
    eventType: "status_request",
    waitFor: "claude_reply"
  },
  {
    toolName: "repeat_summary",
    eventType: "summary_request",
    waitFor: "claude_reply"
  },
  {
    toolName: "add_steering_note",
    eventType: "steering_note",
    waitFor: "ack",
    textParameter: "note",
    defaultText: ""
  },
  {
    toolName: "interrupt_claude",
    eventType: "interrupt",
    waitFor: "claude_reply",
    textParameter: "instruction",
    defaultText: "Stop."
  }
] as const satisfies readonly ElevenLabsClientToolMapping[];

export const BROWSER_CLIENT_WAIT_CONTRACT = {
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
} as const satisfies {
  signedUrl: {
    requestType: Extract<BrowserToDaemonEvent["type"], "request_voice_signed_url">;
    responseType: Extract<BrowserWaitEventType, "voice_signed_url">;
    timeoutMs: number;
  };
  reply: {
    responseType: Extract<BrowserWaitEventType, "claude_reply">;
    timeoutMs: number;
  };
  ack: {
    responseType: Extract<BrowserWaitEventType, "ack">;
    timeoutMs: number;
  };
};

export function renderBrowserClientModuleScript({ sessionId, token }: BrowserClientScriptInput): string {
  return String.raw`
    const { Conversation } = window.ElevenLabsClient;

    const sessionId = ${toInlineJson(sessionId)};
    const token = ${toInlineJson(token)};
    const expiresAt = new URL(location.href).searchParams.get("expiresAt") || "";
    const clientToolMappings = ${toInlineJson(ELEVENLABS_CLIENT_TOOL_MAPPINGS)};
    const waitContract = ${toInlineJson(BROWSER_CLIENT_WAIT_CONTRACT)};
    const wsUrl = new URL("/ws/" + encodeURIComponent(sessionId), location.href);
    wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.searchParams.set("token", token);
    wsUrl.searchParams.set("role", "browser");
    if (expiresAt) wsUrl.searchParams.set("expiresAt", expiresAt);

    let socket;
    let conversation;
    let currentState;
    let startedAt = Date.now();
    let voiceStarting = false;
    const pending = new Map();

    const el = {
      lamp: document.getElementById("lamp"),
      state: document.getElementById("stateLabel"),
      detail: document.getElementById("detailLabel"),
      elapsed: document.getElementById("elapsed"),
      log: document.getElementById("log"),
      voiceButton: document.getElementById("voiceButton"),
      summaryButton: document.getElementById("summaryButton"),
      statusButton: document.getElementById("statusButton"),
      stopButton: document.getElementById("stopButton")
    };

    updateControls();
    connectBridge();
    setInterval(updateElapsed, 1000);

    el.voiceButton.addEventListener("click", reconnectVoice);
    el.summaryButton.addEventListener("click", () => sendDaemonSafely({ type: "summary_request" }));
    el.statusButton.addEventListener("click", () => sendDaemonSafely({ type: "status_request" }));
    el.stopButton.addEventListener("click", () => sendDaemonSafely({ type: "stop_task" }));

    function connectBridge() {
      currentState = undefined;
      updateControls();
      socket = new WebSocket(wsUrl);
      socket.addEventListener("open", () => {
        setVisualState("voice_suspended", "Bridge connected", "Checking daemon");
        updateControls();
        addLog("Bridge", "Connected to Claude Code bridge.");
      });
      socket.addEventListener("message", (event) => {
        const envelope = JSON.parse(event.data);
        if (envelope.channel !== "browser") return;
        handleBrowserEvent(envelope.event);
      });
      socket.addEventListener("close", () => {
        setVisualState("voice_suspended", "Bridge disconnected", "Reconnecting");
        rejectPending(new Error("Bridge disconnected"));
        updateControls();
        setTimeout(connectBridge, 1500);
      });
      socket.addEventListener("error", () => {
        setVisualState("voice_suspended", "Bridge unavailable", "Reconnecting");
        updateControls();
      });
    }

    async function reconnectVoice() {
      voiceStarting = true;
      updateControls();
      try {
        await conversation?.endSession?.();
      } catch {}
      try {
        const signedUrl = await requestSignedUrl();
        conversation = await Conversation.startSession({
          signedUrl,
          connectionType: "websocket",
          clientTools: buildClientTools(),
          onConnect: () => {
            setVisualState("voice_connected", "Voice connected", "Listening");
            addLog("Voice", "Conversation connected.");
          },
          onDisconnect: () => {
            setVisualState("voice_suspended", "Voice suspended", "Session still active");
            addLog("Voice", "Conversation ended.");
          },
          onMessage: (message) => {
            if (message?.source === "user" && message.message) {
              addLog("You", message.message);
            }
          },
          onError: (error) => addLog("Voice error", String(error))
        });
      } catch (error) {
        setVisualState("voice_suspended", "Voice unavailable", "Tap reconnect to retry");
        addLog("Voice error", error instanceof Error ? error.message : String(error));
      } finally {
        voiceStarting = false;
        updateControls();
      }
    }

    function buildClientTools() {
      return Object.fromEntries(clientToolMappings.map((mapping) => [
        mapping.toolName,
        async (parameters = {}) => {
          const event = { type: mapping.eventType };
          if (mapping.textParameter) {
            event.text = String(parameters?.[mapping.textParameter] || mapping.defaultText || "");
          }
          if (mapping.waitFor === waitContract.ack.responseType) {
            return sendDaemonAndWaitForAck(event);
          }
          return sendDaemonAndWaitForReply(event);
        }
      ]));
    }

    function requestSignedUrl() {
      return new Promise((resolve, reject) => {
        const requestId = sendDaemon({ type: waitContract.signedUrl.requestType });
        pending.set(
          requestId,
          withTimeout(requestId, waitContract.signedUrl.responseType, resolve, reject, waitContract.signedUrl.timeoutMs)
        );
      });
    }

    function sendDaemonAndWaitForReply(event) {
      return new Promise((resolve, reject) => {
        const requestId = sendDaemon(event);
        pending.set(
          requestId,
          withTimeout(requestId, waitContract.reply.responseType, resolve, reject, waitContract.reply.timeoutMs)
        );
      });
    }

    function sendDaemonAndWaitForAck(event) {
      return new Promise((resolve, reject) => {
        const requestId = sendDaemon(event);
        pending.set(
          requestId,
          withTimeout(requestId, waitContract.ack.responseType, resolve, reject, waitContract.ack.timeoutMs)
        );
      });
    }

    function withTimeout(requestId, type, resolve, reject, timeoutMs) {
      return {
        type,
        resolve,
        reject,
        timeout: setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId);
            reject(new Error("Timed out waiting for " + type));
          }
        }, timeoutMs)
      };
    }

    function sendDaemon(event) {
      if (!isBridgeOpen()) {
        throw new Error("Bridge is not connected.");
      }
      if (currentState?.daemonConnected !== true) {
        throw new Error("Claude Code daemon is not connected.");
      }
      const requestId = crypto.randomUUID();
      socket.send(JSON.stringify({
        channel: "daemon",
        event: { requestId, ...event }
      }));
      return requestId;
    }

    function sendDaemonSafely(event) {
      try {
        sendDaemon(event);
      } catch (error) {
        const daemonMissing = isBridgeOpen() && currentState?.daemonConnected !== true;
        setVisualState(
          "voice_suspended",
          daemonMissing ? "Daemon disconnected" : "Bridge reconnecting",
          daemonMissing ? "Waiting for Claude Code" : "Try again shortly"
        );
        addLog("Bridge", error instanceof Error ? error.message : String(error));
        updateControls();
      }
    }

    function isBridgeOpen() {
      return socket?.readyState === WebSocket.OPEN;
    }

    function updateControls() {
      const ready = isBridgeOpen() && currentState?.daemonConnected === true;
      el.voiceButton.disabled = !ready || voiceStarting;
      el.summaryButton.disabled = !ready;
      el.statusButton.disabled = !ready;
      el.stopButton.disabled = !ready;
    }

    function rejectPending(error) {
      for (const [requestId, waiting] of pending) {
        clearTimeout(waiting.timeout);
        waiting.reject(error);
        pending.delete(requestId);
      }
    }

    function handleBrowserEvent(event) {
      if (event.type === waitContract.signedUrl.responseType) {
        const waiting = pending.get(event.requestId);
        if (waiting?.type === waitContract.signedUrl.responseType) {
          clearTimeout(waiting.timeout);
          pending.delete(event.requestId);
          waiting.resolve(event.signedUrl);
        }
        return;
      }

      if (event.type === "session_status") {
        const daemonWasConnected = currentState?.daemonConnected === true;
        currentState = event.state;
        startedAt = event.state.createdAt || startedAt;
        setVisualState(event.state.state, labelFor(event.state.state), statusDetail(event));
        if (daemonWasConnected && !event.state.daemonConnected) {
          rejectPending(new Error("Claude Code daemon disconnected"));
        }
        updateControls();
        return;
      }

      if (event.type === waitContract.reply.responseType) {
        addLog("Claude Code", event.text);
        const waiting = pending.get(event.requestId);
        if (waiting?.type === waitContract.reply.responseType) {
          clearTimeout(waiting.timeout);
          pending.delete(event.requestId);
          waiting.resolve(event.text);
        }
        if (event.backgroundMode) {
          try { conversation?.endSession?.(); } catch {}
        }
        return;
      }

      if (event.type === waitContract.ack.responseType) {
        addLog("Bridge", event.message);
        const waiting = pending.get(event.requestId);
        if (waiting?.type === waitContract.ack.responseType) {
          clearTimeout(waiting.timeout);
          pending.delete(event.requestId);
          waiting.resolve(event.message);
        }
        return;
      }

      if (event.type === "error") {
        addLog("Error", event.message);
        const waiting = pending.get(event.requestId);
        if (waiting) {
          clearTimeout(waiting.timeout);
          pending.delete(event.requestId);
          waiting.reject(new Error(event.message));
        }
      }
    }

    function setVisualState(state, title, detail) {
      el.state.textContent = title;
      el.detail.textContent = detail;
      el.lamp.className = "lamp" + (state === "voice_connected" ? " connected" : state === "working" ? " working" : "");
    }

    function labelFor(state) {
      return ({
        idle: "Ready",
        working: "Claude is working",
        voice_connected: "Voice connected",
        voice_suspended: "Voice suspended",
        paused_for_user: "Paused for user",
        stopping: "Stopping"
      })[state] || state;
    }

    function statusDetail(event) {
      if (event.memory?.currentTask) return event.memory.currentTask;
      return event.state.daemonConnected ? "Daemon connected" : "Waiting for daemon";
    }

    function updateElapsed() {
      const ms = Date.now() - (currentState?.createdAt || startedAt);
      const total = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = String(total % 60).padStart(2, "0");
      el.elapsed.textContent = minutes + "m " + seconds + "s";
    }

    function addLog(title, body) {
      const row = document.createElement("article");
      row.className = "entry";
      row.innerHTML = "<time>" + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " &middot; " + escapeHtml(title) + "</time><p>" + escapeHtml(body) + "</p>";
      el.log.prepend(row);
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[char]);
    }
  `.trim();
}

function toInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
