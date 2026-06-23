// Project Claude Code's transcript JSONL into the conversational turns the voice remote mirrors to the
// phone. The transcript is the SOURCE OF TRUTH: native `uuid` is identity, native `timestamp` is order,
// and the daemon re-derives the whole recent thread from it on every hook event — so the phone view
// self-heals and can never drift, dedupe wrong, or reorder. The only thing we keep of our own is the
// voice layer (which prompts we injected + their synthesized audio); everything shown is a function of
// this filter over the transcript.
//
// The transcript is a TREE (`parentUuid`), and the conversation is its ACTIVE BRANCH — the path from the
// newest record back to the root, exactly what Claude Code renders. We resolve that branch first
// (selectActiveBranch) so a superseded/dead branch can never leak to the phone, then filter it.
//
// The filter is the rest of the correctness story. Claude Code writes many synthetic `user`-role records that
// are NOT conversation: tool results (`content` is a tool_result block), slash-command / skill bodies
// (`isMeta`, or no promptSource), and system notifications (`promptSource: "system"`). The stable signal
// that a user record is REAL input — typed in the terminal, or injected by us as a voice transcript (cmux
// types it in, so it is also `promptSource: "typed"`) — is `promptSource`. We key on it, never on text
// shape, so a real image-prefixed message (`[Image #5] …`, still `typed`) is never mistaken for noise.

import type { Question, QuestionOption, QuestionPayload } from "../shared/protocol.js";

export type ProjectedRole = "user" | "claude";

export type ProjectedTurn = {
  uuid: string; // native record uuid — identity / dedup key
  parentUuid?: string; // native parent link — lets the daemon re-bind a voice reply to a glued sibling
  timestamp: number; // native record timestamp (epoch ms) — order key
  role: ProjectedRole;
  text: string;
  // A "step": assistant text written before a tool call (stop_reason "tool_use") — Claude narrating what
  // it's about to do, vs `false` for a user turn or a FINAL reply. Steps are shown dimmer and not spoken
  // unless the phone opts into "read every step". Always false for user turns.
  interim: boolean;
  // Present iff this turn is an interactive AskUserQuestion (see extractQuestion). Shown as a card and read
  // aloud like a reply, but it is NOT a final reply — isPaneWorking skips it, so the pane stays "working"
  // until Claude's real conclusion lands (which is what resolves the turn).
  question?: QuestionPayload;
};

// Only the transcript fields we read; records carry many more.
export type TranscriptRecord = {
  type?: string;
  uuid?: string;
  parentUuid?: string | null; // tree link to the preceding record; null/absent at the conversation root
  timestamp?: string; // ISO 8601
  isSidechain?: boolean;
  isMeta?: boolean;
  promptSource?: string; // "typed" | "queued" | "system" | undefined
  message?: { role?: string; content?: unknown; stop_reason?: string | null };
};

// Real user input is `typed` (terminal OR our voice injection) or `queued` (a prompt Claude queued while
// busy). Everything else — `system` notifications, and the unset source on tool results / command + skill
// bodies — is synthetic and dropped.
const REAL_PROMPT_SOURCES = new Set(["typed", "queued"]);

