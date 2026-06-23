import { useCallback, useEffect, useRef, useState } from "react";
import { createSerializer } from "../../../src/shared/serialize";
import { aad, openJson, sealJson } from "../lib/e2e";
import type {
  BridgeEnvelope,
  BrowserToDaemonEvent,
  DaemonToBrowserEvent,
  RosterEvent,
  RosterThread,
  SessionRuntimeState,
  SpeakMode,
  ThreadId,
  ThreadLabel,
  WireRosterEvent,
  WireRosterThread
} from "../lib/protocol";
import { buildWebSocketUrl, claimSession } from "../lib/session";

// Content events the bridge forwards to the app, tagged with the thread they belong to.
// session_status is folded in too (it carries the per-thread runtime), so the app keeps one
// runtime map keyed by threadId instead of a special-cased presence path.
export type BridgeContentEvent = Extract<
  DaemonToBrowserEvent,
  | { type: "tts_audio" }
  | { type: "tts_status" }
  | { type: "history" }
  | { type: "prompt_status" }
  | { type: "error" }
  | { type: "session_status" }
  | { type: "spawn_pending" }
>;

// Everything the daemon would need a requestId for, minus the requestId itself (the hook mints
// it). `get_audio` already carries its own requestId (the reply being fetched), so the hook leaves
// it untouched. `spawn_thread` and `set_speak_mode` carry no requestId.
export type DaemonCommand =
  | { type: "submit_audio"; audioBase64: string; mimeType: string; mode: "queue" | "interrupt" }
  | { type: "status_request" }
  | { type: "summary_request" }
  | { type: "stop_task" }
  | { type: "sync" }
  | { type: "get_audio"; requestId: string }
  | { type: "set_speak_mode"; mode: SpeakMode }
  | { type: "spawn_thread"; cwd?: string };

export type BridgeRuntime = {
  state: SessionRuntimeState;
  currentTask: string | undefined;
  listening: boolean;
};

export type UseBridgeOptions = {
  // The session handle (from the URL path); used to build the /ws/<sessionId>?role=browser bridge
  // socket URL and to claim the device cookie before connecting.
  sessionId: string;
  // The end-to-end key (derived from the secret). Every content event is sealed/opened with it; the
  // worker never has it, so it relays only ciphertext.
  key: CryptoKey;
  // Called for history / tts_audio / error / session_status / spawn_pending events, tagged with the
  // thread (from the envelope) so the app files each under the right thread.
  onEvent: (threadId: ThreadId, event: BridgeContentEvent) => void;
  // Called for roster snapshot + join/leave deltas so the app maintains the thread list.
  onRoster: (event: RosterEvent) => void;
  // Called when /claim → 403 after retries: `stale` = a cookie was present but the session no longer
  // knows it (re-pair), `expired` = a fresh/used one-time link. The app shows the right re-pair screen;
  // reconnecting is stopped (a leaked URL can't loop its way in).
  onExpired: (reason: "stale" | "expired") => void;
};

export type Bridge = {
  // The browser's own socket is OPEN. Per-thread daemon presence lives in the roster
  // (connected/lastSeenAt) — there is no session-wide daemon flag anymore.
  connected: boolean;
  // True if a socket is OPEN and the named thread has a live daemon. Lets a command guard on
  // the thread it actually addresses (the shared mic/player act on the active thread).
  bridgeReady: (threadId: ThreadId | null) => boolean;
  // Stamp the envelope with the thread to address, seal it, and send. Returns false if the socket is
  // gone or the thread is offline (the actual encrypt+send completes asynchronously, in order).
  sendDaemon: (threadId: ThreadId, command: DaemonCommand) => boolean;
};

const RECONNECT_MS = 1500;
// A fresh /voice-control:start opens the pairing window a moment after the daemon connects; the phone
// may POST /claim in the brief gap before the window is live and get a 403. Retry a few times before
// declaring the link expired, so the happy path isn't a false "re-pair". A genuinely closed window just
// means the re-pair screen shows after ~this many × RECONNECT_MS.
const MAX_CLAIM_RETRIES = 4;

// Decrypt the sealed label on each roster thread back into a displayable ThreadLabel. A label that
// won't open (a forged/foreign roster, or a scheme mismatch) degrades to the threadId rather than
// dropping the thread, so the switcher still shows it.
async function openRosterThread(key: CryptoKey, thread: WireRosterThread): Promise<RosterThread> {
  let label: ThreadLabel;
  try {
    label = await openJson<ThreadLabel>(key, thread.label, aad("label", thread.threadId));
  } catch {
    label = { title: thread.threadId };
  }
  return { ...thread, label };
}

async function openRosterEvent(key: CryptoKey, event: WireRosterEvent): Promise<RosterEvent> {
  if (event.type === "thread_roster") {
    return { type: "thread_roster", threads: await Promise.all(event.threads.map((t) => openRosterThread(key, t))) };
  }
  if (event.type === "thread_joined") {
    return { type: "thread_joined", thread: await openRosterThread(key, event.thread) };
  }
  return event; // thread_left carries no label
}

