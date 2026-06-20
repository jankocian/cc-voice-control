# Research: `/btw` side questions for non-interrupting status/summary (TODO #5)

**Status:** research only — no code changed.
**Date:** 2026-06-20.
**Worktree/branch:** `cc-voice-control-research-5` / `research/btw-side-questions`.
**Scope:** can the voice remote answer the phone's **Get Status** / **Get Summary** while a
task is already running by sending Claude Code's native **`/btw <question>`** into the live
pane — running *independently* of the main turn — **and still capture the answer to TTS it
back over the voice channel**?

---

## TL;DR — VERDICT

**NO — not feasible with the current architecture (Stop hook → transcript JSONL).**

A `/btw` answer is, by Claude Code's own documentation, **ephemeral**: it renders in a
*dismissible overlay* and **"never enter[s] the conversation history."** The voice remote's
entire reply-capture path is the plugin **`Stop` hook** (`hooks/stop-notify.mjs`) reading the
**transcript JSONL** that `transcript_path` points at. The hooks documentation **never
mentions `/btw`, side questions, ephemeral answers, or overlays** — the `Stop` hook fires
"when Claude finishes responding" (the *main* turn). The only documented ways to get a `/btw`
answer out are **interactive-terminal-only** (`c` = copy to clipboard, `f` = fork into a new
session), **neither of which the daemon can drive or read** through `cmux send` / a hook.

So the very property that makes `/btw` attractive — it stays *out of history and independent
of the main turn* — is exactly what makes it **uncapturable** by our Stop-hook/transcript
mechanism. We could *send* `/btw <q>` into the pane, but we would have **no programmatic way
to retrieve the answer** to speak it.

Two points are **doc-silent** and worth a 2-minute live check before this is filed as a hard
NO (see the Test Plan): (1) whether `/btw` writes *anything* to the transcript JSONL, and
(2) whether `/btw` fires *any* hook. The documentation strongly implies "no" to both, but
neither is stated in so many words. **The single thing to verify live is whether the
transcript JSONL file grows when you run `/btw` while a turn is in flight.** If it does not
grow (expected), the NO stands.