/** Flatten a message `content` (string or block array) to its plain text, trimmed. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string"
    )
    .map((b) => b.text)
    .join("")
    .trim();
}

const roleOf = (r: TranscriptRecord): string | undefined => r.message?.role ?? r.type;

function toEpoch(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

// A real conversational user turn: typed/queued input that isn't a sidechain, a meta/skill body, or a
// slash command (control, not conversation).
function isRealUserTurn(r: TranscriptRecord): boolean {
  if (roleOf(r) !== "user" || r.isSidechain || r.isMeta) return false;
  if (!REAL_PROMPT_SOURCES.has(r.promptSource ?? "")) return false;
  const text = extractText(r.message?.content);
  return text.length > 0 && !text.startsWith("/");
}

// Assistant text shown to the user: a FINAL reply (terminal stop_reason) or an interim STEP — the
// narration Claude writes before a tool call (stop_reason "tool_use"). Thinking-only and tool-only records
// carry no text, so they're skipped: we surface the short narration lines but never raw thinking, tool
// calls, or tool output. Returns undefined for anything that isn't shown text.
function claudeText(r: TranscriptRecord): { text: string; interim: boolean } | undefined {
  if (roleOf(r) !== "assistant" || r.isSidechain) return undefined;
  const text = extractText(r.message?.content);
  if (!text) return undefined;
  const stop = r.message?.stop_reason;
  return { text, interim: !(stop === "end_turn" || stop === "max_tokens") };
}

// Claude's interactive AskUserQuestion call: an assistant record whose content carries a `tool_use` block
// named "AskUserQuestion", its `input.questions` the prompt(s) + options. Returns the questions (the caller
// fills `answered`), or undefined for anything else. Fully defensive — a malformed/torn input yields
// undefined so a half-written record can never surface a broken card (and falls through to the normal text
// path, never breaking the rest of the projection: an unknown shape is contained, not catastrophic).
function extractQuestion(r: TranscriptRecord): { toolUseId: string; questions: Question[] } | undefined {
  if (roleOf(r) !== "assistant" || r.isSidechain || !Array.isArray(r.message?.content)) return undefined;
  const tu = r.message.content.find(
    (b) => !!b && (b as { type?: unknown }).type === "tool_use" && (b as { name?: unknown }).name === "AskUserQuestion"
  );
  if (!tu) return undefined;
  const id = (tu as { id?: unknown }).id;
  const raw = (tu as { input?: { questions?: unknown } }).input?.questions;
  if (typeof id !== "string" || !Array.isArray(raw)) return undefined;
  const questions = normalizeQuestions(raw);
  return questions.length > 0 ? { toolUseId: id, questions } : undefined;
}

// Narrow one raw question object to our shape, dropping anything malformed. Options without a string label
// are skipped; a question without a string `question` is dropped entirely.
function normalizeQuestion(raw: unknown): Question | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const q = raw as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown };
  if (typeof q.question !== "string") return undefined;
  const options: QuestionOption[] = Array.isArray(q.options)
    ? q.options.flatMap((o) => {
        const opt = o as { label?: unknown; description?: unknown };
        if (!o || typeof o !== "object" || typeof opt.label !== "string") return [];
        return [
          typeof opt.description === "string"
            ? { label: opt.label, description: opt.description }
            : { label: opt.label }
        ];
      })
    : [];
  return {
    question: q.question,
    ...(typeof q.header === "string" ? { header: q.header } : {}),
    ...(typeof q.multiSelect === "boolean" ? { multiSelect: q.multiSelect } : {}),
    options
  };
}

// Normalize a raw AskUserQuestion `input.questions` array (from a PreToolUse hook payload OR a transcript
// record) into our Question[] shape, dropping anything malformed. Shared so the hook-driven PENDING question
// (which Claude does NOT write to the transcript until it's answered) and the transcript-projected ANSWERED
// question normalize identically.
export function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeQuestion).filter((q): q is Question => q !== undefined);
}

// Content identity for a question set: its prompt(s) + option labels. Lets the daemon recognize that the
// pending-question OVERLAY (sourced from the PreToolUse hook) and the same question once it FLUSHES to the
// transcript (on answer) are the same thing — so the overlay yields to the transcript without double-showing.
export function questionContentSig(questions: Question[]): string {
  return questions.map((q) => `${q.question}::${q.options.map((o) => o.label).join(",")}`).join("||");
}

// tool_use_ids that already have a tool_result anywhere in the records — i.e. questions the user answered.
function answeredToolUseIds(records: TranscriptRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const r of records) {
    const c = r.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && (b as { type?: unknown }).type === "tool_result") {
        const tid = (b as { tool_use_id?: unknown }).tool_use_id;
        if (typeof tid === "string") ids.add(tid);
      }
    }
  }
  return ids;
}

// A spoken/displayed rendering of an interactive question, for TTS and the non-card text fallback. Options
// are lettered (A, B, …) — we read them out; the user answers freely (their transcript becomes the custom
// answer). Claude Code appends its own "Type something"/"Chat about this" rows at render time; those aren't
// in the transcript, so we never read them.
export function questionSpeech(questions: Question[]): string {
  const one = (q: Question) => {
    const opts = q.options.map((o, i) => `${String.fromCharCode(65 + i)}: ${o.label}`).join(". ");
    return opts ? `${q.question} Options — ${opts}.` : q.question;
  };
  if (questions.length === 1) return `Claude is asking: ${one(questions[0])}`;
  return `Claude has ${questions.length} questions. ${questions.map((q, i) => `Question ${i + 1}: ${one(q)}`).join(" ")}`;
}

/**
 * Reduce the records to their ACTIVE BRANCH — the path from the newest record (the conversation HEAD)
 * back to the root, the same branch Claude Code itself renders. The transcript is a TREE (`parentUuid`),
 * not a list: a prompt submitted while a previous one is still pending can be superseded by a sibling
 * (e.g. two fast voice utterances the composer merges into one), leaving a DEAD branch — a real record
 * with no answer that the desktop hides but a flat replay would show as a phantom message. Dropping
 * exactly those dead branches makes the phone view identical to the desktop, structurally, no matter how
 * the upstream tree got its shape.
 *
 * Conservative by construction. A record is dropped ONLY when it is off the active path AND its parent is
 * on the active path (a superseded sibling) or is itself a dropped record (that sibling's descendants).
 * A record whose parent link points outside the read window is never dropped, so a windowed read can
 * never hide real history. Sidechains (subagent branches) are left untouched here — the turn filter drops
 * them downstream. Records without `parentUuid` (e.g. synthetic test fixtures) make this a no-op.
 */
