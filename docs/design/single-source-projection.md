# Single source of truth: active-branch transcript projection

**Status:** Proposed — 2026-06-23.
**Supersedes the implicit model in:** `voice-daemon.ts` (`pending` optimistic rows), `turn-coordinator.ts` (open/close counter), `transcript-reader.ts` (flat read).

## Context — the failure that triggered this

Two spoken utterances were injected 18s apart (`daemon.log` 23:03:56, 23:04:15). Claude Code
merged them: the transcript (`02104852-…jsonl`) holds **two sibling user rows** under the same
`parentUuid` (`3c0605ad`) — an orphan `A` (`26b3b264`) and the consumed, glued `A.B`
(`1c64e293`) — and Claude answered **only** `A.B`. From that one upstream glitch:

1. **Phone showed 3 messages, desktop 1.** The projection reads the transcript as a flat list
   (`transcript-reader.ts` never touches `parentUuid`), so it shows the dead `A` branch the
   desktop hides; plus an optimistic echo of `B` that never reconciled.
2. **"Agent is working" stuck.** `TurnCoordinator` counts hook events (`isWorking()` =
   `openTurns.length > 0`). Two `UserPromptSubmit`, one `Stop` ⇒ a phantom open turn until the
   20-min reaper.
3. **Reply late / "no transcript".** Reply binds by `userUuid` + exact text; the phantom turn +
   unreconciled echo desynced it.

Root cause is not the glitch. It is that the daemon keeps **three parallel models** of the
conversation, each reconciled to reality by a different heuristic (flat replay; exact-text
match; event counting). Three sources of truth always drift. **We cannot prevent upstream
weirdness in Claude Code's composer — so the architecture must be immune to it.**

## Decision

The Claude Code transcript JSONL, viewed as a **tree**, is the **single source of truth**. The
phone view, the working lamp, and TTS selection are **pure, idempotent derivations** of the
**active branch** of that tree, recomputed on every transcript change. Every parallel
daemon-side conversation/turn model is deleted.

```
view = project(activeBranch(transcript))     // pure function; same input → same output
```

## The model

- Transcript = append-only records; each has `uuid` + `parentUuid` ⇒ a tree.
- **Active branch** = the path from the latest leaf to the root — exactly Claude Code's own
  render rule. Dead/superseded branches are off-path and therefore never shown.
- The daemon becomes a **stateless projector**. Its only retained state is a regenerable audio
  cache and the injection queue, and **neither feeds the view**.

## Algorithm — `project()`

1. Parse records (existing).
2. `leaf` = the last non-sidechain record in the file.
3. Walk `parentUuid` from `leaf` to root ⇒ the ordered set of on-path uuids.
4. Keep displayable user/assistant turns on-path; drop sidechain / meta / the QR announcement
   (existing filters).
5. Group an assistant turn's records to its final answer text (existing `ProjectedTurn`).
6. Emit in file order.

**Guarantee:** phone view == Claude Code's rendered conversation, because both follow the same
leaf→root path over the same tree. The glued-prompt incident becomes a non-event: `A.B` is on
the path (shown once), orphan `A` is off-path (hidden), there is no optimistic row to orphan.

