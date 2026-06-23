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

- `working` ⇔ the active branch's latest user turn has no final answer yet.
- The `Stop` hook stays an **absolute idle edge for the inject gate only** (pane idle ⇒ inject
  next). It is no longer a counter — there is no open/close balance to drift, so "working"
  cannot stick. The reaper/zombie logic is deleted.

## TTS reply — derived

- Speak the active branch's newest final answer to a **voice-originated** user turn, **deduped
  by the answer record's `uuid`** (existing `spoken` set).
- Voice-originated = the on-path user turn contains a prompt we injected (substring-tolerant, so
  gluing is harmless: the merged turn is spoken once; the dead branch has no answer).
- This replaces the fragile `userUuid` + exact-text pairing with tree-position + uuid dedup.

## Realtime / latency (the "must feel fast" requirement)

- **Floor = STT (~1s).** You cannot render the user's text before transcribing it; this is
  inherent and architecture-independent.
- **Post-STT pipeline stays tight and event-driven:** inject → `fs.watch` → `project` → push,
  target <300ms after the JSONL write. No polling.
- **Perceived-instant echo (isolated, optional):** on STT completion the daemon sends a
  fire-and-forget `stt_echo` (NOT a conversation row); the phone shows a transient "sending…"
  bubble that is **wiped wholesale by the next authoritative `history`**. Zero daemon
  conversation state; it cannot orphan because the projection the phone renders is always the
  complete truth. This buys back the ~0.5–1s that killing the optimistic row would otherwise
  cost, without reintroducing a second source of truth.

## What gets deleted (simpler is the point)

- `pending` optimistic rows, `bindPending`, `bindVoicePrompt`, the optimistic branch of
  `historyFrom`.
- `TurnCoordinator.openTurns[]` counter + `reapStaleTurns` ⇒ reduced to an inject queue + a
  single "pane idle" edge from `Stop`.
- `resolveVoiceReply` text matching ⇒ tree + uuid dedup.

Net change deletes more than it adds.

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
3. Delete the optimistic `pending` model; add the isolated `stt_echo`.
4. Re-point TTS to tree + uuid binding; delete `resolveVoiceReply` text matching.
