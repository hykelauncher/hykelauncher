/**
 * snake-overlay — put an isometric snake on a github-profile-3d-contrib SVG
 * and have it flatten each tower it passes over.
 *
 * Reads the file github-profile-3d-contrib produced, recovers the isometric
 * lattice from the cell transforms already in it, and rewrites it into a new
 * file. The input is never modified, so the original still renders on its own.
 *
 * The snake is built from the same skewed rects the graph uses for its own
 * towers, so it shares the projection exactly and reads as part of the scene
 * rather than a flat sticker on top of it.
 *
 * Eating: a tower cannot simply be hidden, because in this format the raised
 * top face IS the tower — there is no separate ground tile underneath. So each
 * tower gets a static level-0 tile inserted behind it, then collapses onto that
 * tile as the head arrives.
 *
 * The collapse is expressed as translateY(g) scaleY(0) translateY(-g), which
 * flattens everything onto the ground line y=g without relying on
 * transform-origin or transform-box.
 *
 * Testing note: a screenshot of an SVG-in-<img> can return a stale raster, so a
 * running animation looks frozen. Force a repaint — scroll or resize — before
 * sampling, or you will chase a bug that isn't there.
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
const ISO = 0.57735; // tan(30°) — the file's own right-face offset ratio
const HEAD_TOP = 15; // top-face size of the head cube, tapering down the tail

// Amber, complementary to the blue palette so the snake reads as an addition.
// Three shades per cube matching the graph's own top / left / right shading.
const SNAKE_SHADES = [
  ["#ffe9a8", "#f0c860", "#d9a838"],
  ["#ffd166", "#e0b040", "#c29020"],
  ["#ffb020", "#dd9410", "#bd7a08"],
  ["#f79009", "#d47606", "#b06004"],
  ["#dc6803", "#bb5602", "#9a4602"],
  ["#b54708", "#983a06", "#7c2f05"],
  ["#8a3a06", "#722f05", "#5c2604"],
];

const svg = readFileSync(input, "utf8");
const CELL_RE = /<g transform="translate\(([-\d.]+) ([-\d.]+)\)">(.*?)<\/g>/gs;

// ------------------------------------------------------------ parse lattice --
const cells = [];
for (const m of svg.matchAll(CELL_RE)) {
  if (!/cont-top-/.test(m[3])) continue;
  cells.push({
    x: Number(m[1]),
    y: Number(m[2]),
    size: Number((m[3].match(/<rect[^>]*width="([\d.]+)"/) || [])[1]),
  });
}
if (cells.length < ROWS * 2) {
  throw new Error(`only found ${cells.length} contribution cells — layout changed?`);
}

// Cells are emitted week by week, each week top to bottom, so index maps onto
// (week, weekday). Derive the pitch from the data, then verify every cell lands
// where that model predicts rather than trusting it.
const x0 = cells[0].x;
const y0 = cells[0].y;
const pitch = Math.abs(cells[1].x - cells[0].x);
const yStep = (cells[ROWS].y - cells[0].y) / 1; // one week along
const wd = (i) => ({ w: Math.floor(i / ROWS), d: i % ROWS });

let bad = 0;
cells.forEach((c, i) => {
  const { w, d } = wd(i);
  if (Math.abs(c.x - (x0 + pitch * w - pitch * d)) > 0.5) bad++;
});
if (bad > 0) {
  throw new Error(
    `${bad}/${cells.length} cells do not fit the lattice model — ` +
      `github-profile-3d-contrib's layout has changed, overlay would be wrong`,
  );
}

// Ground level for a cell, and therefore its tower height: a cell's stored y is
// its top face, raised above the flat plane by however tall the tower is.
const CELL = cells[0].size;
cells.forEach((c, i) => {
  const { w, d } = wd(i);
  c.ground = y0 + yStep * (w + d);
  c.height = c.ground - c.y;
  c.tower = c.height > 0.5;
});

const byCell = new Map();
cells.forEach((c, i) => byCell.set(`${wd(i).w},${wd(i).d}`, i));
const maxW = wd(cells.length - 1).w;

// ------------------------------------------------------------- build circuit --
// Serpentine through the weeks, then home along one row and up the first
// column. It must close: every segment replays one shared keyframes track at a
// different phase, so an open path would teleport on each loop.
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

const eatAt = new Map();
path.forEach((idx, k) => {
  if (!eatAt.has(idx)) eatAt.set(idx, k);
});

// ---------------------------------------------------- rewrite the cell groups --
// Each tower gets a level-0 tile behind it to collapse onto, then a wrapper
// carrying the collapse animation. The wrapper has no transform attribute of
// its own, so its CSS transform cannot fight the inner translate.
const eatKeyframes = [];
const topFaceTransform = `skewY(-30) skewX(40.89) scale(1 1.15)`;
let seen = 0;

const rewritten = svg.replace(CELL_RE, (whole, mx, my, body) => {
  if (!/cont-top-/.test(body)) return whole;
  const c = cells[seen++];
  if (!c.tower) return whole;

  const k = eatKeyframes.length;
  const g = c.ground.toFixed(2);
  const start = ((eatAt.get(seen - 1) ?? 0) / steps) * 100;
  const end = (Math.min(steps, (eatAt.get(seen - 1) ?? 0) + 2.5) / steps) * 100;
  eatKeyframes.push(
    `@keyframes eat${k}{0%,${start.toFixed(3)}%{transform:translateY(${g}px) scaleY(1) translateY(-${g}px)}` +
      `${end.toFixed(3)}%,100%{transform:translateY(${g}px) scaleY(0) translateY(-${g}px)}}`,
  );

  const tile =
    `<g transform="translate(${c.x} ${c.ground.toFixed(2)})">` +
    `<rect stroke="none" x="0" y="0" width="${CELL}" height="${CELL}" ` +
    `transform="${topFaceTransform}" class="cont-top-0"></rect></g>`;

  return `${tile}<g class="eat eat${k}">${whole}</g>`;
});

// -------------------------------------------------------------- build snake --
// A cube of top-face size s, drawn exactly the way the graph draws its towers.
const cube = (s, shades) => {
  const h = s * 0.62;
  return (
    `<rect stroke="none" x="0" y="0" width="${s}" height="${s}" transform="${topFaceTransform}" fill="${shades[0]}"></rect>` +
    `<rect stroke="none" x="0" y="0" width="${s}" height="${h.toFixed(2)}" transform="skewY(30) scale(1 1.15)" fill="${shades[1]}"></rect>` +
    `<rect stroke="none" x="0" y="0" width="${s}" height="${h.toFixed(2)}" transform="translate(${s} ${(s * ISO).toFixed(2)}) skewY(-30) scale(1 1.15)" fill="${shades[2]}"></rect>`
  );
};

// Ride the top face of whatever is at that cell, sitting on the surface rather
// than sunk into it.
const perch = (idx, s) => {
  const c = cells[idx];
  return {
    x: c.x + CELL - s,
    y: c.y - s * 0.62 * 1.15,
  };
};

// One shared track sized for the head. A tapered segment's perch differs from
// the head's by a constant, so each cube carries that as a static inner
// translate instead of duplicating a 420-stop track per segment.
const stepDur = DURATION / steps;
const stops = path.map((idx, k) => {
  const p = perch(idx, HEAD_TOP);
  return `${((k / steps) * 100).toFixed(4)}%{transform:translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)}`;
});
const home = perch(path[0], HEAD_TOP);
stops.push(
  `100%{transform:translate(${home.x.toFixed(1)}px,${home.y.toFixed(1)}px)}`,
);
eatKeyframes.push(`@keyframes snk{${stops.join("")}}`);

const segments = [];
for (let sIdx = SNAKE_LEN - 1; sIdx >= 0; sIdx--) {
  const size = HEAD_TOP - sIdx * 1.1;
  const dx = HEAD_TOP - size;
  const dy = dx * 0.62 * 1.15;
  segments.push(
    `<g class="snkx" style="animation-delay:${(sIdx * stepDur).toFixed(4)}s">` +
      `<g transform="translate(${dx.toFixed(2)} ${dy.toFixed(2)})">` +
      cube(size, SNAKE_SHADES[sIdx]) +
      `</g></g>`,
  );
}

const overlay =
  `<style>` +
  `.eat{animation-duration:${DURATION}s;animation-timing-function:linear;animation-iteration-count:infinite}` +
  `.snkx{animation-name:snk;animation-duration:${DURATION}s;animation-timing-function:linear;animation-iteration-count:infinite;animation-fill-mode:both}` +
  eatKeyframes.filter((k) => k.startsWith("@keyframes eat")).map((_, i) => `.eat${i}{animation-name:eat${i}}`).join("") +
  eatKeyframes.join("") +
  `</style>` +
  `<g id="snake-overlay">${segments.join("")}</g>`;

const idx = rewritten.lastIndexOf("</svg>");
if (idx === -1) throw new Error("no closing </svg> tag");
writeFileSync(output, rewritten.slice(0, idx) + overlay + rewritten.slice(idx));

const towers = cells.filter((c) => c.tower).length;
console.log(
  `${output}  ${cells.length} cells, ${towers} towers eaten, ` +
    `${steps}-step circuit, ${SNAKE_LEN} cubes`,
);