**Recommendation:** keep today's **normal-prompt** approach for Get Status / Get Summary
(it already works and is fully capturable), and *improve* it — accept that we lose `/btw`'s
non-interrupting property. See [Best alternative](#best-alternative).

---

## How replies are captured today (the mechanism `/btw` must satisfy)

The capture path has exactly one channel, and it is the transcript:

1. **Inject.** Daemon types the prompt into the live cmux pane as a *real user message* via
   `cmuxSubmit` → `cmux send -- <text>` then `cmux send-key enter`
   (`src/daemon/cmux.ts:112-120`). It tracks the exact text as `inFlight`
   (`src/daemon/voice-daemon.ts:338`).
2. **Claude answers** in the normal turn → the assistant message is written to the session
   **transcript JSONL**.
3. **`Stop` hook fires** when the turn ends. `hooks/stop-notify.mjs` reads
   `hook.transcript_path`, scans the JSONL for the last real user prompt and the terminal
   assistant message (`stop_reason !== "tool_use"`), and **HTTP-POSTs `{prompt, text}`** to
   the daemon's `127.0.0.1:<port>/reply` (`hooks/stop-notify.mjs:36-39`, `99-131`, `160-180`).
4. **Daemon speaks it** — but *only if* the posted `prompt` equals the `inFlight` text it
   injected (`voice-daemon.ts:383-384`); otherwise it stays silent. Then OpenAI TTS → phone
   (`voice-daemon.ts:404-414`).

**Everything hinges on the answer landing in the transcript JSONL and the `Stop` hook
firing.** The `hooks.json` registers exactly one hook — `Stop` — and nothing else
(`hooks/hooks.json`). There is no other capture channel (the MCP server is only the host
process; replies do **not** flow through MCP — see TODO #6's in-code note).

### Today's status/summary (for contrast) — already works, but interrupts/queues

`status_request` / `summary_request` are handled by **enqueuing a normal prompt**:

```ts
// src/daemon/voice-daemon.ts:271-275
case "status_request":
  this.enqueue("Give me a brief spoken status of what you're doing right now.");
  return;
case "summary_request":
  this.enqueue("Briefly summarize what you've done so far, for the phone.");
  return;
```

`enqueue` → `pump` → `cmuxSubmit` — i.e. it goes through the **same** real-user-message path
as any turn. So today it **does** hit the transcript + `Stop` hook and **is** captured and
spoken. The only downside is that it is a normal turn: it **queues behind or interrupts** the
running task (the daemon serializes one `inFlight` turn at a time, `voice-daemon.ts:334-338`).
That is precisely the limitation TODO #5 wanted `/btw` to remove — at the cost, it turns out,
of capturability.

---

## The three questions, answered from the docs

### 1. Does a `/btw` answer get written to the transcript JSONL?

**Documented behavior: ephemeral, out of conversation history. Direct JSONL persistence:
doc-silent, but strongly implied "no".**

> "The question and answer are ephemeral: they appear in a dismissible overlay and **never
> enter the conversation history**."
> — Interactive mode › *Side questions with /btw*
> (https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw)

> "Earlier side questions from the same session appear as a dimmed list above the current
> answer; **they stay out of the conversation history** but remain visible in the overlay
> until you clear them."
> — same page.

The docs describe `/btw` as living entirely in an overlay and explicitly *out of* the
conversation history. They do **not** make a separate statement about the **transcript JSONL
file** specifically (the file `transcript_path` points at). It is *possible* Claude Code logs
side-question Q&A to the JSONL with some non-conversation marker, but the docs give **no
indication** that it does, and the `f` ("fork") affordance below is strong negative evidence.

**Strong negative evidence — the `f` (fork) key:**

> "`f` — Fork into a new session. The fork inherits the parent conversation **plus this
> question and answer as real transcript turns**, so you can continue with full tool access."
> — same page.

The fact that forking is what *promotes* the Q&A into "**real transcript turns**" tells us
that, in the original session, the `/btw` Q&A is **not** real transcript turns. If it were
already in the transcript, "fork to make them real transcript turns" would be meaningless.
This is the clearest signal that **a `/btw` answer is not in the transcript the `Stop` hook
reads.**

### 2. Does `/btw` fire the `Stop` hook (or ANY hook)?

**Doc-silent on `/btw` specifically; the `Stop` hook is defined for the *main* turn, and the
hooks docs never mention side questions at all → expected answer: NO hook fires for `/btw`.**

- The `Stop` hook trigger is documented only as **"When Claude finishes responding"**
  (https://code.claude.com/docs/en/hooks). `/btw` is documented as running **"independently"**
  and **"does not interrupt the main turn"** — it is a side answer, not "Claude finishing
  responding" to the main turn.
- A full-text search of the hooks reference for **`btw` / `side question` / `ephemeral` /
  `overlay`** returns **nothing** — none of these terms appear anywhere in the hooks docs
  (verified via fetch of https://code.claude.com/docs/en/hooks).
- No hook event in the documented list (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `Stop`, `SubagentStop`, `Notification`, …) is described as firing for an overlay/side
  answer.

So there is **no documented hook** — neither `Stop` nor any other — tied to a `/btw` answer.
If `/btw` fired no hook *and* wrote no transcript, the daemon has **no event to react to and
no file to read**: it would never know the answer exists, let alone its text.

**Stop-hook input fields (for completeness)** — the `Stop` hook receives the common fields
`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, plus
`stop_hook_active` (https://code.claude.com/docs/en/hooks). **No documented field marks a
turn as a side-question turn** — consistent with `/btw` not producing a `Stop` event at all.

### 3. Is there ANY programmatic path to (a) trigger `/btw` and (b) capture the answer?

**(a) Trigger — YES, plausibly.** `/btw` is an ordinary slash command typed into the prompt
input (`/btw what was the name of that config file again?`) and submitted with Enter
(https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw). Our `cmuxSubmit`
already types arbitrary text and presses Enter (`src/daemon/cmux.ts:112-120`), so sending the
literal string `/btw <question>` followed by Enter should invoke it the same as a human typing
it. (This wants a live confirmation — see Test Plan — because slash-command parsing on
injected input is not documented.)

**(b) Capture — NO documented path.** Every documented way to extract a `/btw` answer is
**interactive-terminal-only and not machine-readable from the daemon**:

- **`c` — copy to clipboard** as raw Markdown. The daemon could *technically* read the macOS
  clipboard (`pbpaste`) after sending `c`, but (i) it cannot reliably know *when* the overlay
  is showing and the answer is ready to copy, (ii) sending the `c` keystroke requires the
  overlay to have focus — a fragile, racy TUI-state dependency we do not control, (iii) it
  would clobber the user's real clipboard, and (iv) cmux delivers keystrokes to the pane but
  there is **no documented guarantee** that a bare `c` is interpreted as the overlay's
  "copy" action vs. literal input. This is a brittle screen-scrape, not a supported API.
- **`f` — fork into a new session.** Forking *does* promote the Q&A into real transcript
  turns — but **in a brand-new forked session**, "available in local sessions only", with its
  own transcript and its own pane. Our daemon is bound to the *original* pane/surface
  (`CMUX_SURFACE_ID`); it has no handle on the fork's pane or transcript path, and a fork
  defeats the entire purpose (we wanted a quick non-disruptive status, not to fork the
  session). Not viable.
- **Read the overlay off-screen** (`cmux read-screen`): the daemon *can* read pane screen
  text (it already does for liveness, `cmux.ts:103-109`). But the overlay is a transient TUI
  element with unknown framing/wrapping, no stable markers, and it competes with whatever the
  main turn is simultaneously rendering. Parsing free-form TUI output for "the answer" is
  exactly the kind of fragile scrape the project avoids, and there is no documented structure
  to anchor on. Not a sound mechanism.
- **A different hook / side-file / SDK event:** none documented. The hooks reference has no
  side-question event; the interactive-mode page documents no output file or programmatic
  capture for `/btw`. (https://code.claude.com/docs/en/hooks,
  https://code.claude.com/docs/en/interactive-mode)

**Conclusion:** triggering `/btw` is easy; **capturing its answer is the blocker**, and there
is **no supported, robust mechanism** for it. The daemon's only real capture channel is the
transcript-via-Stop-hook, and `/btw` is designed to stay out of exactly that.

---

## Why this is a NO (not just "hard")

The feature's selling point and its disqualifier are the same property:

| `/btw` property (documented) | Consequence for us |
| --- | --- |
| Runs independently, does not interrupt the main turn | The thing we wanted ✅ |
| Answer is ephemeral, **never enters conversation history** | Not in the transcript the Stop hook reads ❌ |
| Forking is what makes it "real transcript turns" | Confirms it is *not* a transcript turn otherwise ❌ |
| No hooks doc mentions side questions at all | No `Stop`/other event to trigger capture ❌ |
| Only exits: `c` (clipboard), `f` (fork) — interactive TUI only | No daemon-drivable, machine-readable capture ❌ |

To make `/btw` capturable we would need Claude Code to expose a programmatic capture surface
(a hook that fires on a side answer, or an output file/SDK event for the overlay). That is an
**upstream feature request**, not something achievable in this plugin today.

---

## Best alternative

**Keep the normal-prompt approach for Get Status / Get Summary, and accept the trade-off:**
we lose `/btw`'s non-interrupting property, but we keep a **reliably capturable** answer. Two
concrete improvements over today, both within the existing architecture:

1. **Make the status/summary prompt explicitly non-disruptive in wording** so that, even
   though it *is* a real turn, Claude treats it as a quick interjection and resumes. Today's
   prompts (`voice-daemon.ts:271-275`) are fine; we could strengthen them, e.g.
   *"In one or two sentences, tell me what you're doing right now, then continue your current
   task."* This does not change that it's a queued/interrupting turn, but it minimizes
   disruption and keeps the reply short for TTS.

2. **Queue vs. interrupt is already a daemon decision** — the daemon serializes turns
   (`inFlight` + `queue`, `voice-daemon.ts:334-338`) and already supports an `interrupt` mode
   for audio (`handleAudio` → `interruptWith`, `voice-daemon.ts:299-323`,
   `interruptWith:374-378`). For Get Status / Get Summary we likely want **enqueue** (current
   behavior — wait for the running turn to reach a natural stop, then answer), *not* interrupt,
   so we don't `Esc` real work. This is already what the code does. Document it as the chosen
   behavior.

**Net:** the honest position is that **"non-interrupting status while busy" and "capturable
over voice" are mutually exclusive with `/btw` today.** Given the project's design rules
(never touch system config; the plugin must work unmodified; capture only via the Stop hook),
the **capturable normal-prompt path is the correct choice**, and TODO #5 should be re-scoped
from *"use `/btw`"* to *"keep the normal-prompt status/summary; revisit `/btw` only if Claude
Code ships a programmatic side-answer capture surface."*

> No other capturable, non-interrupting mechanism is substantiable from the docs. Subagents
> (the documented inverse of `/btw`) *can* run in background and *do* leave a `SubagentStop`
> hook — but a subagent **starts with empty context** and **cannot see the current
> conversation**, so it cannot answer "what are you doing right now / summarize what you've
> done." It is the wrong tool for status/summary. (Interactive mode page: "`/btw` is the
> inverse of a subagent: it sees your full conversation but has no tools, while a subagent has
> full tools but starts with an empty context.")

---

## Live test plan (settle the two doc-silent points)

Run these on a real machine with a live cmux Claude pane. Goal: confirm (T1) that `/btw`
does **not** grow the transcript JSONL, and (T2) that `/btw` fires **no** `Stop` hook. If both
hold (expected), the **NO** verdict is settled. If either surprises (the JSONL grows with a
side-answer record, or a hook fires), re-open the capture question.

**Setup**

```bash
# 1. Start an interactive Claude Code session in a normal terminal (not headless).
claude

# 2. In another terminal, find this session's transcript JSONL. Claude Code stores
#    per-session transcripts under ~/.claude (project-scoped). Identify the newest:
ls -lt ~/.claude/projects/*/*.jsonl | head
TRANSCRIPT="<paste the newest .jsonl path>"

# 3. Record a global Stop-hook tripwire WITHOUT touching the plugin: add a user-level
#    Stop hook that just appends a line+timestamp to a log. (User settings, reversible.)
#    ~/.claude/settings.json  ->  hooks.Stop[].hooks[] = a command like:
#       bash -c 'date +%s >> /tmp/btw-stop-hook.log'
#    (Use /hooks in the session, or edit settings.json, then /hooks to confirm it loaded.)
: > /tmp/btw-stop-hook.log
```

**T1 — does the transcript JSONL grow on `/btw`?**

```bash
# Baseline size/line count:
wc -l "$TRANSCRIPT"; wc -c "$TRANSCRIPT"
```

In the Claude session, kick off a longer task so a turn is *in flight* (e.g. ask it to read
several files / think). **While it is working**, type:

```
/btw what are you doing right now in one sentence?
```

Watch the overlay answer appear. Dismiss it (`Esc`). Then:

```bash
wc -l "$TRANSCRIPT"; wc -c "$TRANSCRIPT"
# Compare to baseline. EXPECTED: unchanged by the /btw Q&A itself (only the main turn's
# own messages may land when IT finishes). If you see a NEW record whose content is the
# /btw question/answer, inspect it:
tail -n 20 "$TRANSCRIPT" | jq -c '{type, role: (.message.role // .type), text: (.message.content)}' 2>/dev/null
```

- **Transcript does NOT contain the `/btw` Q&A → confirms NO.** (Expected.)
- **Transcript DOES contain a `/btw` record → re-open capture:** note its `type`/markers; a
  marked side-answer record *might* be filterable by the Stop hook — but only if T2 also shows
  a hook firing.

**T2 — does `/btw` fire the `Stop` hook?**

```bash
# Immediately after the /btw answer appears AND before the main turn finishes,
# check the tripwire. Then again after the main turn finishes.
cat /tmp/btw-stop-hook.log
```

- **No new line appears at the moment `/btw` answers (only later, when the *main* turn ends)
  → confirms `/btw` fires no Stop hook.** (Expected.) Combined with T1, this is a settled NO.
- **A line appears coincident with the `/btw` answer → a hook fired:** capture which event and
  its `transcript_path`; that would be the path to revisit. (Not expected.)

**T3 (only if you want to probe the brittle clipboard path) — does `c` copy work via cmux?**
With the overlay showing, from the daemon's perspective send the `c` keystroke into the
surface and read the clipboard:

```bash
# Replace <surface> with CMUX_SURFACE_ID. This is exploratory only — even if it works it is
# not a mechanism we'd ship (clipboard clobber + TUI-state race).
cmux send-key --surface <surface> c
pbpaste   # macOS: did the /btw answer text land here?
```

- Even a "yes" here does **not** flip the verdict to feasible — it confirms only that a
  fragile, racy, clipboard-clobbering scrape *might* read the text, which the project's design
  rules reject. Record the result for completeness; do not build on it.

**Cleanup:** remove the temporary `~/.claude/settings.json` Stop tripwire and
`/tmp/btw-stop-hook.log`. (Never leave a test hook in user settings.)

---

## Sources (official Claude Code docs)

- Interactive mode → **Side questions with /btw** (definition; ephemeral overlay; "never enter
  the conversation history"; runs independently/non-interrupting; no tool access; overlay keys
  `c`/`f`/`x`; `f` forks the Q&A into "real transcript turns"; `/btw` is the inverse of a
  subagent): https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw
  (page: https://code.claude.com/docs/en/interactive-mode)
- Hooks reference (`Stop` fires "When Claude finishes responding"; common input fields incl.
  `transcript_path`, `session_id`, `stop_hook_active`; **no** mention of `btw` / side question /
  ephemeral / overlay; no side-answer hook event): https://code.claude.com/docs/en/hooks
- Sub-agents (context: subagents start with empty context; `SubagentStop` exists — but the
  wrong tool for status/summary): https://code.claude.com/docs/en/sub-agents

## In-repo references

- `hooks/stop-notify.mjs` — the reply-capture path (reads `transcript_path` JSONL, POSTs
  `{prompt, text}` to the daemon).
- `hooks/hooks.json` — registers exactly one hook: `Stop`.
- `src/daemon/voice-daemon.ts:271-275` — current `status_request` / `summary_request` =
  normal enqueued prompt; `:383-402` — reply matched against `inFlight` then spoken;
  `:334-378` — one-in-flight turn serialization, enqueue/interrupt.
- `src/daemon/cmux.ts:112-120` — `cmuxSubmit` (types text + Enter; could send `/btw <q>` but
  the answer is uncapturable).
