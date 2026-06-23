import { useRef, useState } from "react";
import { Controls } from "@/components/Controls";
import { InlineAudioPlayer } from "@/components/InlineAudioPlayer";
import { MessageBubble } from "@/components/MessageBubble";
import { SpeedPill } from "@/components/SpeedPill";
import { StatusIndicator } from "@/components/StatusIndicator";
import { StatusVisual } from "@/components/StatusVisual";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { deriveStatus, type StatusInputs } from "@/lib/status";

// Living style guide. Documents every design token and every component state.
// Reachable at /style-guide (or ?style-guide) — see main.tsx.

const COLORS: { name: string; token: string; cls: string; ink?: string }[] = [
  { name: "canvas", token: "#FAF6F1", cls: "bg-canvas" },
  { name: "canvas-deep", token: "#F3ECE3", cls: "bg-canvas-deep" },
  { name: "surface", token: "#FFFFFF", cls: "bg-surface" },
  { name: "hairline", token: "#EFE9E1", cls: "bg-hairline" },
  { name: "ink", token: "#211F33", cls: "bg-ink", ink: "text-white" },
  { name: "ink-soft", token: "#6E6B7E", cls: "bg-ink-soft", ink: "text-white" },
  { name: "ink-faint", token: "#A6A2B4", cls: "bg-ink-faint", ink: "text-white" },
  { name: "coral", token: "#FB7A45", cls: "bg-coral", ink: "text-white" },
  { name: "coral-soft", token: "#FFE9DC", cls: "bg-coral-soft" },
  { name: "violet", token: "#8E7DF0", cls: "bg-violet", ink: "text-white" },
  { name: "violet-soft", token: "#ECE7FB", cls: "bg-violet-soft" },
  { name: "success", token: "#2FBF6C", cls: "bg-success", ink: "text-white" },
  { name: "danger", token: "#FF4438", cls: "bg-danger", ink: "text-white" }
];

const RADII = [
  { name: "control", token: "16px", cls: "rounded-control" },
  { name: "bubble", token: "20px", cls: "rounded-bubble" },
  { name: "card", token: "28px", cls: "rounded-card" },
  { name: "full", token: "9999px", cls: "rounded-full" }
];

const SHADOWS = [
  { name: "shadow-soft", cls: "shadow-soft" },
  { name: "shadow-card", cls: "shadow-card" },
  { name: "shadow-lift", cls: "shadow-lift" },
  { name: "shadow-mic", cls: "shadow-mic" }
];

// Fixed clock so the time-graded offline cases render reproducibly.
const STYLE_NOW = 1_700_000_000_000;

