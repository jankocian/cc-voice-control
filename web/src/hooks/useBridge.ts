import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeEnvelope, BrowserToDaemonEvent, DaemonToBrowserEvent, SessionRuntimeState } from "../lib/protocol";
import { buildWebSocketUrl } from "../lib/session";

// Content events the bridge forwards to the app (presence + status are owned here).
export type BridgeContentEvent = Extract<
  DaemonToBrowserEvent,
  { type: "transcript" } | { type: "claude_reply" } | { type: "tts_audio" } | { type: "error" }
>;

// Everything the daemon would need a requestId for, minus the requestId itself
// (the hook mints it, exactly like the vanilla `sendDaemon`).
type DaemonCommand =
  | { type: "submit_audio"; audioBase64: string; mimeType: string; mode: "queue" | "interrupt" }
  | { type: "status_request" }
  | { type: "summary_request" }
  | { type: "stop_task" }
  | { type: "sync"; lastSeenReplyId?: string };

export type BridgeRuntime = {
  state: SessionRuntimeState;
  currentTask: string | undefined;
  listening: boolean;
};

export type UseBridgeOptions = {
  // The single capability secret from the URL path (/s/<secret>); used to build the
  // /ws/<secret>?role=browser bridge socket URL.
  secret: string;
  // Called for transcript / claude_reply / tts_audio / error events.
  onEvent: (event: BridgeContentEvent) => void;
  // The requestId of the most recent reply already shown, sent on (re)connect so
  // the daemon can replay one missed while the phone was away.
  getLastReplyId: () => string | null;
  // Fired when a daemon command can't be sent (socket gone / not ready).
  onSendFailed?: () => void;
};

export type Bridge = {
  // socket is OPEN
  connected: boolean;
  daemonConnected: boolean;
  browserConnected: boolean;
  // Epoch-ms time the daemon was last seen by the worker (null = never, or unknown
  // because the socket is currently down). Lets the UI grade "no daemon" by elapsed
  // time — a 2s reconnect vs. a session that ended overnight.
  daemonLastSeenAt: number | null;
  runtime: BridgeRuntime;
  bridgeReady: () => boolean;
  sendDaemon: (command: DaemonCommand) => boolean;
};

const RECONNECT_MS = 1500;

export function useBridge(options: UseBridgeOptions): Bridge {
  const { secret, onEvent, getLastReplyId, onSendFailed } = options;

  const [connected, setConnected] = useState(false);
  const [daemonConnected, setDaemonConnected] = useState(false);
  const [browserConnected, setBrowserConnected] = useState(false);
  // Last value carried on a bridge_presence event; reset to null on socket close so a
  // fresh connect re-derives it from the worker's storage (the DO is the source of truth).
  const [daemonLastSeenAt, setDaemonLastSeenAt] = useState<number | null>(null);
  const [runtime, setRuntime] = useState<BridgeRuntime>({
    state: "idle",
    currentTask: undefined,
    listening: true
  });

  const socketRef = useRef<WebSocket | null>(null);
  const daemonConnectedRef = useRef(false);

  // Keep the latest callbacks/values in refs so the effect mounts once.
  const onEventRef = useRef(onEvent);
  const getLastReplyIdRef = useRef(getLastReplyId);
  const onSendFailedRef = useRef(onSendFailed);
  onEventRef.current = onEvent;
  getLastReplyIdRef.current = getLastReplyId;
  onSendFailedRef.current = onSendFailed;

  const bridgeReady = useCallback((): boolean => {
    const socket = socketRef.current;
    return Boolean(socket && socket.readyState === WebSocket.OPEN && daemonConnectedRef.current);
  }, []);

  const sendDaemon = useCallback((command: DaemonCommand): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !daemonConnectedRef.current) return false;
    const requestId = crypto.randomUUID();
    const event = { requestId, ...command } as BrowserToDaemonEvent;
    try {
      socket.send(JSON.stringify({ channel: "daemon", event } satisfies BridgeEnvelope));
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let reconnectTimer = 0;

    function setDaemon(value: boolean): void {
      daemonConnectedRef.current = value;
      setDaemonConnected(value);
    }

    function handleBrowserEvent(event: DaemonToBrowserEvent | undefined): void {
      if (!event) return;
      switch (event.type) {
        case "bridge_presence": {
          const wasConnected = daemonConnectedRef.current;
          const nextDaemon = event.daemonConnected === true;
          setDaemon(nextDaemon);
          setBrowserConnected(event.browserConnected === true);
          setDaemonLastSeenAt(event.daemonLastSeenAt ?? null);
          // The daemon emits status only on change; on (re)connect ask for current
          // status and tell it the latest reply we have so it can replay a missed one.
          if (nextDaemon && !wasConnected) {
            const lastSeenReplyId = getLastReplyIdRef.current();
            const socket = socketRef.current;
            if (socket && socket.readyState === WebSocket.OPEN) {
              const requestId = crypto.randomUUID();
              const sync = lastSeenReplyId
                ? { type: "sync" as const, requestId, lastSeenReplyId }
                : { type: "sync" as const, requestId };
              try {
                socket.send(JSON.stringify({ channel: "daemon", event: sync } satisfies BridgeEnvelope));
              } catch {
                /* socket closing; ignore */
              }
            }
          }
          return;
        }
        case "session_status":
          setRuntime({
            listening: event.state.listening === true,
            state: event.state.state,
            currentTask: event.memory?.currentTask
          });
          return;
        case "transcript":
        case "claude_reply":
        case "tts_audio":
        case "error":
          onEventRef.current(event);
          return;
      }
    }

    function connect(): void {
      if (stopped) return;
      const socket = new WebSocket(buildWebSocketUrl(secret));
      socketRef.current = socket;

      socket.addEventListener("message", (messageEvent) => {
        let envelope: BridgeEnvelope | undefined;
        try {
          envelope = JSON.parse(messageEvent.data as string) as BridgeEnvelope;
        } catch {
          return;
        }
        if (envelope?.channel !== "browser") return;
        handleBrowserEvent(envelope.event);
      });

      socket.addEventListener("open", () => {
        setConnected(true);
      });

      socket.addEventListener("close", () => {
        setConnected(false);
        setDaemon(false);
        setBrowserConnected(false);
        // Drop the cached last-seen: while our own socket is down we don't know the
        // session's state. The next connect's bridge_presence re-derives it from the DO.
        setDaemonLastSeenAt(null);
        if (stopped) return;
        reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
      });

      socket.addEventListener("error", () => {
        // mirror the vanilla client: error just nudges a re-render; close handles reconnect
        setConnected(socket.readyState === WebSocket.OPEN);
      });
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      daemonConnectedRef.current = false;
      if (socket) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [secret]);

  // Surface a send-failure callback for sendControl-style flashes without
  // re-creating sendDaemon. (onSendFailed is read from the ref by callers.)
  void onSendFailedRef;

  return { connected, daemonConnected, browserConnected, daemonLastSeenAt, runtime, bridgeReady, sendDaemon };
}