export function selectActiveBranch(records: TranscriptRecord[]): TranscriptRecord[] {
  const byUuid = new Map<string, TranscriptRecord>();
  for (const r of records) if (r.uuid) byUuid.set(r.uuid, r);

  // HEAD = the newest non-sidechain record (a sidechain is a subagent's own branch, never the
  // conversation leaf). Walk `parentUuid` from it to collect the active path present in this window.
  let leaf: TranscriptRecord | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].uuid && !records[i].isSidechain) {
      leaf = records[i];
      break;
    }
  }
  if (!leaf) return records;

  const onPath = new Set<string>();
  let cur: string | null | undefined = leaf.uuid;
  while (cur && byUuid.has(cur) && !onPath.has(cur)) {
    onPath.add(cur);
    cur = byUuid.get(cur)?.parentUuid;
  }

  // The parents of the on-path records — so a superseded sibling is recognised even when that shared parent
  // has itself scrolled out of the read window (the orphan + its glued sibling stay in the tail while their
  // common parent does not). A null/absent parent (a ROOT record) is keyed by a sentinel, so an off-path
  // SECOND root is dropped too — else two root-level turns survive and break the reply re-bind's reliance on
  // the active branch having a unique on-path turn per parent. This grouping runs ONLY when the records
  // actually form a tree (some real parent link exists); a flat set with no links (synthetic fixtures) is a
  // no-op, so a record without parent info is never mistaken for a root sibling.
  const hasTree = records.some((r) => r.parentUuid != null);
  const ROOT_PARENT = ""; // sentinel for a null/absent parent; native uuids are never empty
  const parentKey = (r: TranscriptRecord): string | undefined => (hasTree ? r.parentUuid || ROOT_PARENT : undefined);
  const onPathParents = new Set<string>();
  for (const r of records) {
    if (!r.uuid || !onPath.has(r.uuid)) continue;
    const k = parentKey(r);
    if (k !== undefined) onPathParents.add(k);
  }

  // Mark dead branches: a non-sidechain record off the path that shares a parent with the active path (a
  // superseded sibling, ROOT level included), is a child of the active path, or descends from an
  // already-dropped node. File order ⇒ parents are classified before children, so the cascade catches dead
  // subtrees.
  const dropped = new Set<string>();
  for (const r of records) {
    if (!r.uuid || r.isSidechain || onPath.has(r.uuid)) continue;
    const parent = r.parentUuid;
    const k = parentKey(r);
    if ((k !== undefined && onPathParents.has(k)) || (parent && onPath.has(parent)) || (parent && dropped.has(parent)))
      dropped.add(r.uuid);
  }
  return dropped.size === 0 ? records : records.filter((r) => !r.uuid || !dropped.has(r.uuid));
}

/**
 * Project parsed transcript records into the conversational turns to mirror, oldest-first by native
 * timestamp, keeping at most `maxTurns` (newest). Pure + deterministic: the phone thread is exactly this
 * over the transcript tail, so re-running it on every event converges the phone to ground truth. Resolves
 * the active branch first (see selectActiveBranch) so a superseded/dead branch never leaks to the phone.
 */
