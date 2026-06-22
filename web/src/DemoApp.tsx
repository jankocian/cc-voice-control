import { useEffect, useRef, useState } from "react";
import { Hero } from "@/components/Hero";
import { InlineAudioPlayer } from "@/components/InlineAudioPlayer";
import { MessageBubble } from "@/components/MessageBubble";
import { MiniControls } from "@/components/MiniControls";
import { ThreadPager } from "@/components/ThreadPager";
import { TopBar } from "@/components/TopBar";
import type { Message } from "@/lib/messages";
import type { ThreadId } from "@/lib/protocol";
import { deriveStatus, type StatusInputs } from "@/lib/status";

// Presentation-only demo harness for the visual-verification loop. `?demo=<state>`
// renders the full screen (TopBar + pinned Hero + thread + sticky condensed controls) in a
// fixed state with no bridge/recorder/mic — so each reference state can be screenshotted
// offline, including the hero scroll-away → condensed-bar behaviour and the dark theme.
// Mirrors App's layout (pinned, scroll-translated hero over a scroll root) so what it shows is
// what the real app does. Not used in production (App.tsx is the real, bridge-wired entry).

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

// A longer fake thread (newest first, like the real App) so the page actually scrolls and the
// condensed bar can be exercised. One row carries Markdown (bold / inline code / a fenced block) and
// one audio row is "loaded" with a known duration; the rest are unknown-duration (no bogus 0:00).
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
    body: "Done — I **added retries** with a sane default and documented `MAX_RETRIES`:\n\n```\nexport const MAX_RETRIES = 5;\nconst backoff = base * 2 ** attempt;\n```\n\nThat covers the **webhook** path end to end.",
    time: "12:38 AM",
    audio: true,
    loaded: true
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
  if (state === "pager") return <PagerDemo />;
  return <StateDemo state={state} />;
}

// Exercises the real Embla <ThreadPager> with a few threads so swipe/paging can be verified offline.
function PagerDemo() {
  // Start on a non-first thread to mimic resuming a saved thread — it should JUMP here (no swipe blip).
  const [active, setActive] = useState<ThreadId>("charlie");
  const noop = () => {};
  const ids: ThreadId[] = ["alpha", "bravo", "charlie"];
  const pages = ids.map((id) => ({
    threadId: id,
    messages: Array.from({ length: 6 }, (_, i) => ({
      id: `${id}-${i}`,
      kind: (i % 2 === 0 ? "you" : "claude") as Message["kind"],
      requestId: `${id}-${i}`,
      timestamp: i,
      title: id,
      body: `[${id}] message ${i + 1}`,
      time: "12:00 AM"
    }))
  }));
  const playback = {
    playingId: null,
    loadedId: null,
    position: 0,
    duration: 0,
    playableIds: new Set<string>(),
    onPlay: noop,
    onReplay: noop,
    onSeek: noop
  };
  return (
    <div className="flex h-full flex-col bg-canvas px-safe">
      <TopBar />
      <div className="relative min-h-0 flex-1">
        <ThreadPager
          threads={pages}
          activeThreadId={active}
          renderHero={(isActive) => (
            <div className="grid h-40 place-items-center text-3xl font-bold text-ink" data-hero={active}>
              {active}
              {isActive ? " ●" : ""}
            </div>
          )}
          playback={playback}
          onActivate={setActive}
          activeScrollRootRef={noop}
          activeSentinelRef={noop}
        />
      </div>
    </div>
  );
}

function StateDemo({ state }: { state: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const heroSentinelRef = useRef<HTMLDivElement>(null);
  const [condensed, setCondensed] = useState(false);
  const noop = () => {};
  const status = buildStatus(PRESETS[state] ?? {});
  const elapsed = state === "working" ? 158 : 0;
  const working = status.dataState === "working";

  // Condensed bar appears once the in-flow hero's sentinel scrolls above the top (mirrors App).
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
        <div ref={scrollRef} className="flex h-full flex-col overflow-y-auto pb-safe">
          {/* The hero in normal flow — scrolls away with the content, exactly as App renders it. */}
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
                <MessageBubble
                  key={m.id}
                  side="agent"
                  body={m.body}
                  time={m.time}
                  onActivate={m.audio ? noop : undefined}
                >
                  {m.audio && (
                    <InlineAudioPlayer
                      playing={false}
                      loaded={Boolean(m.loaded)}
                      position={0}
                      duration={m.loaded ? 58 : 0}
                      onPlayPause={noop}
                      onReplay={noop}
                      onSeek={noop}
                    />
                  )}
                </MessageBubble>
              )
            )}
          </div>
        </div>

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
