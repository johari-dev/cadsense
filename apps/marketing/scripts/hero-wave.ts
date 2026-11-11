// Generates src/assets/hero-wave.txt, the text grid HeroWave.astro draws behind the landing page's
// headline. The picture is Hokusai's "Under the Wave off Kanagawa" (about 1831), from the
// Metropolitan Museum of Art's Open Access collection, object 45434:
//   https://images.metmuseum.org/CRDImages/as/original/DP130155.jpg
// Usage, from apps/marketing, with ffmpeg on the PATH:
//   node scripts/hero-wave.ts <path to that JPEG>
// Each character of the grid is one cell: its position in CODE is colour * 16 + level, where level
// 0 is empty and 15 is full strength. Rows end in a newline.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

// 440 columns is 3.9 px per character on a 1440 px page, which draws the art at 118% of its width.
// The picture stops reading below about 3 px.
const COLS = 440;
const ROWS = 166;
// The whole sheet minus a sliver of margin. Its 1.48:1 shape matches the grid's.
const CROP = "crop=3839:2594:10:0";
const CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const [BLUE, PALE, CREAM, TAN] = [0, 1, 2, 3];

const source = process.argv[2];
if (!source) throw new Error("Usage: node scripts/hero-wave.ts <path to the Met's JPEG>");

const pixels = NodeChildProcess.execFileSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    source,
    "-vf",
    `${CROP},scale=${COLS}:${ROWS}:flags=area`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ],
  { maxBuffer: COLS * ROWS * 3 },
);

// Mean over a (2 * radius + 1) square, with the edges clamped.
function boxBlur(values: Float32Array, radius: number): Float32Array {
  const blurAlong = (
    from: Float32Array,
    length: number,
    stride: number,
    lines: number,
    step: number,
  ) => {
    const out = new Float32Array(from.length);
    for (let line = 0; line < lines; line++) {
      for (let i = 0; i < length; i++) {
        const lo = Math.max(0, i - radius);
        const hi = Math.min(length - 1, i + radius);
        let sum = 0;
        for (let j = lo; j <= hi; j++) sum += from[line * step + j * stride] ?? 0;
        out[line * step + i * stride] = sum / (hi - lo + 1);
      }
    }
    return out;
  };
  return blurAlong(blurAlong(values, COLS, 1, ROWS, COLS), ROWS, COLS, COLS, 1);
}

// A woodblock print is read by its ink, not its brightness: blue ink is the wave, unprinted white is
// foam and snow, and the toned paper is sky. On a dark page the foam is drawn at full strength, the
// ink at medium strength (stronger where it is darker), and the sky is left almost empty. The
// cut-offs are this scan's own colours: white is bright with almost no saturation, paper is warm.
const cells = Array.from({ length: COLS * ROWS }, (_, i) => {
  const [r = 0, g = 0, b = 0] = pixels.subarray(i * 3, i * 3 + 3);
  return {
    lum: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255,
    cool: (b - r) / 255,
    sat: (Math.max(r, g, b) - Math.min(r, g, b)) / 255,
  };
});
// How much blue ink is nearby. Foam touches the wave; the white cloud in the sky does not.
const inkNear = boxBlur(
  Float32Array.from(cells, ({ cool }) => (cool > 0.1 ? 1 : 0)),
  7,
);

function cell(
  { lum, cool, sat }: (typeof cells)[number],
  ink: number,
): readonly [colour: number, strength: number] {
  if (cool > 0.1) return [BLUE, 0.52 + 0.8 * (0.5 - lum)];
  // A pale blue wash. The grey band of sky stays empty.
  if (cool > -0.02) return [PALE, lum > 0.55 ? 0.5 : 0];
  // Foam and snow. The cloud is held back.
  if (sat < 0.12 && lum > 0.8) return [CREAM, ink > 0.03 ? 1 : 0.22];
  return [TAN, lum > 0.6 ? 0.07 : 0];
}

const rows = Array.from({ length: ROWS }, (_, row) =>
  cells
    .slice(row * COLS, (row + 1) * COLS)
    .map((pixel, col) => {
      const [colour, strength] = cell(pixel, inkNear[row * COLS + col] ?? 0);
      return CODE[colour * 16 + Math.round(Math.min(1, Math.max(0, strength)) * 15)];
    })
    .join(""),
);

const output = new URL("../src/assets/hero-wave.txt", import.meta.url);
NodeFS.writeFileSync(output, `${rows.join("\n")}\n`);
console.log(`Wrote ${rows.length} rows of ${COLS} cells to ${output.pathname}`);
