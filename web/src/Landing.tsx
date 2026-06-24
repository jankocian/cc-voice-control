import {
  ArrowRightIcon,
  CheckIcon,
  CircleCheckIcon,
  CloudIcon,
  CopyIcon,
  DownloadIcon,
  KeyRoundIcon,
  LayersIcon,
  LockIcon,
  MessageSquareIcon,
  MicIcon,
  PlayIcon,
  RadioIcon,
  ScrollTextIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  SparklesIcon,
  TerminalIcon,
  Volume2Icon,
  ZapIcon
} from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The public marketing landing page, served at the Worker root (voice-control.nee.rs/).
// It's a route in this same SPA (main.tsx → pathname "/"), so it reuses the one design
// system — the tokens + components in index.css — rather than a second stylesheet.
// Composition follows the Strawberry design language: cream canvas, ink pill CTAs, coral
// used only as punctuation, broad rounded cream cards, gentle motion.

const REPO_URL = "https://github.com/jankocian/cc-voice-control";
const CMUX_URL = "https://github.com/manaflow-ai/cmux";
const CONFIG_URL = "https://github.com/jankocian/cc-voice-control/blob/main/docs/configuration.md";

const INSTALL_CMD = `/plugin marketplace add jankocian/cc-voice-control
/plugin install voice-control@cc-voice-control`;

// Drop a YouTube (use the privacy-friendly youtube-nocookie.com/embed/<id>) or Vimeo
// (player.vimeo.com/video/<id>) embed URL here to swap the placeholder for the real video.
// The landing-page CSP already allows those two frame sources (worker/src/session-assets.ts).
const DEMO_VIDEO_URL = "";

export function Landing() {
  // The base stylesheet locks the body to the viewport (overflow:hidden, 100dvh) for the phone
  // app's pinned-hero scrolling. A marketing page wants normal document scroll, so relax it here.
  useEffect(() => {
    const { documentElement: html, body } = document;
    const prev = { htmlH: html.style.height, bodyH: body.style.height, bodyO: body.style.overflow };
    html.style.scrollBehavior = "smooth";
    html.style.height = "auto";
    body.style.height = "auto";
    body.style.overflow = "visible";
    return () => {
      html.style.scrollBehavior = "";
      html.style.height = prev.htmlH;
      body.style.height = prev.bodyH;
      body.style.overflow = prev.bodyO;
    };
  }, []);

  return (
    <div className="min-h-dvh overflow-x-hidden bg-canvas text-ink">
      <Nav />
      <main>
        <Hero />
        <Benefits />
        <Steps />
        <Features />
        <Demo />
        <HowItWorks />
        <Requirements />
        <Security />
        <Faqs />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

/* ---------------------------------------------------------------- nav ---- */

function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-hairline/70 bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
        <Wordmark />
        <nav className="hidden items-center gap-1 sm:flex">
          <NavLink href="#features">Features</NavLink>
          <NavLink href="#how">How it works</NavLink>
          <NavLink href="#install">Install</NavLink>
          <NavLink href="#security">Security</NavLink>
        </nav>
        <a href={REPO_URL} className={cn(buttonVariants({ variant: "surface", size: "pill" }), "gap-2")}>
          <GithubMark className="size-4" />
          GitHub
        </a>
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="rounded-full px-3 py-2 text-sm text-ink-soft transition-colors hover:bg-canvas-deep hover:text-ink"
    >
      {children}
    </a>
  );
}

function Wordmark() {
  return (
    <a href="/" className="flex items-center gap-2 font-semibold tracking-tight text-ink">
      <span className="grid size-7 place-items-center rounded-full bg-coral text-white shadow-mic">
        <RadioIcon className="size-4" />
      </span>
      voice-control
    </a>
  );
}

/* --------------------------------------------------------------- hero ---- */

