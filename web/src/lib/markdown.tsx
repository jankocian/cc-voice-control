import type { ReactNode } from "react";

// A deliberately tiny Markdown renderer for agent bubbles, so a reply reads like it does in the
// terminal (fenced code blocks, `inline code`, **bold**) without pulling in a full CommonMark lib.
// ponytail: handles exactly the constructs Claude's replies use; add italics/lists/links the day a
// reply needs them, not before. Plain text (no markers) passes through unchanged.
//
// Keys are derived from each piece's character offset within the message (stable + unique, and the
// body is immutable) rather than the array index — same effect, but it keeps the lists honest.

// Inline pass: split out `code` spans first (so ** inside code isn't bolded), then **bold** within
// the rest. Returns an array of strings + <code>/<strong> nodes.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let offset = 0;
  for (const part of text.split(/(`[^`]+`)/g)) {
    const base = `${keyPrefix}-${offset}`;
    offset += part.length;
    if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
      out.push(
        <code key={base} className="rounded bg-violet/15 px-1 py-0.5 font-mono text-[0.85em] text-violet-ink">
          {part.slice(1, -1)}
        </code>
      );
      continue;
    }
    let boff = 0;
    for (const seg of part.split(/(\*\*[^*]+\*\*)/g)) {
      const key = `${base}.${boff}`;
      boff += seg.length;
      if (!seg) continue;
      if (seg.length > 2 && seg.startsWith("**") && seg.endsWith("**")) {
        out.push(
          <strong key={key} className="font-semibold text-ink">
            {seg.slice(2, -2)}
          </strong>
        );
      } else {
        out.push(seg);
      }
    }
  }
  return out;
}

// Strip an opening ```lang line (a bare language tag, no spaces) from a fenced block's body.
function stripFenceLang(block: string): string {
  const nl = block.indexOf("\n");
  if (nl < 0) return block;
  const first = block.slice(0, nl).trim();
  return /^[a-zA-Z0-9_+-]*$/.test(first) ? block.slice(nl + 1) : block;
}

// Split on ``` fences: even segments are prose (inline-formatted, whitespace preserved), odd segments
// are code blocks rendered in a monospace, theme-aware well (terminal feel; scrolls if wide so the
// bubble never blows out — e.g. a QR block).
export function renderMarkdown(text: string): ReactNode {
  const out: ReactNode[] = [];
  let offset = 0;
  const segments = text.split("```");
  const last = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    const key = `seg-${offset}`;
    offset += segments[i].length + 3; // + the ``` delimiter we split on
    if (i % 2 === 1) {
      out.push(
        <pre
          key={key}
          className="my-1.5 overflow-x-auto rounded-xl bg-canvas-deep px-3 py-2 font-mono text-[12px] leading-snug text-ink"
        >
          {stripFenceLang(segments[i]).replace(/\n$/, "")}
        </pre>
      );
    } else {
      // Collapse the blank lines that hug a fence — otherwise the source's `\n\n` around ``` render as
      // literal empty lines AND stack with the <pre> margin, leaving a huge gap. The fence edge spacing
      // is owned by the <pre> margin alone; real paragraph breaks inside the prose are preserved.
      let seg = segments[i];
      if (i > 0) seg = seg.replace(/^\s*\n/, "");
      if (i < last) seg = seg.replace(/\n\s*$/, "");
      if (!seg) continue;
      out.push(
        <span key={key} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          {renderInline(seg, key)}
        </span>
      );
    }
  }
  return out;
}
