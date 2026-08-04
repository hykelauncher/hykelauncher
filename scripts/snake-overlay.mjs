/**
 * snake-overlay — drop an animated snake onto a github-profile-3d-contrib SVG.
 *
 * Strictly additive: it reads the existing file, works out the isometric
 * lattice from the cell transforms already in it, and appends one <style> and
 * one <g> before </svg>. No existing element, class or colour is touched, so
 * the original design renders exactly as before with a snake gliding over it.
 *
 * Each cell group's translate is the top face of that day's tower, so a snake
 * following those points climbs the skyline instead of clipping through it.
 *
 * The snake animates with CSS keyframes. The host file already carries its own
 * SMIL timeline (tower grow-in, radar fill), and keeping the overlay on a
 * separate mechanism means it cannot perturb that timeline.
 *
 * Testing note: a screenshot of an SVG-in-<img> can return a stale raster, so
 * an animation looks frozen when it is in fact running. Force a repaint —
 * scroll or resize — before sampling, or you will chase a bug that isn't there.
 *
 * Usage: node scripts/snake-overlay.mjs <input.svg> <output.svg>
 */

import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/snake-overlay.mjs <input.svg> <output.svg>");
  process.exit(1);
}

const DURATION = 34; // seconds per loop
const SNAKE_LEN = 7;
const ROWS = 7;
const LIFT = 4; // sit the snake just above the surface it rides on

// Amber, complementary to the blue palette so it reads as an addition rather
// than blending into the level-4 towers.
const SNAKE_COLOURS = [
  "#ffe08a",
  "#ffc94d",
  "#ffb020",
  "#f79009",
  "#dc6803",
  "#b54708",
  "#8a3a06",
];

const svg = readFileSync(input, "utf8");

// ------------------------------------------------------------ parse lattice --
const cells = [];
for (const m of svg.matchAll(
  /<g transform="translate\(([-\d.]+) ([-\d.]+)\)">(.*?)<\/g>/gs,
)) {
  if (!/cont-top-/.test(m[3])) continue;
  const width = Number((m[3].match(/<rect[^>]*width="([\d.]+)"/) || [])[1]);
  cells.push({ x: Number(m[1]), y: Number(m[2]), width });
}

if (cells.length < ROWS * 2) {
  throw new Error(`only found ${cells.length} contribution cells — layout changed?`);
}

// Cells are emitted week by week, each week top to bottom, so index maps
// straight onto (week, weekday). Derive the x pitch from the data rather than
// hard-coding it, then verify every cell lands where that model predicts.
const x0 = cells[0].x;
const pitch = Math.abs(cells[1].x - cells[0].x);
const wd = (i) => ({ w: Math.floor(i / ROWS), d: i % ROWS });

let mismatches = 0;
cells.forEach((c, i) => {
  const { w, d } = wd(i);
  if (Math.abs(c.x - (x0 + pitch * w - pitch * d)) > 0.5) mismatches++;
});
if (mismatches > 0) {
  throw new Error(
    `${mismatches}/${cells.length} cells do not fit the lattice model — ` +
      `github-profile-3d-contrib's layout has changed, overlay would be wrong`,
  );
}

// The top face is a rhombus drawn from the group origin; its centre sits one
// rect-width along x and level with the origin in y (within ~0.05px).
const cx = cells[0].width;
const centre = (i) => ({ x: cells[i].x + cx, y: cells[i].y - LIFT });

// Index lookup, tolerating a ragged final week.
const byCell = new Map();
cells.forEach((c, i) => {
  const { w, d } = wd(i);
  byCell.set(`${w},${d}`, i);
});
const maxW = wd(cells.length - 1).w;

// ------------------------------------------------------------- build circuit --
// Serpentine through the weeks, then home along one row and up the first
// column. It has to close: every segment replays one shared keyframes track at
// a different phase, so an open path would teleport on each loop.
const path = [];
for (let w = 0; w <= maxW; w++) {
  const days = [];
  for (let d = 0; d < ROWS; d++) if (byCell.has(`${w},${d}`)) days.push(d);
  if (w % 2 === 1) days.reverse();
  for (const d of days) path.push(byCell.get(`${w},${d}`));
}

const lastRow = wd(path[path.length - 1]).d;
for (let w = maxW - 1; w >= 0; w--) {
  const i = byCell.get(`${w},${lastRow}`);
  if (i !== undefined) path.push(i);
}
for (let d = lastRow - 1; d >= 1; d--) {
  const i = byCell.get(`0,${d}`);
  if (i !== undefined) path.push(i);
}

const steps = path.length;

// ------------------------------------------------------------------- render --
const stops = path.map((idx, k) => {
  const p = centre(idx);
  return `${((k / steps) * 100).toFixed(4)}%{transform:translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)}`;
});
const home = centre(path[0]);
stops.push(
  `100%{transform:translate(${home.x.toFixed(1)}px,${home.y.toFixed(1)}px)}`,
);

const stepDur = DURATION / steps;
const segments = [];
for (let s = SNAKE_LEN - 1; s >= 0; s--) {
  const rx = 11 - s * 0.8;
  const ry = rx * 0.62;
  segments.push(
    `<g class="snkx" style="animation-delay:${(s * stepDur).toFixed(4)}s">` +
      `<ellipse rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${SNAKE_COLOURS[s]}"` +
      (s === 0 ? ` stroke="#00000f" stroke-width="1.2"` : "") +
      `/></g>`,
  );
}

const overlay =
  `<style>.snkx{animation:snkx ${DURATION}s linear infinite both}` +
  `@keyframes snkx{${stops.join("")}}</style>` +
  `<g id="snake-overlay">${segments.join("")}</g>`;

const idx = svg.lastIndexOf("</svg>");
if (idx === -1) throw new Error("no closing </svg> tag");
writeFileSync(output, svg.slice(0, idx) + overlay + svg.slice(idx));

console.log(
  `${output}  ${cells.length} cells, ${steps}-step circuit, ` +
    `+${((overlay.length / 1024)).toFixed(1)} KB overlay`,
);