function Hero() {
  return (
    <section className="relative overflow-hidden bg-[radial-gradient(70%_55%_at_50%_-5%,var(--color-coral-soft)_0%,transparent_60%)]">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-7 px-6 pt-20 pb-16 text-center sm:pt-28">
        <span className="inline-flex items-center gap-2 rounded-full border border-hairline bg-surface/80 px-3.5 py-1.5 text-xs font-medium text-ink-soft shadow-soft">
          <span className="size-1.5 rounded-full bg-coral" />
          Open source · for Claude Code + cmux
        </span>

        <h1 className="text-4xl leading-[1.05] font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
          A walkie-talkie for Claude&nbsp;Code in your cmux terminal.
        </h1>

        <p className="max-w-xl text-lg leading-relaxed text-ink-soft text-pretty">
          Voice-control your <strong className="font-medium text-ink">real, live Claude Code session</strong> from your
          phone. Hold to talk — your words get typed straight into your session, and Claude's reply is read back to you.
          End-to-end encrypted, on your normal subscription, with no extra API bill.
        </p>

        <div className="w-full max-w-xl">
          <p className="mb-2 text-left text-xs font-medium tracking-wide text-ink-faint uppercase">
            Paste into Claude Code
          </p>
          <CommandBlock />
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <a href={REPO_URL} className={cn(buttonVariants({ variant: "coral", size: "lg" }), "gap-2")}>
            <GithubMark className="size-5" />
            View on GitHub
          </a>
          <a href="#how" className={cn(buttonVariants({ variant: "surface", size: "lg" }), "gap-2")}>
            How it works
            <ArrowRightIcon className="size-4" />
          </a>
        </div>
      </div>
    </section>
  );
}

