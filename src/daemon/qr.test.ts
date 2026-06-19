import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { encodeQr, type QrMatrix, renderQr, renderQrUnicode } from "./qr.js";

// A realistic phone URL: bridge + UUID session id + 43-char token + expiry.
const SAMPLE_URL =
  "https://voice-remote-bridge.example.workers.dev/s/123e4567-e89b-12d3-a456-426614174000?token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&expiresAt=1750000000000";

/** Paint a boolean module grid into an RGBA bitmap jsQR can decode (black ink on white). */
function rasterize(bits: boolean[][], scale = 4, quiet = 4) {
  const rows = bits.length;
  const cols = bits[0].length;
  const width = (cols + quiet * 2) * scale;
  const height = (rows + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * height * 4).fill(255); // opaque white
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!bits[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          const px = (y * width + x) * 4;
          data[px] = data[px + 1] = data[px + 2] = 0; // black, alpha stays 255
        }
      }
    }
  }
  return { data, width, height };
}

function bitsFromMatrix(matrix: QrMatrix): boolean[][] {
  const bits: boolean[][] = [];
  for (let r = 0; r < matrix.size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < matrix.size; c++) row.push(matrix.isDark(r, c));
    bits.push(row);
  }
  return bits;
}

/** Reverse the half-block rendering back into a module grid (two rows per text line). */
function bitsFromRender(rendered: string): boolean[][] {
  const lines = rendered.split("\n");
  const cols = lines[0].length;
  const bits: boolean[][] = [];
  for (const line of lines) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (let c = 0; c < cols; c++) {
      const ch = line[c] ?? " ";
      top.push(ch === "█" || ch === "▀");
      bottom.push(ch === "█" || ch === "▄");
    }
    bits.push(top, bottom);
  }
  return bits;
}

describe("QR encoding", () => {
  it("auto-sizes to version 1 (21 modules) for tiny input", () => {
    expect(encodeQr("HI").size).toBe(21);
  });

  it("rejects empty input", () => {
    expect(() => encodeQr("")).toThrow();
  });

  it("reports light modules outside the grid (quiet zone is queryable)", () => {
    const matrix = encodeQr("HI");
    expect(matrix.isDark(-1, 0)).toBe(false);
    expect(matrix.isDark(0, matrix.size)).toBe(false);
    expect(matrix.isDark(0, 0)).toBe(true); // top-left finder pattern
  });

  it("encodes a realistic session URL into a decodable matrix", () => {
    const raster = rasterize(bitsFromMatrix(encodeQr(SAMPLE_URL)));
    const decoded = jsQR(raster.data, raster.width, raster.height);
    expect(decoded?.data).toBe(SAMPLE_URL);
  });
});

describe("Unicode QR rendering", () => {
  it("uses only block glyphs and keeps every line the same width", () => {
    const matrix = encodeQr("HELLO");
    const margin = 2;
    const lines = renderQrUnicode(matrix, margin).split("\n");
    const width = matrix.size + margin * 2;
    expect(lines.length).toBe(Math.ceil(width / 2));
    for (const line of lines) {
      expect(line.length).toBe(width);
      expect(/^[█▀▄ ]+$/u.test(line)).toBe(true);
    }
  });

  it("surrounds the code with a quiet zone", () => {
    const lines = renderQrUnicode(encodeQr("HELLO"), 2).split("\n");
    expect(lines[0].trim()).toBe(""); // blank top margin row
    expect(lines[lines.length - 1].trim()).toBe(""); // blank bottom margin row
  });

  // The real guarantee: what we actually print to the chat is scannable.
  it("round-trips — the rendered Unicode QR decodes back to the URL", () => {
    const raster = rasterize(bitsFromRender(renderQr(SAMPLE_URL)));
    const decoded = jsQR(raster.data, raster.width, raster.height);
    expect(decoded?.data).toBe(SAMPLE_URL);
  });
});
