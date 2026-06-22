// Project Claude Code's transcript JSONL into the conversational turns the voice remote mirrors to the
// phone. The transcript is the SOURCE OF TRUTH: native `uuid` is identity, native `timestamp` is order,
// and the daemon re-derives the whole recent thread from it on every hook event — so the phone view
// self-heals and can never drift, dedupe wrong, or reorder. The only thing we keep of our own is the
// voice layer (which prompts we injected + their synthesized audio); everything shown is a function of
// this filter over the transcript.
//
// The filter is the whole correctness story. Claude Code writes many synthetic `user`-role records that
// are NOT conversation: tool results (`content` is a tool_result block), slash-command / skill bodies
// (`isMeta`, or no promptSource), and system notifications (`promptSource: "system"`). The stable signal
// that a user record is REAL input — typed in the terminal, or injected by us as a voice transcript (cmux
// types it in, so it is also `promptSource: "typed"`) — is `promptSource`. We key on it, never on text
// shape, so a real image-prefixed message (`[Image #5] …`, still `typed`) is never mistaken for noise.

export type ProjectedRole = "user" | "claude";

export type ProjectedTurn = {
  uuid: string; // native record uuid — identity / dedup key
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
 * Project parsed transcript records into the conversational turns to mirror, oldest-first by native
 * timestamp, keeping at most `maxTurns` (newest). Pure + deterministic: the phone thread is exactly this
 * over the transcript tail, so re-running it on every event converges the phone to ground truth.
 */
export function projectTurns(records: TranscriptRecord[], maxTurns = 40): ProjectedTurn[] {
  const turns: ProjectedTurn[] = [];
  for (const r of records) {
    if (!r.uuid) continue;
    const ts = toEpoch(r.timestamp);
    if (isRealUserTurn(r)) {
      turns.push({ uuid: r.uuid, timestamp: ts, role: "user", text: extractText(r.message?.content), interim: false });
    } else {
      const c = claudeText(r);
      if (c) turns.push({ uuid: r.uuid, timestamp: ts, role: "claude", text: c.text, interim: c.interim });
    }
  }
  // Records are already in chronological (file) order; sort by native timestamp defensively so a row can
  // never appear out of order even if the tail is read mid-write, then keep the newest window.
  turns.sort((a, b) => a.timestamp - b.timestamp);
  return turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns;
}

/** Pair every FINAL claude reply with the user prompt it answers (its nearest preceding user turn). The
 *  daemon uses this to decide voice TTS: speak a reply iff its prompt is one we injected. Interim steps are
 *  excluded — they're never the turn's "reply" and are only spoken under "read every step". Oldest-first. */
export function pairReplies(turns: ProjectedTurn[]): { reply: ProjectedTurn; prompt?: ProjectedTurn }[] {
  const pairs: { reply: ProjectedTurn; prompt?: ProjectedTurn }[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== "claude" || turns[i].interim) continue;
    let prompt: ProjectedTurn | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (turns[j].role === "user") {
        prompt = turns[j];
        break;
      }
    }
    pairs.push({ reply: turns[i], prompt });
  }
  return pairs;
}
