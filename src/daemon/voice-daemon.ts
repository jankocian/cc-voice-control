import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type {
  BridgeEnvelope,
  BrowserToDaemonEvent,
  DaemonToBrowserEvent,
  HistoryTurn,
  InjectMode,
  SessionState,
  SpeakMode,
  ThreadId,
  ThreadInfo
} from "../shared/protocol.js";
import { startBridgeHeartbeat } from "./bridge-heartbeat.js";
import { cmuxHealth, cmuxInterrupt, cmuxSubmit, spawnWorkspace } from "./cmux.js";
import {
  loadOrCreateSession,
  qrPath,
  runtimeDir,
  stateDir,
  threadRuntimePath,
  toBrowserUrl,
  toWebSocketUrl,
  type VoiceRemoteConfig
} from "./config.js";
import { computeLabel } from "./labels.js";
import { synthesizeSpeech, transcribeAudio } from "./openai.js";
import { renderQr } from "./qr.js";
import { buildClaudeSpawnCommand, PERMISSION_MODES } from "./spawn-command.js";
import { dropSessionAnnouncement, type ProjectedTurn, pairReplies } from "./transcript-projection.js";
import { projectTranscript } from "./transcript-reader.js";
import { TurnCoordinator } from "./turn-coordinator.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Audio = { audioBase64: string; mimeType: string };

// A spoken prompt we injected, tracked until its reply is spoken. `id`/`ts` render the optimistic row
// shown before the prompt lands in the transcript; `opened` is set on its UserPromptSubmit (confirming the
// turn is ours); `userUuid`/`userTs` bind it to its native user record, after which the prompt is
// identified by native uuid (not text) and the optimistic row is dropped.
type PendingVoice = { id: string; text: string; ts: number; opened?: boolean; userUuid?: string; userTs?: number };

// Reconnect backoff for transient bridge drops (a terminal 1008 close is handled separately).
const RECONNECT_DELAY_MS = 1500;
// Bridge keepalive interval. Pinging well under any network/NAT idle timeout keeps the socket warm and
// catches a half-open drop within ~2 ticks (see bridge-heartbeat.ts). Cheap: Cloudflare auto-pongs
// without waking the hibernated Durable Object.
const BRIDGE_PING_INTERVAL_MS = 25_000;
// How often the daemon re-resolves its cmux pane so `listening` self-heals.
const CMUX_HEALTH_INTERVAL_MS = 5000;
// Safety ceiling on speech length (synthesizeSpeech chunks past the per-call TTS limit) so a runaway
// reply can't fan out into unbounded TTS calls. Far above any real reply; ~40k ≈ 10 chunks.
const MAX_SPEECH_CHARS = 40_000;
// Cap the projected thread (newest turns) sent to the phone, and the synthesized reply audio retained for
// tap-to-play, so neither grows unbounded over a long session.
const MAX_PROJECTED_TURNS = 40;
const MAX_AUDIO_ENTRIES = 20;
// Cap untracked-but-queued voice prompts (bounds memory if injections never open turns).
const MAX_PENDING_VOICE = 16;
// On a turn close, poll the transcript up to this long for the voice reply to flush before giving up.
const SETTLE_TIMEOUT_MS = 12_000;
const SETTLE_POLL_MS = 150;

// Plugin-load root, three dirs up from this module either way (dist/daemon or src/daemon). Only used
// to point a spawned `claude` at a `--plugin-dir`-loaded (dev) plugin.
const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Dev loads the plugin via `--plugin-dir` (Claude Code marks it with an `-inline` data dir); an
// installed plugin is global, so the flag is omitted. Pass the dir only for an inline (dev) load.
const SPAWN_PLUGIN_DIR = stateDir().endsWith("-inline") ? PLUGIN_ROOT : undefined;

export type DaemonInit = {
  config: VoiceRemoteConfig;
  surface?: string;
  // Non-secret per-pane routing key (CMUX_SURFACE_ID, or a uuid outside cmux). Tags every event; a
  // reconnecting pane re-registers to the SAME slot. NOT the session secret.
  threadId: ThreadId;
  // The MACHINE-level secret (session.json) that routes AND authorizes the session. Shared by every
  // pane → identical phone URL/QR. Carried in the URL path, never sent as a separate value.
  secret: string;
  sessionId: string; // short, non-secret hash of `secret` — safe to relay/log
  browserUrl: string;
};

/** Build the daemon init from config + the current cmux pane (threadId = CMUX_SURFACE_ID, or a uuid
 *  outside cmux). The secret is the SHARED machine secret, so every pane derives the same URL/QR. */
