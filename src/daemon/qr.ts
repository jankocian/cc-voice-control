import qrcode from "qrcode-generator";

/** A square QR module grid. `isDark(row, col)` is true for a "dark" (ink) module. */
export interface QrMatrix {
  readonly size: number;
  isDark(row: number, col: number): boolean;
}

/**
 * Encode UTF-8 text into the smallest QR matrix that fits it.
 *
 * Error-correction level L (7%) is deliberate: the code is shown on a
 * high-contrast screen and read from short range, so the lowest level keeps the
 * module count — and therefore the printed width — as small as possible. That
 * width is the main reliability lever in a terminal: a QR wide enough to line-
 * wrap can't be scanned.
 */
export function encodeQr(text: string): QrMatrix {
  if (!text) throw new Error("encodeQr: text is required");
  const qr = qrcode(0, "L"); // 0 = auto-select the smallest fitting version
  qr.addData(text); // default Byte mode handles arbitrary URLs
  qr.make();
  const size = qr.getModuleCount();
  return {
    size,
    // Guard the bounds so the renderer can query the quiet-zone freely.
    isDark: (row, col) => row >= 0 && row < size && col >= 0 && col < size && qr.isDark(row, col)
  };
}

// Half-block glyphs encode two vertically-stacked modules per character cell.
const FULL_BLOCK = "█"; // █  top + bottom dark
const UPPER_HALF = "▀"; // ▀  top dark only
const LOWER_HALF = "▄"; // ▄  bottom dark only
const BLANK = " "; //            both light

/**
 * Render a QR matrix to a compact Unicode string. Two vertical modules share one
 * text cell (via half-block glyphs), so the code stays roughly square in a
 * terminal whose character cells are about twice as tall as they are wide.
 *
 * Dark modules are drawn as foreground glyphs and light modules as spaces, so
 * the output carries no colour and renders identically under light and dark
 * terminal themes. On a dark theme it appears inverted (light code on a dark
 * field), which every modern phone scanner (iOS Camera, Android) reads fine.
 *
 * `margin` is the quiet zone — the blank border the QR spec requires. Two
 * modules, plus the terminal's own same-coloured background beyond the block, is
 * an ample quiet zone while keeping the printed width down.
 */
export function renderQrUnicode(matrix: QrMatrix, margin = 2): string {
  const start = -margin;
  const end = matrix.size + margin; // exclusive
  const lines: string[] = [];
  for (let row = start; row < end; row += 2) {
    let line = "";
    for (let col = start; col < end; col++) {
      const top = matrix.isDark(row, col);
      const bottom = matrix.isDark(row + 1, col);
      line += top ? (bottom ? FULL_BLOCK : UPPER_HALF) : bottom ? LOWER_HALF : BLANK;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Encode `text` and render it as a terminal-ready Unicode QR string. */
export function renderQr(text: string, margin = 2): string {
  return renderQrUnicode(encodeQr(text), margin);
}
