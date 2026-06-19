// The activity log model. Only the user's transcript and Claude's real reply are
// ever logged (errors surface as transient flashes, not log rows) — matching the
// vanilla client's deliberately clean log.

export type MessageKind = "you" | "claude" | "system" | "error";

export type Message = {
  // Stable key for rendering. For Claude replies this is the daemon requestId so
  // audio can be attached/looked up; otherwise a generated id.
  id: string;
  kind: MessageKind;
  // The daemon requestId, present for Claude replies (drives playback + sync).
  requestId?: string;
  title: string;
  body: string;
  // Wall-clock time the row was created, e.g. "12:34 AM" (captured once).
  time: string;
};

export const MAX_LOG = 60;

const TITLE_TO_KIND: Record<string, MessageKind> = {
  You: "you",
  "Claude Code": "claude"
};

let counter = 0;

export function makeMessage(title: string, body: string, requestId?: string): Message {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  counter += 1;
  return {
    id: requestId ?? `m${counter}`,
    kind: TITLE_TO_KIND[title] ?? "system",
    requestId,
    title,
    body,
    time
  };
}