export function createDaemonInit(config: VoiceRemoteConfig): DaemonInit {
  const surface = process.env.CMUX_SURFACE_ID;
  const threadId = surface ?? randomUUID();
  const { secret, sessionId } = loadOrCreateSession();
  const browserUrl = toBrowserUrl(config.bridgeUrl, secret);
  return { config, surface, threadId, secret, sessionId, browserUrl };
}

/**
 * Voice daemon for the cmux-hosted Claude Code session. Phone speaks → STT → `cmux send` types it
 * into the live pane; the Stop hook POSTs Claude's reply back → TTS → phone. The real interactive
 * session, no turn-hijack. Runs INSIDE Claude Code's process tree (a background Bash task), so it
 * keeps cmux's socket trust and dies with the session (a detached process would lose both). Logs to
 * stderr (teed to ${stateDir}/daemon.log); the entry point reserves stdout for its banner.
 */
export class VoiceDaemon {
  private readonly init: DaemonInit;
  private ws?: WebSocket;
  private httpServer?: Server;
  private port = 0;
  // `cmuxHealthy` drives the "listening" lamp: optimistic (starts true), drops only on a POSITIVE
  // "pane gone" verdict. `cmuxReachable` tracks the socket separately, just to log transitions.
  private cmuxHealthy = true;
  private cmuxReachable = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private healthTimer?: ReturnType<typeof setInterval>;
  // Stops the current bridge socket's ping/pong keepalive; re-armed on every (re)connect.
  private stopHeartbeat?: () => void;
  private stopped = false;

  // The voice injection queue + idle-gate (inject one spoken prompt at a time while Claude is idle) and
  // working-state tracker. It does NOT touch conversation content — the transcript drives that. See
  // turn-coordinator.ts.
  private readonly turns: TurnCoordinator;

  // The ONLY state we keep of our own; everything the phone shows is projected from Claude's transcript.
  //  - `audio`: synthesized reply audio keyed by native reply uuid, for tap-to-play + reconnect.
  //  - `lastTranscriptPath`: the transcript the hooks last pointed us at, so `sync` can re-project without
  //    a hook firing.
  //  - `pending`: spoken prompts we injected, each tracked until its reply is spoken. While a prompt isn't
  //    yet visible in the transcript it shows as an OPTIMISTIC row (`id`/`ts`); on its UserPromptSubmit we
  //    BIND it to that native user record (`userUuid`/`userTs`) — from then on it's identified by native
  //    uuid, not text, so a duplicate phrase or a terminal-typed collision can't mis-speak or mis-retire.
  //  - `spoken`: reply uuids already spoken, so re-projecting on every event never double-speaks.
  //  - `floor`: epoch ms below which projected turns are hidden (set on /clear|/compact so a new topic
  //    doesn't show the previous one still sitting in the transcript tail).
  private readonly audio = new Map<string, Audio>();
  private lastTranscriptPath?: string;
  private readonly pending: PendingVoice[] = [];
  private readonly spoken = new Set<string>();
  private floor = 0;
  // The phone's autoplay preference for VOICE turns: "off" speaks nothing, "final" speaks just the final
  // reply (default — the prior behaviour), "all" also speaks each interim step. Tap-to-play works in every
  // mode. Set via set_speak_mode.
  private speakMode: SpeakMode = "final";

  // The spawning session's LIVE permission mode (forwarded each turn by the turn-open hook). A spawn
  // launches with `--permission-mode <this>` so it inherits the user's mode EXACTLY (env won't carry
  // it). Undefined until the first turn → a spawn before then falls back to the user's default.
  private inheritedPermissionMode?: string;

  // If THIS daemon was spawned (phone "+"/skill) it carries a VOICE_SPAWN_ID. Sent once in the FIRST
  // thread_register so the phone follows the exact thread it asked for, then cleared.
  private pendingSpawnId = process.env.VOICE_SPAWN_ID;

  // Last-computed thread label (repo·branch·cwd · cmux title). Sent in thread_register and refreshed
  // on the health tick when it changes; starts with a cheap sync fallback so registration never blocks.
  private label: ThreadInfo["label"];

  constructor(init: DaemonInit) {
    this.init = init;
    this.label = { title: init.threadId };
    this.turns = new TurnCoordinator({
      inject: (text) => this.injectIntoPane(text),
      onStatusChange: () => this.emitStatus(),
      log: (message) => console.error(message)
    });
  }

  get browserUrl(): string {
    return this.init.browserUrl;
  }

  async start(): Promise<void> {
    await this.startHookListener();
    this.writeRuntime();
    this.connectBridge();
    console.error(
      `voice-remote ready. cmux surface=${this.init.surface ?? "(none — CMUX_SURFACE_ID was not set!)"} hookPort=${this.port}`
    );
    console.error(`Phone URL: ${this.init.browserUrl}`);
    // Monitor cmux without blocking startup — a hung/missing cmux must not prevent
    // the daemon from coming up and showing the phone URL.
    this.startCmuxMonitor();
  }