export function projectTurns(records: TranscriptRecord[], maxTurns = 40): ProjectedTurn[] {
  const turns: ProjectedTurn[] = [];
  const branch = selectActiveBranch(records);
  const answered = answeredToolUseIds(branch);
  for (const r of branch) {
    if (!r.uuid) continue;
    const ts = toEpoch(r.timestamp);
    const parentUuid = r.parentUuid ?? undefined;
    if (isRealUserTurn(r)) {
      turns.push({
        uuid: r.uuid,
        parentUuid,
        timestamp: ts,
        role: "user",
        text: extractText(r.message?.content),
        interim: false
      });
    } else {
      const q = extractQuestion(r);
      if (q) {
        // A preamble Claude writes in the SAME record as the AskUserQuestion (rare — usually it's its own
        // turn) would otherwise be dropped; keep it as the spoken lead-in so the question's context is read.
        const lead = extractText(r.message?.content);
        turns.push({
          uuid: r.uuid,
          parentUuid,
          timestamp: ts,
          role: "claude",
          text: lead ? `${lead} ${questionSpeech(q.questions)}` : questionSpeech(q.questions),
          interim: false,
          question: { toolUseId: q.toolUseId, questions: q.questions, answered: answered.has(q.toolUseId) }
        });
        continue;
      }
      const c = claudeText(r);
      if (c) turns.push({ uuid: r.uuid, parentUuid, timestamp: ts, role: "claude", text: c.text, interim: c.interim });
    }
  }
  // Records are already in chronological (file) order; sort by native timestamp defensively so a row can
  // never appear out of order even if the tail is read mid-write, then keep the newest window.
  turns.sort((a, b) => a.timestamp - b.timestamp);
  return turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns;
}

/**
 * Is the pane working, derived from the active branch? True when the newest user turn has no FINAL
 * (non-interim) reply after it yet — Claude is still answering. DERIVED, never counted: however many
 * UserPromptSubmit/Stop hooks fired (a merged prompt fires two opens but one close), the answer's
 * presence in the transcript is ground truth, so the working lamp can never stick. Interim steps don't
 * count as the answer (a turn mid-tool-call is still working). Pass the projected turns (already active-
 * branch-resolved + announcement-dropped) — the same set the phone is shown, so view and lamp agree.
 */
export function isPaneWorking(turns: ProjectedTurn[]): boolean {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role !== "user") continue;
    for (let j = i + 1; j < turns.length; j++) {
      // A question is NOT the final reply: the pane is still working (awaiting the answer, then the
      // conclusion), so skip it — else the working poll would stop and a late conclusion could be missed.
      if (turns[j].role === "claude" && !turns[j].interim && !turns[j].question) return false; // answered → idle
    }
    return true; // newest user turn still awaiting its final reply → working
  }
  return false; // no user turn → idle
}

/**
 * Is the newest content turn an interactive AskUserQuestion still awaiting the user's answer? That means
 * Claude is blocked on the HUMAN — "awaiting", not "working". We look at the newest non-interim claude turn:
 * an unanswered question → awaiting; a real reply (or an answered question Claude is now concluding) → not.
 * `answered` flips once the selection's tool_result lands, so this self-heals from the transcript like the
 * rest of the projection.
 */
export function pendingQuestion(turns: ProjectedTurn[]): boolean {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== "claude" || t.interim) continue; // skip steps and user rows
    return t.question !== undefined && t.question.answered === false;
  }
  return false;
}

/**
 * Drop the start-skill announcement (the "voice remote is live" QR + URL reply) from a projection. We key
 * on the daemon's OWN session URL — a value the daemon minted and the skill always prints as the tap/copy
 * fallback — never on the surrounding prose, so reworded copy still filters and a normal reply can't match
 * (the URL carries the 128-bit session secret). Belt-and-suspenders against the QR being shown OR spoken;
 * applied to every projection so it works for a brand-new session and one that's been running for hours.
 * ponytail: substring match on the URL; if the skill ever stops printing the URL, also pass the secret.
 */
export function dropSessionAnnouncement(turns: ProjectedTurn[], sessionUrl: string): ProjectedTurn[] {
  if (!sessionUrl) return turns;
  return turns.filter((t) => !(t.role === "claude" && t.text.includes(sessionUrl)));
}
