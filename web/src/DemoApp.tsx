import { useEffect, useRef, useState } from "react";
import { Hero } from "@/components/Hero";
import { InlineAudioPlayer } from "@/components/InlineAudioPlayer";
import { MessageBubble } from "@/components/MessageBubble";
import { MiniControls } from "@/components/MiniControls";
import { TopBar } from "@/components/TopBar";
import { deriveStatus, type StatusInputs } from "@/lib/status";

// Presentation-only demo harness for the visual-verification loop. `?demo=<state>`
// renders the full screen (TopBar + Hero + thread + sticky condensed controls) in a
// fixed state with no bridge/recorder/mic — so each reference state can be
// screenshotted offline, including the scroll → condensed-bar behaviour.
// Not used in production (App.tsx is the real, bridge-wired entry).

// Fixed clock for the demo presets so the time-graded offline states are reproducible.
const DEMO_NOW = 1_700_000_000_000;

const PRESETS: Record<string, Partial<StatusInputs>> = {
  connecting: { connected: false },
  // No daemon, never seen → "Waiting for Claude Code".
  waiting: { connected: true, daemonConnected: false },
  // No daemon, seen seconds ago → "Reconnecting…".
  reconnecting: { connected: true, daemonConnected: false, daemonLastSeenAt: DEMO_NOW - 5_000 },
  // No daemon, seen long ago → "Session offline".
  "offline-stale": { connected: true, daemonConnected: false, daemonLastSeenAt: DEMO_NOW - 14 * 60 * 60 * 1000 },
  ready: {},
  recording: { recording: true },
  sending: { transcribing: true },
  working: { runtimeState: "working", currentTask: "Analyzing codebase" },
  speaking: { speaking: true }
};

function buildStatus(over: Partial<StatusInputs>) {
  return deriveStatus({
    connected: true,
    daemonConnected: true,
    daemonLastSeenAt: null,
    now: DEMO_NOW,
    recording: false,
    transcribing: false,
    speaking: false,
    runtimeState: "idle",
    currentTask: undefined,
    listening: true,
    flash: null,
    ...over
  });
}

// A longer fake thread (newest first, like the real App) so the page actually
// scrolls and the condensed bar can be exercised.
const DEMO_THREAD = [
  {
    id: "m8",
    side: "user" as const,
    body: "Also make the max retries configurable via an environment variable.",
    time: "12:38 AM"
  },
  {
    id: "m7",
    side: "agent" as const,
    body: "Done — added MAX_RETRIES with a sane default and documented it in the README.",
    time: "12:38 AM",
    audio: true
  },
  {
    id: "m6",
    side: "user" as const,
    body: "Great. Can you add a jittered backoff so retries don't thunder?",
    time: "12:36 AM"
  },
  {
    id: "m5",
    side: "agent" as const,
    body: "Added full jitter on top of the exponential schedule. Capped at 30s.",
    time: "12:36 AM",
    audio: true
  },
  {
    id: "m4",
    side: "user" as const,
    body: "Please add a retry mechanism for failed webhook deliveries.",
    time: "12:32 AM"
  },
  {
    id: "m3",
    side: "agent" as const,
    body: "I'll implement an exponential backoff retry for failed webhook deliveries with proper logging.",
    time: "12:33 AM",
    audio: true
  },
  { id: "m2", side: "user" as const, body: "And surface the delivery status in the dashboard.", time: "12:30 AM" },
  {
    id: "m1",
    side: "agent" as const,
    body: "I'll add a status column with the last attempt + next retry time.",
    time: "12:31 AM",
    audio: true
  }
];

export function DemoApp({ state }: { state: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const heroSentinelRef = useRef<HTMLDivElement>(null);
  const [condensed, setCondensed] = useState(false);
  const noop = () => {};
  const status = buildStatus(PRESETS[state] ?? {});
  const elapsed = state === "working" ? 158 : 0;
  const working = status.dataState === "working";

  useEffect(() => {
    const root = scrollRef.current;
    const target = heroSentinelRef.current;
    if (!root || !target) return;
    const obs = new IntersectionObserver(([entry]) => setCondensed(!entry.isIntersecting), { root, threshold: 0 });
    obs.observe(target);
    return () => obs.disconnect();
  }, []);

  return (
    <div className="flex h-full flex-col bg-canvas px-safe">
      <TopBar />
      <div className="relative min-h-0 flex-1">
        <main ref={scrollRef} className="flex h-full flex-col overflow-y-auto pb-safe">
          <Hero
            status={status}
            elapsed={elapsed}
            flash={null}
            recording={state === "recording"}
            visualizerActive={state === "recording"}
            canvasRef={canvasRef}
            speedLabel="1.25x"
            onCycleSpeed={noop}
            onMic={noop}
            onSteer={noop}
            onInterrupt={noop}
            onStopRecording={noop}
            onCancel={noop}
            onStopTask={noop}
          />

          <div ref={heroSentinelRef} aria-hidden="true" className="h-px w-full shrink-0" />

          <div className="flex flex-col gap-4 px-4 pb-6">
            {DEMO_THREAD.map((m) =>
              m.side === "user" ? (
                <MessageBubble key={m.id} side="user" body={m.body} time={m.time} delivered />
              ) : (
                <MessageBubble key={m.id} side="agent" body={m.body} time={m.time}>
                  {m.audio && (
                    <InlineAudioPlayer
                      playing={false}
                      loaded={false}
                      position={0}
                      duration={58}
                      onPlayPause={noop}
                      onReplay={noop}
                      onSeek={noop}
                    />
                  )}
                </MessageBubble>
              )
            )}
          </div>
        </main>

        <MiniControls
          status={status}
          elapsed={elapsed}
          working={working}
          recording={state === "recording"}
          shown={condensed}
          onMic={noop}
          onSteer={noop}
          onInterrupt={noop}
          onStopRecording={noop}
          onCancel={noop}
          onStopTask={noop}
        />
      </div>
    </div>
  );
}
