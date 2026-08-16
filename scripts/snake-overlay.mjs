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
 * Route: it plays the game rather than sweeping. From wherever the head is it
 * takes the shortest way to the nearest tower it has not eaten yet, one cell at
 * a time in the four lattice directions, and never into its own body — so the
 * board empties in the long runs and sudden corners of a snake game.
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

const STEP = 0.08; // seconds per cell
const LOOP_MAX = 42; // …but never a loop longer than this
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

// --------------------------------------------------------------- plot a route --
// The snake hunts: shortest way to the nearest tower still standing, replanned
// after every meal. Anything it crosses on the way is eaten too, so a leg often
// ends up feeding it several towers.
//
// The route has to close. Every segment replays one shared keyframes track at a
// different phase, so if the last cell were not next to the first the whole
// snake would streak across the board once per loop.
const key = (w, d) => `${w},${d}`;
const STEPS_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const around = (k) => {
  const [w, d] = k.split(",").map(Number);
  return STEPS_4.map(([dw, dd]) => key(w + dw, d + dd)).filter((n) => byCell.has(n));
};

// Breadth-first to the closest cell that `wanted` accepts, never entering a
// `blocked` one. Returns the cells to walk through, the starting cell excluded.
const routeTo = (from, wanted, blocked) => {
  const cameFrom = new Map([[from, null]]);
  const queue = [from];
  for (let q = 0; q < queue.length; q++) {
    const here = queue[q];
    if (here !== from && wanted(here)) {
      const leg = [];
      for (let k = here; k !== from; k = cameFrom.get(k)) leg.unshift(k);
      return leg;
    }
    for (const next of around(here)) {
      if (cameFrom.has(next) || blocked.has(next)) continue;
      cameFrom.set(next, here);
      queue.push(next);
    }
  }
  return null;
};

const home = key(0, 0); // the oldest corner of the calendar
const standing = new Set();
cells.forEach((c, i) => {
  if (c.tower) standing.add(key(wd(i).w, wd(i).d));
});

const walk = [home];
standing.delete(home); // whatever it starts on, it starts by eating

// The body is the last few cells the head came through. It has usually moved on
// by the time the head could reach them again, so keeping a whole leg clear of
// them is pessimistic — hence the second, unblocked attempt.
const body = () => new Set(walk.slice(-(SNAKE_LEN - 1)));

let legs = 0;
while (standing.size) {
  const from = walk[walk.length - 1];
  const hunt = (k) => standing.has(k);
  const leg = routeTo(from, hunt, body()) ?? routeTo(from, hunt, new Set());
  if (!leg) break; // lattice is one piece, so this means something is very wrong
  for (const k of leg) {
    walk.push(k);
    standing.delete(k);
  }
  legs++;
}

for (const k of routeTo(walk[walk.length - 1], (k) => k === home, body()) ?? []) {
  walk.push(k);
}
if (walk[walk.length - 1] === home) walk.pop(); // the 100% stop lands there

const path = walk.map((k) => byCell.get(k));
const steps = path.length;
if (standing.size) {
  throw new Error(`${standing.size} towers unreachable — lattice is not one piece?`);
}

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

  // Squashed flat by the time the head lands on it, not after: the snake runs
  // along the ground plane, so a tower still standing there would be wearing it.
  const k = eatKeyframes.length;
  const g = c.ground.toFixed(2);
  const arrival = eatAt.get(seen - 1) ?? 0;
  const start = (Math.max(0, arrival - 1.2) / steps) * 100;
  const end = (Math.max(arrival, 0.4) / steps) * 100;
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

// The snake travels the ground plane, never the tower tops. Climbing looked
// like a staircase — the head up on a tower with the middle of the body strung
// out on an invisible ramp behind it — and once the route doubles back, a stale
// tower height leaves the snake walking on air over ground it already cleared.
// Towers get out of its way instead: each one finishes collapsing on the step
// the head arrives (see the eat keyframes above), so the lane is always flat.
const perch = (k, s) => {
  const c = cells[path[k % steps]];
  return {
    x: c.x + CELL - s,
    y: c.ground - s * 0.62 * 1.15,
  };
};

// One shared track sized for the head. A tapered segment's perch differs from
// the head's by a constant, so each cube carries that as a static inner
// translate instead of duplicating the whole track per segment.
const DURATION = Math.min(LOOP_MAX, Math.max(6, Math.round(steps * STEP)));
const stepDur = DURATION / steps;

// Time runs at one cell per stop, so a cell sitting exactly halfway between its
// neighbours is what linear interpolation would have put there anyway. Dropping
// those leaves only the corners and the climbs, which is most of the file back:
// the long runs across empty board cost two stops instead of fifty.
const points = [];
for (let k = 0; k <= steps; k++) points.push(perch(k, HEAD_TOP));
points[steps] = points[0]; // close the loop where it opened

const straight = (a, b, c) =>
  Math.abs(a.x + c.x - 2 * b.x) < 0.05 && Math.abs(a.y + c.y - 2 * b.y) < 0.05;

const stops = [];
for (let k = 0; k <= steps; k++) {
  if (k > 0 && k < steps && straight(points[k - 1], points[k], points[k + 1])) continue;
  const p = points[k];
  stops.push(
    `${((k / steps) * 100).toFixed(4)}%{transform:translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)}`,
  );
}
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
  `${output}  ${cells.length} cells, ${towers} towers eaten over ${legs} hunts, ` +
    `${steps}-step route in ${DURATION}s, ${stops.length} stops, ${SNAKE_LEN} cubes`,
);
