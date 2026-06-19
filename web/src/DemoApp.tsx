import { useRef } from "react";
import { BottomTabBar } from "@/components/BottomTabBar";
import { Hero } from "@/components/Hero";
import { InlineAudioPlayer } from "@/components/InlineAudioPlayer";
import { MessageBubble } from "@/components/MessageBubble";
import { TopBar } from "@/components/TopBar";
import { deriveStatus, type StatusInputs } from "@/lib/status";

// Presentation-only demo harness for the visual-verification loop. `?demo=<state>`
// renders the full screen (TopBar + Hero + thread + tab bar) in a fixed state with
// no bridge/recorder/mic — so each reference state can be screenshotted offline.
// Not used in production (App.tsx is the real, bridge-wired entry).

const PRESETS: Record<string, Partial<StatusInputs>> = {
  connecting: { connected: false },
  waiting: { connected: true, daemonConnected: false },
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

export function DemoApp({ state }: { state: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const noop = () => {};
  const status = buildStatus(PRESETS[state] ?? {});
  const elapsed = state === "working" ? 158 : 0;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TopBar online={status.dataState !== "offline"} />
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Hero
          status={status}
          elapsed={elapsed}
          recording={state === "recording"}
          visualizerActive={state === "recording"}
          canvasRef={canvasRef}
          speedLabel="1.25x"
          onToggleRecord={noop}
          onCycleSpeed={noop}
          onInterrupt={noop}
          onSteer={noop}
          onStop={noop}
        />

        <div className="flex flex-col gap-4 px-4 pb-6">
          <MessageBubble
            side="user"
            body="Please add a retry mechanism for failed webhook deliveries."
            time="12:32 AM"
            delivered
          />
          <MessageBubble
            side="agent"
            body="I'll implement an exponential backoff retry for failed webhook deliveries with proper logging."
            time="12:33 AM"
          >
            <InlineAudioPlayer
              playing={false}
              loaded={state === "speaking"}
              position={state === "speaking" ? 18 : 0}
              duration={62}
              onPlayPause={noop}
              onReplay={noop}
              onSeek={noop}
            />
          </MessageBubble>
          <MessageBubble
            side="user"
            body="Also make the max retries configurable via an environment variable."
            time="12:34 AM"
            delivered
          />
          <MessageBubble
            side="agent"
            body="Got it. I'll add the environment variable and update the docs accordingly."
            time="12:35 AM"
          >
            <InlineAudioPlayer
              playing={false}
              loaded={false}
              position={0}
              duration={58}
              onPlayPause={noop}
              onReplay={noop}
              onSeek={noop}
            />
          </MessageBubble>
        </div>
      </main>
      <BottomTabBar />
    </div>
  );
}