function makeStatus(over: Partial<StatusInputs>) {
  return deriveStatus({
    connected: true,
    daemonConnected: true,
    daemonLastSeenAt: null,
    now: STYLE_NOW,
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

const STATUS_CASES = [
  { label: "connecting", status: makeStatus({ connected: false }), elapsed: 0 },
  { label: "waiting-for-daemon", status: makeStatus({ daemonConnected: false }), elapsed: 0 },
  {
    label: "reconnecting",
    status: makeStatus({ daemonConnected: false, daemonLastSeenAt: STYLE_NOW - 5_000 }),
    elapsed: 0
  },
  {
    label: "session-offline",
    status: makeStatus({ daemonConnected: false, daemonLastSeenAt: STYLE_NOW - 14 * 60 * 60 * 1000 }),
    elapsed: 0
  },
  { label: "ready (idle)", status: makeStatus({}), elapsed: 0 },
  { label: "recording", status: makeStatus({ recording: true }), elapsed: 0 },
  { label: "sending", status: makeStatus({ transcribing: true }), elapsed: 0 },
  {
    label: "working",
    status: makeStatus({ runtimeState: "working", currentTask: "Analyzing codebase" }),
    elapsed: 158
  },
  { label: "speaking", status: makeStatus({ speaking: true }), elapsed: 0 }
];

const VISUAL_CASES = [
  { label: "connecting", status: makeStatus({ connected: false }) },
  { label: "ready (idle)", status: makeStatus({}) },
  { label: "working", status: makeStatus({ runtimeState: "working" }) },
  { label: "speaking", status: makeStatus({ speaking: true }) }
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}

export function StyleGuide() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(28);
  const noop = () => {};

  return (
    <div className="min-h-full bg-canvas pb-16">
      <div className="mx-auto flex max-w-md flex-col gap-10 px-5 py-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight text-ink">Voice Control — Style Guide</h1>
          <p className="text-sm text-ink-soft">
            Warm, light, premium voice-assistant system. Coral + violet on cream. All values are tokens.
          </p>
        </header>

        <Section title="Color">
          <div className="grid grid-cols-3 gap-2">
            {COLORS.map((c) => (
              <div key={c.name} className="overflow-hidden rounded-control shadow-soft">
                <div className={`flex h-16 items-end p-2 ${c.cls} ${c.ink ?? "text-ink"}`}>
                  <span className="text-[11px] font-semibold">{c.name}</span>
                </div>
                <div className="bg-surface px-2 py-1 text-[10px] tabular-nums text-ink-faint">{c.token}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Radius">
          <div className="flex flex-wrap gap-3">
            {RADII.map((r) => (
              <div key={r.name} className="flex flex-col items-center gap-1">
                <div className={`size-16 bg-violet-soft ${r.cls}`} />
                <span className="text-[11px] text-ink-soft">{r.name}</span>
                <span className="text-[10px] text-ink-faint">{r.token}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Elevation">
          <div className="flex flex-wrap gap-4">
            {SHADOWS.map((s) => (
              <div key={s.name} className="flex flex-col items-center gap-1.5">
                <div className={`size-16 rounded-card bg-surface ${s.cls}`} />
                <span className="text-[11px] text-ink-soft">{s.name}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap gap-2">
            <Button variant="coral" size="md">
              Coral
            </Button>
            <Button variant="surface" size="md">
              Surface
            </Button>
            <Button variant="soft" size="md">
              Soft
            </Button>
            <Button variant="violet" size="md">
              Violet
            </Button>
            <Button variant="danger" size="md">
              Danger
            </Button>
            <Button variant="ghost" size="md">
              Ghost
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="surface" size="icon" aria-label="icon" />
            <Button variant="coral" size="iconSm" aria-label="iconSm" />
            <Button variant="coral" size="fab" aria-label="fab" />
            <SpeedPill label="1.25x" onClick={noop} />
          </div>
        </Section>

        <Section title="Status visual — states">
          <div className="grid grid-cols-2 gap-3">
            {VISUAL_CASES.map((c) => (
              <div key={c.label} className="flex flex-col items-center gap-2 rounded-card bg-canvas-deep/50 p-3">
                <StatusVisual status={c.status} recording={false} visualizerActive={false} canvasRef={canvasRef} />
                <span className="text-[11px] font-medium text-ink-soft">{c.label}</span>
              </div>
            ))}
            <p className="col-span-2 text-center text-[11px] text-ink-faint">
              recording shows the live mic waveform (needs a mic)
            </p>
          </div>
        </Section>

        <Section title="Status indicator — states">
          <div className="flex flex-col gap-5 rounded-card bg-surface p-5 shadow-soft">
            {STATUS_CASES.map((c) => (
              <div
                key={c.label}
                className="flex flex-col items-center gap-1 border-b border-hairline pb-4 last:border-0 last:pb-0"
              >
                <span className="text-[10px] uppercase tracking-widest text-ink-faint">{c.label}</span>
                <StatusIndicator status={c.status} elapsed={c.elapsed} flash={null} />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Controls — idle · working · recording">
          <div className="flex flex-col gap-4">
            {(
              [
                { label: "idle", working: false, recording: false },
                { label: "working", working: true, recording: false },
                { label: "recording", working: false, recording: true }
              ] as const
            ).map((c) => (
              <div key={c.label} className="flex flex-col gap-2 rounded-card bg-surface p-5 shadow-soft">
                <span className="text-[10px] uppercase tracking-widest text-ink-faint">{c.label}</span>
                <Controls
                  working={c.working}
                  recording={c.recording}
                  speedLabel="1.25x"
                  onCycleSpeed={noop}
                  onMic={noop}
                  onSteer={noop}
                  onInterrupt={noop}
                  onStopRecording={noop}
                  onCancel={noop}
                  onStopTask={noop}
                />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Inline audio player">
          <div className="rounded-bubble bg-violet-soft p-4">
            <InlineAudioPlayer
              playing={playing}
              loaded
              position={pos}
              duration={64}
              onPlayPause={() => setPlaying((p) => !p)}
              onReplay={() => setPos(0)}
              onSeek={setPos}
            />
          </div>
        </Section>

        <Section title="Message bubbles">
          <div className="flex flex-col gap-4">
            <MessageBubble
              side="user"
              body="Please add a retry mechanism for failed webhook deliveries."
              time="12:32 AM"
              delivery="logged"
            />
            <MessageBubble
              side="agent"
              body="I'll implement an exponential backoff retry for failed webhook deliveries with proper logging."
              time="12:33 AM"
            >
              <InlineAudioPlayer
                playing={false}
                loaded={false}
                position={0}
                duration={64}
                onPlayPause={noop}
                onReplay={noop}
                onSeek={noop}
              />
            </MessageBubble>
          </div>
        </Section>

        <Section title="App bar">
          <div className="overflow-hidden rounded-card bg-canvas shadow-soft">
            <TopBar />
          </div>
        </Section>
      </div>
    </div>
  );
}