  // ---- cmux liveness (optimistic + self-healing) ----------------------------

  // Re-resolve the cmux pane on a timer so `listening` self-heals. OPTIMISTIC: drop to "not listening"
  // only on a POSITIVE pane-gone verdict — a merely-unreachable socket stays listening (locking out on
  // an ambiguous blip was a real bug; a true outage surfaces on the next failed injection). SELF-HEALING:
  // the surface ref survives a workspace move, so a re-probe recovers on its own.
  private startCmuxMonitor(): void {
    void this.refreshCmuxHealth();
    this.healthTimer = setInterval(() => void this.refreshCmuxHealth(), CMUX_HEALTH_INTERVAL_MS);
  }

  private async refreshCmuxHealth(): Promise<void> {
    // Fold the label refresh into the existing tick (the cmux title tracks the running task)
    // instead of adding a second timer; it re-registers only when something actually changed.
    void this.refreshLabel();
    const health = await cmuxHealth(this.init.surface);
    if (health.socketUp !== this.cmuxReachable) {
      this.cmuxReachable = health.socketUp;
      console.error(
        health.socketUp
          ? "[cmux] control socket reachable again"
          : "WARNING: cmux control socket unreachable this tick — staying optimistic (injection will surface any real failure)."
      );
    }
    // listening is false ONLY on a POSITIVE "pane gone" verdict (surfaceAlive===false).
    // A reachable pane, an unknown probe, or a down socket all stay optimistic.
    const healthy = health.surfaceAlive !== false;
    if (healthy === this.cmuxHealthy) return; // only emit on change
    this.cmuxHealthy = healthy;
    console.error(
      healthy
        ? "[cmux] pane reachable — listening"
        : "WARNING: the Claude pane is no longer reachable in cmux (closed?) — restart /voice-control:start in a live pane."
    );
    this.emitStatus();
  }

  // ---- local listener for the Stop hook -------------------------------------

