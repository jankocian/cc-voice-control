import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BridgeEnvelope,
  BrowserToDaemonEvent,
  DaemonToBrowserEvent,
  RosterEvent,
  SessionRuntimeState,
  ThreadId
} from "../lib/protocol";
import { buildWebSocketUrl } from "../lib/session";

// Content events the bridge forwards to the app, tagged with the thread they belong to.
// session_status is folded in too (it carries the per-thread runtime), so the app keeps one
// runtime map keyed by threadId instead of a special-cased presence path.
export type BridgeContentEvent = Extract<
  DaemonToBrowserEvent,
  | { type: "tts_audio" }
  | { type: "history" }
  | { type: "error" }
  | { type: "session_status" }
  | { type: "spawn_pending" }
>;

// Everything the daemon would need a requestId for, minus the requestId itself (the hook mints
// it). `get_audio` already carries its own requestId (the reply being fetched), so the hook leaves
// it untouched. `spawn_thread` carries no requestId.
export type DaemonCommand =
  | { type: "submit_audio"; audioBase64: string; mimeType: string; mode: "queue" | "interrupt" }
  | { type: "status_request" }
  | { type: "summary_request" }
  | { type: "stop_task" }
  | { type: "sync" }
  | { type: "get_audio"; requestId: string }
  | { type: "spawn_thread"; cwd?: string };

export type BridgeRuntime = {
  state: SessionRuntimeState;
  currentTask: string | undefined;
  listening: boolean;
};

export type UseBridgeOptions = {
  // The single capability secret from the URL path (/s/<secret>); used to build the
  // /ws/<secret>?role=browser bridge socket URL.
  secret: string;
  // Called for history / tts_audio / error / session_status / spawn_pending events, tagged with the
  // thread (from the envelope) so the app files each under the right thread.
  onEvent: (threadId: ThreadId, event: BridgeContentEvent) => void;
  // Called for roster snapshot + join/leave deltas so the app maintains the thread list.
  onRoster: (event: RosterEvent) => void;
};

export type Bridge = {
  // The browser's own socket is OPEN. Per-thread daemon presence lives in the roster
  // (connected/lastSeenAt) — there is no session-wide daemon flag anymore.
  connected: boolean;
  // True if a socket is OPEN and the named thread has a live daemon. Lets a command guard on
  // the thread it actually addresses (the shared mic/player act on the active thread).
  bridgeReady: (threadId: ThreadId | null) => boolean;
  // Stamp the envelope with the thread to address and send. Returns false if the socket is gone.
  sendDaemon: (threadId: ThreadId, command: DaemonCommand) => boolean;
};

const RECONNECT_MS = 1500;

export function useBridge(options: UseBridgeOptions): Bridge {
  const { secret, onEvent, onRoster } = options;

  const [connected, setConnected] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  // Live presence per thread, mirrored from the roster so sends can guard on the addressed
  // thread without a React read. `thread_joined` (connected:true) / `thread_left` flip it.
  const connectedThreadsRef = useRef<Set<ThreadId>>(new Set());

  // Keep the latest callbacks in refs so the effect mounts once (the socket lifecycle owns the
  // single connection; re-subscribing per render would tear it down on every keystroke).
  const onEventRef = useRef(onEvent);
  const onRosterRef = useRef(onRoster);
  onEventRef.current = onEvent;
  onRosterRef.current = onRoster;

  const bridgeReady = useCallback((threadId: ThreadId | null): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    return threadId !== null && connectedThreadsRef.current.has(threadId);
  }, []);

  const sendDaemon = useCallback((threadId: ThreadId, command: DaemonCommand): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (!connectedThreadsRef.current.has(threadId)) return false;
    // spawn_thread is the one daemon command without a requestId (it's an action, not a turn).
    const event = (
      command.type === "spawn_thread" ? command : { requestId: crypto.randomUUID(), ...command }
    ) as BrowserToDaemonEvent;
    try {
      socket.send(JSON.stringify({ channel: "daemon", threadId, event } satisfies BridgeEnvelope));
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let reconnectTimer = 0;

    // Track which threads have a live daemon, mirroring the roster, so sendDaemon/bridgeReady
    // can guard synchronously. A fresh connect resets it (the next thread_roster repopulates).
    function applyRosterPresence(event: RosterEvent): void {
      const set = connectedThreadsRef.current;
      if (event.type === "thread_roster") {
        set.clear();
        for (const thread of event.threads) if (thread.connected) set.add(thread.threadId);
      } else if (event.type === "thread_joined") {
        if (event.thread.connected) set.add(event.thread.threadId);
        else set.delete(event.thread.threadId);
      } else {
        set.delete(event.threadId);
      }
    }

    // On a (re)connect a freshly-present thread needs its current status + retained history; the
    // daemon emits status only on change, so the browser asks. We sync each thread that just
    // became connected (a roster snapshot may carry several; a join carries one).
    function syncThread(threadId: ThreadId): void {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const sync = { type: "sync" as const, requestId: crypto.randomUUID() };
      try {
        socket.send(JSON.stringify({ channel: "daemon", threadId, event: sync } satisfies BridgeEnvelope));
      } catch {
        /* socket closing; ignore */
      }
    }

    function handleRoster(event: RosterEvent): void {
      const before = new Set(connectedThreadsRef.current);
      applyRosterPresence(event);
      onRosterRef.current(event);
      // Sync any thread that transitioned offline→online so its history/status is restored
      // (mirrors the old single-thread reconnect path, generalized to N threads).
      for (const threadId of connectedThreadsRef.current) {
        if (!before.has(threadId)) syncThread(threadId);
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
        if (!envelope) return;
        if (envelope.channel === "roster") {
          handleRoster(envelope.event);
          return;
        }
        if (envelope.channel === "browser") {
          // Every content event is tagged with its thread; the app files it under that thread.
          onEventRef.current(envelope.threadId, envelope.event as BridgeContentEvent);
        }
      });

      socket.addEventListener("open", () => {
        setConnected(true);
      });

      socket.addEventListener("close", () => {
        setConnected(false);
        connectedThreadsRef.current.clear();
        if (stopped) return;
        reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
      });

      socket.addEventListener("error", () => {
        // mirror the vanilla client: error just nudges a re-render; close handles reconnect
        setConnected(socket.readyState === WebSocket.OPEN);
      });
    }

    // Defer the first WebSocket open until after `load`: iOS Safari counts a socket opened
    // during page load as an outstanding subresource, so the `load` event never fires and the
    // progress bar sticks ("page not loaded") — worst on a cached refresh, when React mounts
    // before load. Reconnects (post-load) go straight through the close handler.
    if (document.readyState === "complete") {
      connect();
    } else {
      window.addEventListener("load", connect, { once: true });
    }

    return () => {
      stopped = true;
      window.removeEventListener("load", connect);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      connectedThreadsRef.current.clear();
      if (socket) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [secret]);

  return { connected, bridgeReady, sendDaemon };
}