// The copyable, terminal-styled install command — the page's primary action.
function CommandBlock() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(INSTALL_CMD).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="overflow-hidden rounded-card border border-hairline bg-surface text-left shadow-card">
      <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs font-medium text-ink-faint">
          <TerminalIcon className="size-3.5" />
          Claude Code
        </span>
        <Button variant="ghost" size="sm" onClick={copy} className="gap-1.5 px-2 text-xs">
          {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-relaxed whitespace-pre text-ink">
        {INSTALL_CMD.split("\n").map((line) => (
          <div key={line}>
            <span className="select-none text-coral">/</span>
            {line.slice(1)}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- benefits ---- */

const BENEFITS: { icon: IconType; title: string; body: string }[] = [
  {
    icon: ZapIcon,
    title: "Your real session — not a clone",
    body: "Your words land as a genuine user message in your live Claude Code, composing with your skills, subagents and hooks. No separate API turn, no hijack."
  },
  {
    icon: CircleCheckIcon,
    title: "On your plan, not metered API",
    body: "Claude runs in your interactive session, so usage counts against your Claude subscription — not pay-per-token API billing."
  },
  {
    icon: LockIcon,
    title: "End-to-end encrypted",
    body: "Your prompts, replies and audio are encrypted on your phone and only unlocked on your machine. The bridge in the middle relays sealed messages it can't read."
  }
];

function Benefits() {
  return (
    <Section>
      <div className="grid gap-4 sm:grid-cols-3">
        {BENEFITS.map((b) => (
          <article key={b.title} className="flex flex-col gap-3 rounded-card bg-canvas-deep p-6 shadow-soft">
            <IconChip icon={b.icon} />
            <h3 className="text-base font-semibold tracking-tight">{b.title}</h3>
            <p className="text-sm leading-relaxed text-ink-soft">{b.body}</p>
          </article>
        ))}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------- steps ---- */

const STEPS: { icon: IconType; title: string; body: ReactNode }[] = [
  {
    icon: DownloadIcon,
    title: "Install the plugin",
    body: "Paste the two commands above into Claude Code. The daemon ships pre-built — there's no build step on install."
  },
  {
    icon: KeyRoundIcon,
    title: "Add your OpenAI key",
    body: (
      <>
        Drop your key into the plugin's config — it powers transcription and the spoken replies, and never leaves your
        machine.
        <code className="mt-2 block w-fit rounded-control bg-canvas-deep px-2.5 py-1 font-mono text-xs text-ink">
          {'{ "openaiApiKey": "sk-…" }'}
        </code>
      </>
    )
  },
  {
    icon: MicIcon,
    title: "Start talking",
    body: (
      <>
        Run <code className="font-mono text-coral-ink">/voice-control:start</code>, scan the QR with your phone (add it
        to your home screen for one tap), and hold to talk. Claude's reply is read back aloud.
      </>
    )
  }
];

function Steps() {
  return (
    <Section id="install" title="Up and talking in three steps" eyebrow="Get started">
      <ol className="grid gap-4 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="relative flex flex-col gap-3 rounded-card bg-surface p-6 shadow-soft">
            <div className="flex items-center justify-between">
              <IconChip icon={s.icon} />
              <span className="font-mono text-2xl font-semibold tracking-tight text-ink-faint/60">{i + 1}</span>
            </div>
            <h3 className="text-base font-semibold tracking-tight">{s.title}</h3>
            <p className="text-sm leading-relaxed text-ink-soft">{s.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* ----------------------------------------------------------- features ---- */

const FEATURES: { icon: IconType; tone: "coral" | "violet"; title: string; body: string }[] = [
  {
    icon: RadioIcon,
    tone: "coral",
    title: "Hands-free mode",
    body: "Flip on Auto-respond and the mic reopens the moment a reply finishes — a real back-and-forth, no tapping. Pace around, do the dishes, keep coding."
  },
  {
    icon: SmartphoneIcon,
    tone: "violet",
    title: "Install it like an app",
    body: "Add it to your home screen and it opens full-screen, like a native app — no app store, no download."
  },
  {
    icon: Volume2Icon,
    tone: "coral",
    title: "Hear replies your way",
    body: "Autoplay the final reply, narrate every step, or stay silent and tap any message to listen. Speed it up too."
  },
  {
    icon: MessageSquareIcon,
    tone: "violet",
    title: "Answer by voice",
    body: "When Claude asks a multiple-choice question, it's read aloud — just say which option you want and it's picked for you."
  },
  {
    icon: ScrollTextIcon,
    tone: "coral",
    title: "Live transcript",
    body: "Watch your message land and Claude's steps stream in the instant they happen — so you always know where things stand."
  },
  {
    icon: LayersIcon,
    tone: "violet",
    title: "Many sessions, one phone",
    body: "Run voice on several panes at once and swipe between them on your phone. New replies can pull you to whichever just answered."
  }
];

function Features() {
  return (
    <Section id="features" title="Built for an actual conversation" eyebrow="Features">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <article key={f.title} className="flex flex-col gap-3 rounded-card bg-surface p-6 shadow-soft">
            <IconChip icon={f.icon} tone={f.tone} />
            <h3 className="text-base font-semibold tracking-tight">{f.title}</h3>
            <p className="text-sm leading-relaxed text-ink-soft">{f.body}</p>
          </article>
        ))}
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------- demo ---- */

function Demo() {
  return (
    <Section id="demo" title="See it in action" eyebrow="Demo">
      {DEMO_VIDEO_URL ? (
        <iframe
          src={DEMO_VIDEO_URL}
          title="voice-control demo"
          className="aspect-video w-full rounded-card border border-hairline shadow-card"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      ) : (
        <div className="grid aspect-video w-full place-items-center rounded-card border border-dashed border-ink-faint/30 bg-canvas-deep">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="grid size-16 place-items-center rounded-full bg-coral text-white shadow-mic">
              <PlayIcon className="size-7 translate-x-0.5 fill-current" />
            </span>
            <p className="text-sm font-medium text-ink-soft">Demo video coming soon</p>
            <p className="max-w-xs text-xs text-ink-faint">
              A 60-second walkthrough of talking to Claude Code hands-free.
            </p>
          </div>
        </div>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------- how it works ---- */

const FLOW: { icon: IconType; tone: "coral" | "violet"; title: string; body: string; edge?: string }[] = [
  {
    icon: SmartphoneIcon,
    tone: "coral",
    title: "Your phone",
    body: "A push-to-talk web page. Loads no third-party code; audio is captured with MediaRecorder.",
    edge: "① your voice, as audio"
  },
  {
    icon: CloudIcon,
    tone: "violet",
    title: "Cloudflare bridge",
    body: "A relay (Worker + Durable Object) that only ever sees sealed, end-to-end-encrypted messages — it can't read your prompts, replies or audio.",
    edge: "end-to-end encrypted, over a WebSocket"
  },
  {
    icon: ServerCogIcon,
    tone: "coral",
    title: "Local daemon",
    body: "Runs as a child of Claude Code, so it keeps cmux's trust. ② OpenAI speech-to-text, then cmux send types the transcript into your live pane.",
    edge: "as a genuine user message"
  },
  {
    icon: SparklesIcon,
    tone: "violet",
    title: "Claude Code",
    body: "Runs the turn in your real session — composing with skills, subagents and hooks, on your subscription.",
    edge: "③ Stop hook → OpenAI text-to-speech"
  },
  {
    icon: MicIcon,
    tone: "coral",
    title: "…spoken back to your phone",
    body: "The reply is read aloud on the same page — so you can keep your hands on the keyboard, or off it entirely."
  }
];

function HowItWorks() {
  return (
    <Section id="how" title="How it works" eyebrow="Architecture">
      <p className="mb-8 max-w-2xl text-base leading-relaxed text-ink-soft">
        Three small, auditable pieces. The phone captures your voice, an encrypted relay forwards it, and a local daemon
        — running inside Claude Code's own process tree — transcribes it and types it into your pane. When the turn
        ends, a <code className="font-mono text-coral-ink">Stop</code> hook sends the reply back to be spoken.
        Everything that crosses the bridge is end-to-end encrypted, and your OpenAI key never leaves your machine.
      </p>
      <div className="mx-auto flex max-w-xl flex-col items-stretch">
        {FLOW.map((node) => (
          <div key={node.title}>
            <article className="flex items-start gap-4 rounded-card bg-surface p-5 shadow-soft">
              <IconChip icon={node.icon} tone={node.tone} />
              <div className="flex flex-col gap-1">
                <h3 className="text-base font-semibold tracking-tight">{node.title}</h3>
                <p className="text-sm leading-relaxed text-ink-soft">{node.body}</p>
              </div>
            </article>
            {node.edge && <FlowEdge label={node.edge} />}
          </div>
        ))}
      </div>
    </Section>
  );
}

function FlowEdge({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-2.5 text-ink-faint" aria-hidden>
      <span className="text-xs font-medium">{label}</span>
      <ArrowRightIcon className="size-3.5 rotate-90" />
    </div>
  );
}

/* ------------------------------------------------------- requirements ---- */

const REQUIREMENTS: { icon: IconType; title: string; body: ReactNode }[] = [
  {
    icon: TerminalIcon,
    title: "cmux",
    body: (
      <>
        Claude Code must run inside{" "}
        <a href={CMUX_URL} className="font-medium text-coral-ink underline-offset-2 hover:underline">
          cmux
        </a>
        — injection uses cmux's <code className="font-mono text-xs">send</code> /{" "}
        <code className="font-mono text-xs">send-key</code> CLI.
      </>
    )
  },
  {
    icon: SparklesIcon,
    title: "Claude Code + the plugin",
    body: "The voice-control plugin loaded in your Claude Code session."
  },
  {
    icon: KeyRoundIcon,
    title: "An OpenAI API key",
    body: "Used locally for speech-to-text and text-to-speech. It never leaves your machine."
  }
];

function Requirements() {
  return (
    <Section title="What you'll need" eyebrow="Requirements">
      <div className="rounded-card bg-canvas-deep p-6 shadow-soft sm:p-8">
        <ul className="grid gap-5 sm:grid-cols-3">
          {REQUIREMENTS.map((r) => (
            <li key={r.title} className="flex flex-col gap-2">
              <div className="flex items-center gap-2.5">
                <IconChip icon={r.icon} size="sm" />
                <h3 className="text-sm font-semibold tracking-tight">{r.title}</h3>
              </div>
              <p className="text-sm leading-relaxed text-ink-soft">{r.body}</p>
            </li>
          ))}
        </ul>
        <p className="mt-6 border-t border-hairline pt-4 text-xs text-ink-faint">
          A reachable bridge is also needed — it defaults to the public{" "}
          <code className="font-mono">voice-control.nee.rs</code>, or self-host the Worker. Today voice-control supports
          Claude Code in cmux; more terminals and agents may follow.
        </p>
      </div>
    </Section>
  );
}

/* ----------------------------------------------------------- security ---- */

const SECURITY: { icon: IconType; title: string; body: string }[] = [
  {
    icon: ShieldCheckIcon,
    title: "End-to-end encrypted",
    body: "Your phone and your machine derive a shared key from the session secret — which lives in the link's fragment and never reaches the server. Prompts, replies, audio, even the repo name are encrypted; the bridge only relays ciphertext."
  },
  {
    icon: LockIcon,
    title: "A leaked link is useless",
    body: "The first device to open the link pairs with it — once. After that the URL is dead, so a screenshot or forwarded link can't join your session. The session is also wiped soon after your last pane disconnects."
  },
  {
    icon: KeyRoundIcon,
    title: "Your OpenAI key stays local",
    body: "Only the local daemon reads your key and calls OpenAI for speech-to-text and text-to-speech. It never touches the bridge or your phone."
  },
  {
    icon: CircleCheckIcon,
    title: "Small and open, by design",
    body: "The phone page loads no third-party code, and the whole project is open source and deliberately tiny — so you (or anyone) can read every line."
  }
];

function Security() {
  return (
    <Section id="security" title="Small on purpose — so you can audit it" eyebrow="Security">
      <div className="grid gap-4 sm:grid-cols-2">
        {SECURITY.map((s) => (
          <article key={s.title} className="flex items-start gap-4 rounded-card bg-surface p-6 shadow-soft">
            <IconChip icon={s.icon} />
            <div className="flex flex-col gap-1.5">
              <h3 className="text-base font-semibold tracking-tight">{s.title}</h3>
              <p className="text-sm leading-relaxed text-ink-soft">{s.body}</p>
            </div>
          </article>
        ))}
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- faq ---- */

const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: "Who's it for?",
    a: "Anyone who lives in Claude Code and wants to step away from the keyboard — kick off a task from the couch, keep it moving while you make coffee, or just rest your hands. If you can run Claude Code, you can use this."
  },
  {
    q: "Does this use my Claude API credits?",
    a: "No. Claude runs in your normal interactive session, so it counts against your Claude plan — not metered API billing. Only OpenAI's speech-to-text and text-to-speech use the API, billed to your own OpenAI key."
  },
  {
    q: "Can whoever runs the bridge read my code?",
    a: "No. Everything between your phone and your machine is end-to-end encrypted, and the secret that unlocks it never reaches the server. The bridge only ever relays sealed messages it can't open."
  },
  {
    q: "Is the link dangerous if someone gets it?",
    a: "Not really. The first device to open the link pairs with it — a single use — and after that the link is dead, so a screenshot or forwarded URL can't get in. The session is also wiped soon after your last pane disconnects, and /voice-control:stop kills it instantly."
  },
  {
    q: "Do I need cmux?",
    a: "Yes, for now. Typing into your live session relies on cmux's send / send-key CLI. Support for more terminals and coding agents may come later."
  },
  {
    q: "What does it cost?",
    a: "The plugin is free and open source (MIT). You only pay for your own OpenAI usage (speech-to-text + text-to-speech)."
  }
];

function Faqs() {
  return (
    <Section title="Questions" eyebrow="FAQ">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        {FAQS.map((f) => (
          <details key={f.q} className="group rounded-card bg-surface px-5 py-4 shadow-soft">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium tracking-tight">
              {f.q}
              <ArrowRightIcon className="size-4 shrink-0 text-ink-faint transition-transform group-open:rotate-90" />
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">{f.a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------- final cta ---- */

function FinalCta() {
  return (
    <Section>
      <div className="flex flex-col items-center gap-6 rounded-card bg-ink px-6 py-14 text-center text-canvas">
        <h2 className="max-w-lg text-3xl font-medium tracking-tight text-balance sm:text-4xl">
          Talk to your terminal.
        </h2>
        <p className="max-w-md text-base text-canvas/70">
          Install the plugin, add your OpenAI key, and run <code className="font-mono">/voice-control:start</code>.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <a href={REPO_URL} className={cn(buttonVariants({ variant: "coral", size: "lg" }), "gap-2")}>
            <GithubMark className="size-5" />
            Get it on GitHub
          </a>
          <a
            href={CONFIG_URL}
            className={cn(
              "inline-flex h-13 items-center justify-center gap-2 rounded-control border border-canvas/25 px-6 text-base font-medium text-canvas transition-colors hover:bg-canvas/10"
            )}
          >
            Read the docs
            <ArrowRightIcon className="size-4" />
          </a>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------- footer ---- */

function Footer() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <Wordmark />
          <p className="text-xs text-ink-faint">A walkie-talkie for Claude Code in your cmux terminal.</p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-soft">
          <a href={REPO_URL} className="hover:text-ink">
            GitHub
          </a>
          <a href={CMUX_URL} className="hover:text-ink">
            cmux
          </a>
          <a href={CONFIG_URL} className="hover:text-ink">
            Docs
          </a>
          <a href="#security" className="hover:text-ink">
            Security
          </a>
        </nav>
      </div>
      <div className="border-t border-hairline">
        <p className="mx-auto max-w-5xl px-6 py-4 text-xs text-ink-faint">
          © 2026 voice-control · MIT · Built for Claude Code + cmux.
        </p>
      </div>
    </footer>
  );
}

/* -------------------------------------------------------- primitives ---- */

type IconType = ComponentType<{ className?: string }>;

function Section({
  id,
  title,
  eyebrow,
  children
}: {
  id?: string;
  title?: string;
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mx-auto max-w-5xl scroll-mt-24 px-6 py-14 sm:py-20">
      {(title || eyebrow) && (
        <div className="mb-8 flex flex-col gap-2">
          {eyebrow && (
            <span className="flex items-center gap-2 text-xs font-semibold tracking-widest text-coral uppercase">
              <span className="size-1 rotate-45 bg-coral" />
              {eyebrow}
            </span>
          )}
          {title && <h2 className="text-2xl font-medium tracking-tight text-balance sm:text-3xl">{title}</h2>}
        </div>
      )}
      {children}
    </section>
  );
}

function IconChip({
  icon: Icon,
  tone = "coral",
  size = "md"
}: {
  icon: IconType;
  tone?: "coral" | "violet";
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full",
        size === "sm" ? "size-9" : "size-11",
        tone === "coral" ? "bg-coral-soft text-coral-ink" : "bg-violet-soft text-violet-ink"
      )}
    >
      <Icon className={size === "sm" ? "size-4" : "size-5"} />
    </span>
  );
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