Edge cases: `/compact` rewrites the tree — the leaf-walk follows whatever Claude wrote; the
existing reset floor still clamps history. Subagent sidechains stay excluded by `isSidechain`.
A trailing unanswered user row is itself the leaf, so it shows (correct — it's the live prompt).

## Working state — derived, self-healing

`working = hasInFlight || (isBusy && isPaneWorking(activeBranch))`:

- `hasInFlight` — our injection is typed but not yet an open turn (the gap before it lands).
- `isBusy` — the inject gate's level: a `UserPromptSubmit` without its `Stop` yet. It is a single
  LEVEL, **not a counter** — a glued prompt fires two opens but one close, and one `Stop` means
  idle, so it can't stick at "2".
- `isPaneWorking` — the active branch's newest user turn has no final (non-interim) reply yet.

The **AND** is the robustness: a missed `Stop` leaves `isBusy` stuck, but the transcript going
idle (a real reply landed) still flips `working` off; an interrupt clears `isBusy`, so the lamp
idles at once (the pure-transcript form would read "working" forever on an Esc'd turn); and the
transcript can't read "working" past a real reply. Neither signal alone can wedge the lamp.

The `TurnCoordinator` keeps a small **TTL reaper** as a backstop for the inject GATE only (a
missed `Stop` or an injection whose open never arrives), so injection can't wedge forever. It
never drives the lamp — the lamp self-heals from the transcript.

## TTS reply — tree + uuid

Replies bind to their native user record by `uuid` and resolve over the **active branch**
(`resolveVoiceReply` on the projected turns), so a dead-branch turn is never the target. Two
tolerances make the glued case work:

- **Re-bind off a dead branch:** a `pending` entry bound to the orphan `A` at turn-open (before
  `A.B` existed) is released when `A` drops off the active branch, then re-binds to the survivor.
- **Two-pass match (exact, then substring):** so a short prompt can't steal a longer turn; the
  merged `A.B` (no exact match for injected `A`) binds because it *contains* `A`.

Dedup is by the answer record's `uuid` (the existing `spoken` set), so a reply is voiced once.

## Realtime / latency (the "must feel fast" requirement)

- **Floor = STT (~1s).** You cannot render the user's text before transcribing it; this is
  inherent and architecture-independent.
- **Post-STT pipeline stays tight and event-driven:** inject → `fs.watch` → `project` → push,
  target <300ms after the JSONL write. No polling. The existing "transcribing…" indicator covers
  the gap from mic-release until the projected turn lands.
- **Instant-text echo: deferred.** An `stt_echo` (daemon shows the words before the round-trip)
  was prototyped and pulled: matching STT text to the recorded turn is fragile (false drops on
  short/repeated phrases, stuck placeholders on a failed send) and duplicates the daemon's bind
  rule on the client — a poor trade against the "above all, reliable" goal. Revisit only with a
  correlation id carried end-to-end, not text matching.

## What changes (simpler is the point)

- **Deleted:** the daemon-side optimistic ROWS — `historyFrom` is now a pure projection (the
  phone shows nothing the transcript hasn't confirmed); `PendingVoice.id`/`ts` (render-only
  fields); `TurnCoordinator.openTurns[]` **counter** (→ a single `paneBusy` level).
- **Kept, made tree-aware:** `bindPending` / `bindVoicePrompt` / `resolveVoiceReply` now resolve
  over the active branch with re-bind + two-pass matching; the TTL reaper remains as the gate
  backstop. `pending` survives as reply bookkeeping only — it no longer feeds the view.

Net change still deletes more than it adds.

## Invariants (the spec the tests defend)

1. `view` is a pure function of the transcript file.
2. `view` == Claude Code's rendered active branch — no dead branches, no orphans, no duplicates.
3. No daemon-side state is authoritative for the view.
4. `working` is derived; an idle edge always wins (no stuck "working").

## Regression tests

- **Dead-branch fixture** (the real `02104852` incident: sibling user rows `A` and `A.B`,
  answer only under `A.B`): assert `project()` yields exactly `[…, A.B, reply]` — `A` absent,
  one user turn, not three.
- **Two-opens-one-close**: assert `working` resolves to idle from the transcript regardless of
  hook-event counts.

## Migration — phased, each phase shippable + e2e-tested

1. Add active-branch resolution to the projection + the dead-branch fixture test. (View becomes
   correct even before the rest; optimistic layer now redundant.)
2. Derive `working` from the projection; reduce `TurnCoordinator` to the inject gate; delete the
   counter + reaper.
3. Stop rendering the optimistic `pending` rows (`historyFrom` → pure projection); keep `pending`
   as reply bookkeeping only.
4. Make the reply binding tree-aware (re-bind off dead branches, two-pass exact-then-substring).
