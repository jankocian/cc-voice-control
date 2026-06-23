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
  for (const r of selectActiveBranch(records)) {
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
      if (turns[j].role === "claude" && !turns[j].interim) return false; // answered → idle
    }
    return true; // newest user turn still awaiting its final reply → working
  }
  return false; // no user turn → idle
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