export function useBridge(options: UseBridgeOptions): Bridge {
  const { sessionId, key, onEvent, onRoster, onExpired } = options;

  const [connected, setConnected] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  // Live presence per thread, mirrored from the roster so sends can guard on the addressed
  // thread without a React read. `thread_joined` (connected:true) / `thread_left` flip it.
  const connectedThreadsRef = useRef<Set<ThreadId>>(new Set());
  // Serialize outbound seals so commands keep their order on the wire (an interrupt must not overtake
  // the submit it follows).
  const enqueueSendRef = useRef(createSerializer());

  // Keep the latest callbacks + key in refs so the effect mounts once (the socket lifecycle owns the
  // single connection; re-subscribing per render would tear it down on every keystroke). The key is
  // stable for a session, but a ref keeps the effect deps minimal.
  const onEventRef = useRef(onEvent);
  const onRosterRef = useRef(onRoster);
  const onExpiredRef = useRef(onExpired);
  const keyRef = useRef(key);
  onEventRef.current = onEvent;
  onRosterRef.current = onRoster;
  onExpiredRef.current = onExpired;
  keyRef.current = key;

  const bridgeReady = useCallback((threadId: ThreadId | null): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    return threadId !== null && connectedThreadsRef.current.has(threadId);
  }, []);

  // Seal an event for one thread's daemon and send it, chained so order is preserved. Re-checks the
  // socket after the (async) seal in case it closed meanwhile.
  const enqueueDaemonSend = useCallback((threadId: ThreadId, event: BrowserToDaemonEvent): void => {
    enqueueSendRef.current(async () => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const enc = await sealJson(keyRef.current, event, aad("daemon", threadId));
      // Re-check after the (async) seal in case the socket closed meanwhile.
      if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ channel: "daemon", threadId, enc } satisfies BridgeEnvelope));
      }
    });
  }, []);

  const sendDaemon = useCallback(
    (threadId: ThreadId, command: DaemonCommand): boolean => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      if (!connectedThreadsRef.current.has(threadId)) return false;
      // spawn_thread + set_speak_mode are actions/settings, not turns — they carry no requestId.
      const event = (
        command.type === "spawn_thread" || command.type === "set_speak_mode"
          ? command
          : { requestId: crypto.randomUUID(), ...command }
      ) as BrowserToDaemonEvent;
      enqueueDaemonSend(threadId, event);
      return true;
    },
    [enqueueDaemonSend]
  );

  useEffect(() => {
    let stopped = false;
    let reconnectTimer = 0;
    // Consecutive 403s from /claim; reset on any successful claim. Distinguishes the brief start-up race
    // (retry) from a truly closed pairing window (give up → re-pair screen).
    let expiredStreak = 0;
    // Serialize inbound decrypts so events apply in arrival order (a history snapshot must not be
    // overtaken by an earlier one whose decrypt finished later).
    const enqueueRecv = createSerializer();

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
      enqueueDaemonSend(threadId, { type: "sync", requestId: crypto.randomUUID() });
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

    // Open the sealed envelope and dispatch it. Roster labels and content are both decrypted with the
    // session key; a decryption failure means tampered/foreign data and is dropped by the caller.
    async function handleEnvelope(envelope: BridgeEnvelope): Promise<void> {
      if (envelope.channel === "roster") {
        handleRoster(await openRosterEvent(keyRef.current, envelope.event));
        return;
      }
      if (envelope.channel === "browser") {
        const event = await openJson<DaemonToBrowserEvent>(
          keyRef.current,
          envelope.enc,
          aad("browser", envelope.threadId)
        );
        onEventRef.current(envelope.threadId, event as BridgeContentEvent);
      }
    }

    // Claim/refresh the device cookie, then open the socket. Done before EVERY (re)connect so a session
    // revoked while the phone was away (revoke-on-exit wiped the device set) surfaces as a clean
    // "expired" instead of an endless 401 reconnect loop. A network error during the claim is transient
    // → retry on the usual cadence; only an explicit 403 means the pairing window is gone.
    function connect(): void {
      if (stopped) return;
      void claimSession(sessionId).then((result) => {
        if (stopped) return;
        if (result === "expired" || result === "stale") {
          // Could be the start-up race (window opening) rather than a truly closed window — retry a few
          // times before showing the re-pair screen, preserving why (stale cookie vs used/expired link).
          if (++expiredStreak <= MAX_CLAIM_RETRIES) reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
          else onExpiredRef.current(result);
          return;
        }
        if (result === "error") {
          reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
          return;
        }
        expiredStreak = 0;
        openSocket();
      });
    }

    function openSocket(): void {
      if (stopped) return;
      const socket = new WebSocket(buildWebSocketUrl(sessionId));
      socketRef.current = socket;

      socket.addEventListener("message", (messageEvent) => {
        let envelope: BridgeEnvelope;
        try {
          envelope = JSON.parse(messageEvent.data as string) as BridgeEnvelope;
        } catch {
          return;
        }
        enqueueRecv(() => handleEnvelope(envelope));
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
  }, [sessionId, enqueueDaemonSend]);

  return { connected, bridgeReady, sendDaemon };
}