  private startHookListener(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        // POST routes from the plugin's hooks/skills: /turn-open (UserPromptSubmit → a turn started,
        // with the REAL pre-expansion prompt + live permission mode), /turn-close (Stop → the turn's
        // reply), /reset (SessionStart on clear/compact → wipe history), /spawn (the spawn skill).
        const route = req.method === "POST" ? req.url : undefined;
        if (
          route !== "/turn-open" &&
          route !== "/turn-progress" &&
          route !== "/turn-close" &&
          route !== "/reset" &&
          route !== "/spawn"
        ) {
          res.statusCode = 404;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          // /spawn answers with the result so the agent can report where the new session opened;
          // the other routes are fire-and-forget (acked immediately).
          if (route === "/spawn") {
            void this.handleSpawnRequest(body, res);
            return;
          }
          res.statusCode = 204;
          res.end();
          if (route === "/reset") {
            this.handleReset();
            return;
          }
          try {
            if (route === "/turn-open") {
              const { transcriptPath, prompt, permissionMode } = JSON.parse(body || "{}") as {
                transcriptPath?: string;
                prompt?: string;
                permissionMode?: string;
              };
              // Remember the live permission mode so a spawn during this turn inherits it EXACTLY.
              if (typeof permissionMode === "string" && PERMISSION_MODES.has(permissionMode)) {
                this.inheritedPermissionMode = permissionMode;
              }
              if (transcriptPath) this.lastTranscriptPath = transcriptPath;
              const realPrompt = typeof prompt === "string" ? prompt : "";
              this.turns.turnOpened(realPrompt);
              this.bindVoicePrompt(realPrompt); // if this turn is one of ours, bind it to its native uuid
              this.projectAndEmit(); // the new user turn is in the transcript now → show it, keyed natively
            } else if (route === "/turn-progress") {
              // PreToolUse: Claude wrote a step (narration) before this tool call → re-project so it shows
              // live, and (if opted in) speak it on a voice turn.
              const { transcriptPath } = JSON.parse(body || "{}") as { transcriptPath?: string };
              if (transcriptPath) this.lastTranscriptPath = transcriptPath;
              const turns = this.projectedNow();
              this.sendToBrowser(this.historyFrom(turns));
              this.speakNewSteps(turns);
            } else {
              const { transcriptPath } = JSON.parse(body || "{}") as { transcriptPath?: string };
              if (transcriptPath) this.lastTranscriptPath = transcriptPath;
              this.turns.turnClosed();
              void this.handleTurnClose(); // re-project (waiting for the flush) + speak a voice reply
            }
          } catch {
            // ignore malformed hook payloads
          }
        });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        this.port = typeof address === "object" && address ? address.port : 0;
        this.httpServer = server;
        resolve();
      });
    });
  }

  private writeRuntime(): void {
    mkdirSync(runtimeDir(), { recursive: true });
    // Render the QR (machine-level — identical bytes for every pane, since the URL is a pure
    // function of the shared secret) before the runtime file so it's present once the start
    // skill reads it. A render failure must never block the URL, so it's best-effort.
    try {
      writeFileSync(qrPath(), `${renderQr(this.init.browserUrl)}\n`);
    } catch (error) {
      console.error(`[qr] render failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Per-thread runtime file (runtime/<surfaceId>.json) so panes don't clobber each other's
    // port/pid and this pane's Stop/reset hooks reach THIS daemon.
    writeFileSync(
      threadRuntimePath(this.init.surface),
      JSON.stringify(
        { port: this.port, pid: process.pid, surface: this.init.surface ?? null, sessionUrl: this.init.browserUrl },
        null,
        2
      )
    );
  }

  // Handle a /reset POST (SessionStart on clear/compact): a new topic in the SAME pane. Raise the
  // projection floor to now so the previous topic — still sitting in the transcript tail — is hidden, drop
  // our voice state, and push the (now empty) projection so the phone clears the stale thread.
  private handleReset(): void {
    this.floor = Date.now();
    this.audio.clear();
    this.spoken.clear();
    this.pending.length = 0;
    // /clear or /compact ends the current topic: drop every in-flight/queued/open turn (so a stale
    // turn can't be spoken or wedge the idle-gate) — reset() also re-emits idle status.
    this.turns.reset();
    console.error("[reset] cleared voice history for this thread (/clear or /compact)");
    this.projectAndEmit();
  }

  // ---- bridge ----------------------------------------------------------------

  private connectBridge(): void {
    if (this.stopped) return;
    // Pass the threadId on the connect URL so the DO attaches it before the first message —
    // browser→daemon routing keys on it from the very first send.
    const url = toWebSocketUrl(this.init.config.bridgeUrl, this.init.secret, "daemon", this.init.threadId);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      // Register this thread with the DO (so the roster lists it) BEFORE the first status, then
      // refresh the label asynchronously — git/cmux must never block the socket coming up.
      this.registerThread();
      this.emitStatus();
      void this.refreshLabel();
      // Keep this socket alive + detect a half-open drop (zombie OPEN that never fires close).
      this.stopHeartbeat = startBridgeHeartbeat(ws, BRIDGE_PING_INTERVAL_MS);
    });
    ws.on("message", (raw) => {
      let envelope: { channel?: string; threadId?: ThreadId; event?: BrowserToDaemonEvent };
      try {
        envelope = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Only act on events addressed to THIS thread (the DO routes browser→one daemon by
      // threadId, but guard here too so a mis-tagged envelope can't drive the wrong pane).
      if (envelope.channel === "daemon" && envelope.event && envelope.threadId === this.init.threadId) {
        this.handleBrowserEvent(envelope.event).catch((error) => this.sendError(error));
      }
    });
    ws.on("close", (code) => {
      this.stopHeartbeat?.();
      this.stopHeartbeat = undefined;
      if (this.stopped || this.ws !== ws) return;
      this.ws = undefined;
      // 1008 = the bridge ended the session. Reconnecting would just be rejected, so
      // treat it as terminal rather than hot-looping forever.
      if (code === 1008) {
        this.stopped = true;
        return;
      }
      this.reconnectTimer = setTimeout(() => this.connectBridge(), RECONNECT_DELAY_MS);
    });
    ws.on("error", () => {
      /* the close handler decides whether to reconnect */
    });
  }

  private async handleBrowserEvent(event: BrowserToDaemonEvent): Promise<void> {
    switch (event.type) {
      case "submit_audio":
        await this.handleAudio(event.audioBase64, event.mimeType, event.mode);
        return;
      case "status_request":
        this.queueVoice("Give me a brief spoken status of what you're doing right now.", "queue");
        return;
      case "summary_request":
        this.queueVoice("Briefly summarize what you've done so far, for the phone.", "queue");
        return;
      case "stop_task":
        // Esc the running turn → Claude goes idle; the coordinator drops every open turn and drains
        // the queue (a late Stop for a dropped turn lands on an empty FIFO and is ignored).
        await cmuxInterrupt(this.init.surface);
        this.pending.length = 0;
        this.turns.interrupt();
        this.projectAndEmit();
        return;
      case "sync":
        // The phone (re)connected and wants the current state. Replaces a heartbeat (the daemon otherwise
        // emits status only on change, which a fresh phone misses), then re-projects the thread so a
        // refresh / 2nd browser restores it. Only emit history once we know the transcript path: a `history`
        // snapshot is authoritative (the phone replaces with it), so emitting an empty one before the first
        // hook of a freshly-(re)started daemon would wipe the phone's thread. Text only — audio on demand.
        this.emitStatus();
        if (this.lastTranscriptPath) this.projectAndEmit();
        return;
      case "get_audio":
        // Tap-to-play on a row whose audio isn't cached: serve it, synthesizing on demand for a step (we
        // don't pre-synthesize every step), or tell the phone gracefully if the row is gone from the tail.
        await this.serveAudio(event.requestId);
        return;
      case "set_speak_mode":
        if (event.mode === "off" || event.mode === "final" || event.mode === "all") this.speakMode = event.mode;
        return;
      case "spawn_thread": {
        // The phone "+" : open a NEW cmux workspace running Claude + /voice-control:start. It reads
        // the same session.json → joins this same session as a new thread (same QR). Routed here
        // because this daemon has the cmux trust to spawn for the machine.
        const result = await this.spawnThread(event.cwd);
        if (!result.ok) {
          this.sendToBrowser({ type: "error", message: "Couldn't open a new session (cmux new-workspace failed)." });
        }
        return;
      }
      default:
        return;
    }
  }

  // Spawn a sibling thread via a new cmux workspace (cwd defaults to this daemon's). The spawned pane's
  // own daemon registers once it connects; callers surface a failure (phone error / the /spawn response).
  private async spawnThread(cwd?: string): Promise<{ ok: boolean; ref?: string }> {
    const spawnId = randomUUID();
    const command = this.buildSpawnCommand(spawnId);
    const ref = await spawnWorkspace({ cwd: cwd ?? process.cwd(), command });
    if (ref) {
      console.error(`[spawn] new workspace ${ref} :: ${command}`);
      // Tell the phone to follow this exact spawn (the new daemon echoes the same spawnId in its
      // first register). Works for the "+" AND the /voice-control:spawn skill — both land here.
      this.sendToBrowser({ type: "spawn_pending", spawnId });
    }
    return { ok: Boolean(ref), ref };
  }

  // Handle a /spawn POST (the spawn skill, so the Claude agent can open a new voice-controlled
  // session on request — optionally at a given cwd). Inherits this session's permission mode and
  // answers with { ok, ref } so the agent can tell the user where the new session opened.
  private async handleSpawnRequest(body: string, res: ServerResponse): Promise<void> {
    let cwd: string | undefined;
    try {
      const parsed = JSON.parse(body || "{}") as { cwd?: string };
      if (typeof parsed.cwd === "string" && parsed.cwd.trim()) cwd = parsed.cwd.trim();
    } catch {
      // malformed body → spawn at the daemon's own cwd
    }
    try {
      const result = await this.spawnThread(cwd);
      res.statusCode = result.ok ? 200 : 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      // Never leave the skill's request hanging (or reject an uncaught promise) if the spawn throws.
      console.error(`[spawn] request failed: ${error instanceof Error ? error.message : String(error)}`);
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false }));
    }
  }

  // The shell command a spawned cmux workspace runs to join this session (see spawn-command.ts). cmux
  // focuses the new workspace and reuses the trusted cwd, so there's no first-run trust gate.
  private buildSpawnCommand(spawnId: string): string {
    return buildClaudeSpawnCommand({
      spawnId,
      pluginDir: SPAWN_PLUGIN_DIR,
      permissionMode: this.inheritedPermissionMode
    });
  }

  private async handleAudio(audioBase64: string, mimeType: string, mode: InjectMode): Promise<void> {
    let transcript: string;
    try {
      transcript = await transcribeAudio(this.init.config, Buffer.from(audioBase64, "base64"), mimeType);
    } catch (error) {
      this.sendError(error);
      return;
    }
    if (!transcript) {
      this.sendToBrowser({ type: "error", message: "No speech detected — try again." });
      return;
    }
    if (mode === "interrupt") await cmuxInterrupt(this.init.surface); // Esc the running turn, run this next
    this.queueVoice(transcript, mode);
  }

  // Queue a spoken prompt: track it (so we speak its reply + show it as an optimistic row until it lands in
  // the transcript — possibly minutes later if Claude is busy), then hand it to the injection queue. This
  // is the only conversation content we originate; everything else is projected from the transcript.
  private queueVoice(text: string, mode: InjectMode): void {
    if (mode === "interrupt") this.pending.length = 0; // Esc dropped the backlog → its optimistic rows go too
    this.pending.push({ id: randomUUID(), text, ts: Date.now() });
    while (this.pending.length > MAX_PENDING_VOICE) this.pending.shift();
    if (mode === "interrupt") this.turns.interruptWith(text);
    else this.turns.enqueueVoice(text);
    this.projectAndEmit();
  }

  // ---- injection (driven by the TurnCoordinator) ----------------------------

  // Type one prompt into the live Claude pane. The coordinator calls this ONLY when Claude is idle
  // (it owns the queue and the idle-gate); we own the cmux send and the "listening" lamp. Returns
  // true on success. A successful send positively proves the pane is alive, so it self-heals a stale
  // "not listening"; a failure surfaces an error and re-probes (the coordinator releases the slot).
  private async injectIntoPane(text: string): Promise<boolean> {
    console.error(`[inject] surface=${this.init.surface ?? "(default $CMUX_SURFACE_ID)"} text=${JSON.stringify(text)}`);
    const ok = await cmuxSubmit(text, this.init.surface);
    console.error(`[inject] cmuxSubmit ok=${ok}`);
    if (ok) {
      if (!this.cmuxHealthy) {
        this.cmuxHealthy = true;
        this.emitStatus();
      }
      return true;
    }
    // The coordinator releases its slot; drop the prompt we couldn't deliver (it never reached the
    // transcript) so its optimistic row doesn't linger and can't be mis-bound later.
    const i = this.pending.findIndex((p) => p.userUuid === undefined && p.text.trim() === text.trim());
    if (i >= 0) this.pending.splice(i, 1);
    // Don't hard-fail "listening" on one send: re-probe (only a positive pane-gone verdict flips it).
    void this.refreshCmuxHealth();
    this.sendToBrowser({
      type: "error",
      message: "Couldn't reach the Claude Code pane (is it still open in cmux?)."
    });
    this.projectAndEmit();
    return false;
  }

  // ---- transcript projection (the conversation source of truth) --------------

  // Project the transcript into the phone thread and send it. Called on every turn event + on sync, so the
  // phone always converges to ground truth. Pure read; never throws into the caller.
  private projectAndEmit(): void {
    this.sendToBrowser(this.historyFrom(this.projectedNow()));
  }

  private projectedNow(): ProjectedTurn[] {
    if (!this.lastTranscriptPath) return [];
    const turns = projectTranscript(this.lastTranscriptPath, MAX_PROJECTED_TURNS).filter(
      (t) => t.timestamp >= this.floor
    );
    // Hide the start-skill's "voice remote is live" QR/URL reply — it's noise on the phone (and must
    // never be spoken). Matched on our own session URL, so it's prose-independent. See the helper.
    return dropSessionAnnouncement(turns, this.init.browserUrl);
  }

  // Mark a just-opened turn as ours if it matches a queued voice prompt (by the hook's REAL prompt text —
  // the one authoritative point where text is trusted, at the instant the turn opens). From here the entry
  // is bound to its native user record by uuid (bindPending), so duplicates / terminal collisions can't
  // mis-target it.
  private bindVoicePrompt(prompt: string): void {
    const text = prompt.trim();
    if (!text) return;
    const entry = this.pending.find((p) => !p.opened && p.text.trim() === text);
    if (entry) entry.opened = true;
  }

  // Bind each opened-but-unbound voice entry to its native user record (newest matching one not already
  // claimed), capturing its uuid + timestamp. Runs on every projection, so a prompt whose record wasn't
  // flushed at turn-open binds as soon as it appears. Once bound, the entry shows as the native row, not an
  // optimistic one.
  private bindPending(turns: ProjectedTurn[]): void {
    const claimed = new Set(this.pending.map((p) => p.userUuid).filter(Boolean));
    for (const entry of this.pending) {
      if (!entry.opened || entry.userUuid) continue;
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (t.role === "user" && t.text.trim() === entry.text.trim() && !claimed.has(t.uuid)) {
          entry.userUuid = t.uuid;
          entry.userTs = t.timestamp;
          claimed.add(t.uuid);
          break;
        }
      }
    }
  }

  // Build the `history` snapshot: native rows from the transcript, plus an optimistic row for each voice
  // prompt not yet visible there (unbound) — the phone orders by native timestamp, so they sort newest.
  // The snapshot is the complete, deduped, ordered thread; the phone just displays it.
  private historyFrom(turns: ProjectedTurn[]): Extract<DaemonToBrowserEvent, { type: "history" }> {
    this.bindPending(turns);
    const rows: HistoryTurn[] = [
      ...turns.map((t) => ({
        requestId: t.uuid,
        timestamp: t.timestamp,
        role: t.role,
        text: t.text,
        hasAudio: this.audio.has(t.uuid),
        interim: t.interim
      })),
      ...this.pending
        .filter((p) => p.userUuid === undefined)
        .map((p) => ({ requestId: p.id, timestamp: p.ts, role: "user" as const, text: p.text, hasAudio: false }))
    ];
    return { type: "history", turns: rows };
  }

  // "read every step" is on AND a VOICE turn is in progress → speak its newly-appeared steps as they land
  // (final replies still speak via handleTurnClose). Gated to the in-flight voice turn (steps after its
  // prompt) so turning the toggle on doesn't read out a backlog, and a terminal-typed turn is never read.
  private speakNewSteps(turns: ProjectedTurn[]): void {
    if (this.speakMode !== "all") return;
    const voice = this.pending.find((p) => p.opened && p.userTs !== undefined);
    if (!voice) return;
    for (const t of turns) {
      if (!t.interim || this.spoken.has(t.uuid) || t.timestamp < (voice.userTs ?? 0)) continue;
      this.remember(this.spoken, t.uuid, MAX_AUDIO_ENTRIES * 4);
      void this.speak(t.uuid, t.text);
    }
  }

  // Serve a row's audio to the phone: from the store, else synthesize it on demand (a step isn't
  // pre-synthesized) by looking its text up in the current projection. A miss (row gone from the tail)
  // returns a graceful error.
  private async serveAudio(uuid: string): Promise<void> {
    let audio = this.audio.get(uuid);
    if (!audio) {
      const turn = this.projectedNow().find((t) => t.uuid === uuid);
      if (turn) {
        try {
          const synth = await synthesizeSpeech(this.init.config, capForSpeech(turn.text));
          if (synth.audioBase64)
            audio = this.storeAudio(uuid, { audioBase64: synth.audioBase64, mimeType: synth.mimeType });
        } catch {
          // fall through to the not-available error
        }
      }
    }
    this.sendToBrowser(
      audio
        ? { type: "tts_audio", requestId: uuid, replay: true, ...audio }
        : { type: "error", requestId: uuid, message: "Audio for that reply is no longer available." }
    );
  }

  // After a turn closes: wait until every voice turn we're tracking has its reply flushed (positive
  // evidence, not just "the file stopped changing" — the Stop hook can fire before the reply lands), then
  // re-project and speak each unspoken voice reply. Replies are matched to our prompts by native uuid, so a
  // duplicate phrase or a terminal-typed turn with the same text can never be mis-spoken; `spoken` makes it
  // idempotent + self-healing. Hard timeout so a reply-less / typed turn never hangs.
  private async handleTurnClose(): Promise<void> {
    if (!this.lastTranscriptPath) return;
    let turns = this.projectedNow();
    this.sendToBrowser(this.historyFrom(turns)); // show the turn promptly, before waiting on the reply
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      this.bindPending(turns);
      if (this.pending.every((p) => !p.opened || this.findReply(turns, p))) break; // all tracked replies in
      await sleep(SETTLE_POLL_MS);
      turns = this.projectedNow();
    }
    this.sendToBrowser(this.historyFrom(turns));

    for (let i = this.pending.length - 1; i >= 0; i--) {
      const entry = this.pending[i];
      if (!entry.opened) continue;
      const reply = this.findReply(turns, entry);
      if (!reply || this.spoken.has(reply.uuid)) continue;
      this.pending.splice(i, 1);
      this.remember(this.spoken, reply.uuid, MAX_AUDIO_ENTRIES * 4);
      // "off" still resolves the turn + shows the reply, but doesn't auto-play it (tap-to-play remains).
      if (this.speakMode !== "off") void this.speak(reply.uuid, reply.text);
    }
  }

  // The reply to a bound voice prompt: the one whose paired prompt IS our native user record (by uuid).
  // Fallback to the earliest unspoken reply after our prompt's timestamp for the rare case its user record
  // has scrolled out of the read tail (so pairReplies can't see it). Undefined until the reply has flushed.
  private findReply(turns: ProjectedTurn[], entry: PendingVoice): ProjectedTurn | undefined {
    if (!entry.userUuid) return undefined;
    const paired = pairReplies(turns).find((p) => p.prompt?.uuid === entry.userUuid)?.reply;
    if (paired) return paired;
    if (entry.userTs === undefined) return undefined;
    return turns.find((t) => t.role === "claude" && t.timestamp > (entry.userTs ?? 0) && !this.spoken.has(t.uuid));
  }

  // Retain synthesized audio keyed by native uuid, evicting the oldest past the cap.
  private storeAudio(uuid: string, audio: Audio): Audio {
    this.audio.set(uuid, audio);
    while (this.audio.size > MAX_AUDIO_ENTRIES) {
      const oldest = this.audio.keys().next().value;
      if (oldest === undefined) break;
      this.audio.delete(oldest);
    }
    return audio;
  }

  // Synthesize a reply/step's audio, retain it (keyed by native uuid) for tap-to-play + reconnect, and
  // push it to the phone to auto-play now.
  private async speak(uuid: string, text: string): Promise<void> {
    try {
      const { audioBase64, mimeType } = await synthesizeSpeech(this.init.config, capForSpeech(text));
      if (!audioBase64) return; // nothing to synthesize (empty/whitespace reply)
      this.storeAudio(uuid, { audioBase64, mimeType });
      this.sendToBrowser({ type: "tts_audio", requestId: uuid, audioBase64, mimeType });
    } catch (error) {
      // The text reply already reached the phone; surface the audio failure (don't swallow it) so a
      // config/model/rate-limit problem is visible instead of "the voice just didn't arrive".
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tts] synthesis failed for ${uuid}: ${message}`);
      this.sendToBrowser({
        type: "error",
        message: "Couldn't speak that reply — its text is shown, but audio failed."
      });
    }
  }

  // Add to a bounded set (FIFO eviction) so a long session can't leak.
  private remember(set: Set<string>, value: string, cap: number): void {
    set.add(value);
    while (set.size > cap) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
  }

  // ---- thread registry -------------------------------------------------------

  // Snapshot of this thread for the DO roster: id + label + live state/listening. The DO
  // stores this and serves it to phones; the daemon keeps no roster of its own.
  private buildThreadInfo(): ThreadInfo {
    return {
      threadId: this.init.threadId,
      label: this.label,
      state: this.turns.isWorking() ? "working" : "idle",
      listening: this.cmuxHealthy,
      spawnId: this.pendingSpawnId
    };
  }

  // Tell the DO about this thread (register on connect, refresh on label/state change). The DO
  // dedups by threadId and broadcasts a roster delta; sending it again is the refresh path.
  private registerThread(): void {
    this.send({ channel: "registry", event: { type: "thread_register", info: this.buildThreadInfo() } });
    this.pendingSpawnId = undefined; // one-shot: only the FIRST register carries the spawn id
  }

  // Recompute the label (repo·branch·cwd · cmux title) and re-register only if it changed, so
  // the cmux-health tick can call this every 5s without spamming the DO. Best-effort: a failed
  // compute keeps the last good label.
  private async refreshLabel(): Promise<void> {
    // process.cwd() throws if the daemon's working directory was deleted/unmounted; keep the last
    // good label rather than rejecting this floating promise.
    let cwd: string;
    try {
      cwd = process.cwd();
    } catch {
      return;
    }
    const next = await computeLabel(cwd, this.init.surface, this.init.threadId);
    if (sameLabel(next, this.label)) return;
    this.label = next;
    if (this.ws?.readyState === WebSocket.OPEN) this.registerThread();
  }

  // ---- helpers ---------------------------------------------------------------

  // Status carries this thread's id (so the phone files it correctly); a thread_register rides along to
  // keep the roster's state/listening in lockstep.
  private emitStatus(): void {
    const state: SessionState = {
      sessionId: this.init.sessionId,
      listening: this.cmuxHealthy,
      state: this.turns.isWorking() ? "working" : "idle"
    };
    this.sendToBrowser({ type: "session_status", state, memory: { currentTask: this.turns.currentVoicePrompt } });
    // Keep the roster's state/listening in lockstep with status (idle↔working, listening
    // flips) without a separate channel — register is the refresh path, deduped DO-side.
    if (this.ws?.readyState === WebSocket.OPEN) this.registerThread();
  }

  private sendToBrowser(event: DaemonToBrowserEvent): void {
    // Tag every outbound event with this daemon's threadId so the phone/DO attribute it correctly.
    this.send({ channel: "browser", threadId: this.init.threadId, event });
  }

  private send(envelope: BridgeEnvelope): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(envelope));
    } catch {
      // socket closing; reconnect will re-sync
    }
  }

  private sendError(error: unknown): void {
    this.sendToBrowser({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.stopHeartbeat?.();
    // Tell the bridge to drop the session so a leaked URL can't reconnect. Best-effort:
    // if the socket is already gone the session is inert anyway (no daemon to relay to).
    this.send({ channel: "control", event: { type: "terminate" } });
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.httpServer?.close();
    try {
      // Remove only THIS pane's runtime file (siblings keep theirs). qr.txt is machine-level — leave it
      // (a sibling rewrites identical bytes; a stale QR is harmless, the DO revokes the session on exit).
      rmSync(threadRuntimePath(this.init.surface), { force: true });
    } catch {
      // ignore
    }
  }
}

// Structural equality of two labels (all fields), so a refresh re-registers only on a real
// change and the cmux-health tick doesn't spam the DO every 5s.
function sameLabel(a: ThreadInfo["label"], b: ThreadInfo["label"]): boolean {
  return a.title === b.title && a.repo === b.repo && a.branch === b.branch && a.cwd === b.cwd;
}

// Safety ceiling only (see MAX_SPEECH_CHARS): caps a pathological runaway so it can't fan out into
// unbounded TTS calls. Real replies pass untouched.
function capForSpeech(text: string): string {
  return text.length > MAX_SPEECH_CHARS ? `${text.slice(0, MAX_SPEECH_CHARS)}…` : text;
}
