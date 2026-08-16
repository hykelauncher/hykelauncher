/**
 * iso-snake — an isometric 3D contribution graph with a snake that eats it.
 *
 * Platane/snk draws a snake on a flat 2D grid; github-profile-3d-contrib draws
 * a 3D grid with no snake. This does both: each contribution day is an
 * isometric tower, and a snake weaves through the grid flattening every tower
 * it passes over.
 *
 * Animation is CSS keyframes. (An earlier version used SMIL and appeared frozen
 * inside an <img>; that turned out to be a stale screenshot raster rather than
 * a real limitation — SMIL does run there. CSS is kept because one shared
 * keyframes track phase-shifted by animation-delay is the tidier way to drive
 * every snake segment off a single definition.)
 *
 * Output is committed to the repo, so there is no third-party host that can go
 * down.
 *
 * Usage: GITHUB_TOKEN=... node scripts/iso-snake.mjs <login>
 */

import { writeFileSync, mkdirSync } from "node:fs";

const LOGIN = process.argv[2] || "hykelauncher";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

// ---------------------------------------------------------------- geometry --
// Oblique (cavalier) projection rather than true isometric. A 53x7 grid in
// isometric is a thin diagonal ribbon that wastes half its bounding box; this
// keeps the calendar shape — weeks left to right, days top to bottom — while
// still extruding each day into a tower.
const STEP_X = 10; // lattice pitch per week
const STEP_Y = 10; // lattice pitch per weekday
const SKEW = 5; // x shift per weekday, the "depth" cue
const FW = 9; // drawn face width (1px lattice gap)
const FD = 9; // drawn face depth
const FS = 4.5; // face skew, matches SKEW scaled to FD
const PAD_X = 20;
const PAD_TOP = 44; // headroom for the tallest tower
const PAD_BOTTOM = 26; // room for the caption
const TOWER_H = [0, 7, 14, 22, 32]; // pixel height per contribution level
const STEP = 0.08; // seconds per cell
const LOOP_MAX = 42; // …but never a loop longer than this
const SNAKE_LEN = 6;

const THEMES = {
  dark: {
    bg: "none",
    empty: "#1b2130",
    levels: ["#1b2130", "#1f4d33", "#2ea043", "#3fd35f", "#57ffa0"],
    snake: ["#c9ff6d", "#8ef04a", "#5fd83a", "#3fbb31", "#2a9d2a", "#1d7f24"],
    text: "#7d8590",
  },
  light: {
    bg: "none",
    empty: "#ebedf0",
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: ["#1a7f37", "#2da44e", "#3fb950", "#57d364", "#7ee787", "#aff5b4"],
    text: "#57606a",
  },
};

/** Darken a #rrggbb colour by a factor, for the two side faces. */
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(v * f))),
  );
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

/** Lattice origin (top-back-left corner of a cell's ground slab). */
const iso = (col, row) => ({ x: col * STEP_X + row * SKEW, y: row * STEP_Y });

/** Centre of a cell's ground slab, where the snake rides. */
const centre = (col, row) => {
  const { x, y } = iso(col, row);
  return { x: x + (FW + FS) / 2, y: y + FD / 2 };
};

// -------------------------------------------------------------------- data --
async function fetchCalendar(login) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "iso-snake",
    },
    body: JSON.stringify({
      query: `query($login:String!){
        user(login:$login){
          contributionsCollection{
            contributionCalendar{
              totalContributions
              weeks{ contributionDays{ date contributionCount weekday } }
            }
          }
        }
      }`,
      variables: { login },
    }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data.user.contributionsCollection.contributionCalendar;
}

/**
 * GitHub's own colour buckets aren't returned consistently across themes, so
 * derive levels from the counts: quartiles of the non-zero days.
 */
function toLevels(calendar) {
  const counts = calendar.weeks
    .flatMap((w) => w.contributionDays.map((d) => d.contributionCount))
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  const q = (p) => counts[Math.min(counts.length - 1, Math.floor(counts.length * p))] || 1;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];

  const grid = []; // grid[col][row] = level
  calendar.weeks.forEach((week, col) => {
    grid[col] = new Array(7).fill(null);
    week.contributionDays.forEach((day) => {
      const c = day.contributionCount;
      const level = c === 0 ? 0 : c <= q1 ? 1 : c <= q2 ? 2 : c <= q3 ? 3 : 4;
      grid[col][day.weekday] = level;
    });
  });
  return grid;
}

/**
 * The snake plays the game rather than sweeping the grid. From wherever the
 * head is it takes the shortest way to the nearest tower still standing,
 * replans after every meal, and never steps into its own body — so the grid
 * empties in long runs and sudden corners instead of a metronome down the
 * weeks. Towers it merely crosses on the way are eaten too.
 *
 * The route still has to close, because each snake segment is the same
 * animation phase-shifted by a delay — an open path would teleport on loop.
 */
function buildPath(grid, cols, rows) {
  const key = (c, r) => `${c},${r}`;
  const real = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows && grid[c][r] !== null;
  const around = (k) => {
    const [c, r] = k.split(",").map(Number);
    return [
      [c + 1, r],
      [c - 1, r],
      [c, r + 1],
      [c, r - 1],
    ]
      .filter(([a, b]) => real(a, b))
      .map(([a, b]) => key(a, b));
  };

  // Breadth-first to the closest cell that `wanted` accepts, never entering a
  // `blocked` one. Returns the cells to walk through, the start excluded.
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

  // The oldest real day on the calendar — the first week is usually a stub.
  let home = null;
  for (let c = 0; c < cols && !home; c++) {
    for (let r = 0; r < rows && !home; r++) if (real(c, r)) home = key(c, r);
  }

  const standing = new Set();
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) if (grid[c][r] > 0) standing.add(key(c, r));
  }

  const walk = [home];
  standing.delete(home); // whatever it starts on, it starts by eating

  // The body is the last few cells the head came through. It has usually moved
  // on by the time the head could reach them again, so keeping a whole leg
  // clear of them is pessimistic — hence the second, unblocked attempt.
  const body = () => new Set(walk.slice(-(SNAKE_LEN - 1)));

  while (standing.size) {
    const from = walk[walk.length - 1];
    const hunt = (k) => standing.has(k);
    const leg = routeTo(from, hunt, body()) ?? routeTo(from, hunt, new Set());
    if (!leg) break; // the calendar is one piece, so this should not happen
    for (const k of leg) {
      walk.push(k);
      standing.delete(k);
    }
  }
  if (standing.size) throw new Error(`${standing.size} towers unreachable`);

  for (const k of routeTo(walk[walk.length - 1], (k) => k === home, body()) ?? []) {
    walk.push(k);
  }
  if (walk[walk.length - 1] === home) walk.pop(); // the 100% stop lands there

  return walk.map((k) => k.split(",").map(Number));
}

// ------------------------------------------------------------------ render --
function render(grid, theme, totalContributions, login) {
  const t = THEMES[theme];
  const cols = grid.length;
  const rows = 7;

  const path = buildPath(grid, cols, rows);
  const steps = path.length;
  const duration = Math.min(LOOP_MAX, Math.max(6, Math.round(steps * STEP)));
  // Step index at which the snake head reaches each cell (first visit only).
  const eatAt = new Map();
  path.forEach(([c, r], i) => {
    const k = `${c},${r}`;
    if (!eatAt.has(k)) eatAt.set(k, i);
  });

  const W = (cols - 1) * STEP_X + (rows - 1) * SKEW + FW + FS + PAD_X * 2;
  const H = (rows - 1) * STEP_Y + FD + PAD_TOP + PAD_BOTTOM;
  const ox = PAD_X;
  const oy = PAD_TOP;

  const parts = [];
  const towerKeyframes = [];

  // Painted back-to-front. In this projection later weekdays sit lower on
  // screen and towers only ever rise, so ordering by row is sufficient — a
  // tall tower correctly occludes the rows behind it.
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[c][r] === null) continue;
      cells.push([c, r]);
    }
  }

  for (const [c, r] of cells) {
    const level = grid[c][r];
    const { x, y } = iso(c, r);
    const tx = (ox + x).toFixed(1);
    const ty = (oy + y).toFixed(1);

    // Ground slab, always visible — this is what a flattened tower leaves behind.
    let cell =
      `<path d="M0,0 ${FW},0 ${FW + FS},${FD} ${FS},${FD}Z" fill="${t.empty}"/>`;

    if (level > 0) {
      const h = TOWER_H[level];
      const top = t.levels[level];
      const front = shade(top, 0.62);
      const side = shade(top, 0.42);
      const faces =
        `<path d="M${FS},${FD - h} ${FW + FS},${FD - h} ${FW + FS},${FD} ${FS},${FD}Z" fill="${front}"/>` +
        `<path d="M${FW},${-h} ${FW + FS},${FD - h} ${FW + FS},${FD} ${FW},0Z" fill="${side}"/>` +
        `<path d="M0,${-h} ${FW},${-h} ${FW + FS},${FD - h} ${FS},${FD - h}Z" fill="${top}"/>`;

      // Squash the tower flat, finishing on the step the head lands rather than
      // starting there: the snake rides the ground slabs, so a tower still
      // standing when it arrives would be wearing it. transform-box: fill-box
      // puts the origin on the tower's own bounding box, so it collapses down
      // onto its slab rather than toward the SVG origin.
      const i = eatAt.get(`${c},${r}`) ?? 0;
      const p = ((Math.max(0, i - 1.2) / steps) * 100).toFixed(3);
      const pe = ((Math.max(i, 0.4) / steps) * 100).toFixed(3);
      const id = `t${towerKeyframes.length}`;
      towerKeyframes.push(
        `@keyframes ${id}{0%,${p}%{transform:scaleY(1)}${pe}%,100%{transform:scaleY(0)}}`,
      );
      cell += `<g class="t ${id}">${faces}</g>`;
    }
    parts.push(`<g transform="translate(${tx},${ty})">${cell}</g>`);
  }

  // Snake — every segment shares one keyframes track and is phase-shifted by a
  // positive animation-delay so it trails the head. A shared track only works
  // because the path is a closed circuit; an open path would teleport on loop.
  //
  // Time runs at one cell per stop, so a cell sitting exactly halfway between
  // its neighbours is what linear interpolation would have put there anyway.
  // Dropping those leaves only the corners, which is most of the file back: a
  // long run across cleared grid costs two stops instead of fifty.
  const points = path.map(([c, r]) => {
    const { x, y } = centre(c, r);
    return { x: ox + x, y: oy + y - 3 };
  });
  points.push(points[0]); // close the loop where it opened

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
  const snakeKeyframes = `@keyframes snk{${stops.join("")}}`;
  const stepDur = duration / steps;

  const snake = [];
  for (let s = SNAKE_LEN - 1; s >= 0; s--) {
    const rx = 6.5 - s * 0.55;
    const ry = rx * 0.78;
    snake.push(
      `<g class="s" style="animation-delay:${(s * stepDur).toFixed(4)}s">` +
        `<ellipse rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${t.snake[s]}"` +
        (s === 0 ? ` stroke="${theme === "dark" ? "#0d1117" : "#ffffff"}" stroke-width="0.9"` : "") +
        `/></g>`,
    );
  }

  const style =
    `<style>` +
    `.t{transform-box:fill-box;transform-origin:50% 100%;` +
    `animation-duration:${duration}s;animation-timing-function:linear;animation-iteration-count:infinite}` +
    `.s{animation:snk ${duration}s linear infinite both}` +
    towerKeyframes.map((k, i) => `.t${i}{animation-name:t${i}}`).join("") +
    snakeKeyframes +
    towerKeyframes.join("") +
    `</style>`;

  const label =
    `<text x="${PAD_X}" y="${H - 6}" fill="${t.text}"` +
    ` font-family="Segoe UI,Ubuntu,sans-serif" font-size="11">` +
    `@${login} · ${totalContributions} contributions in the last year</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"` +
    ` viewBox="0 0 ${W} ${H}" role="img"` +
    ` aria-label="Isometric 3D contribution graph for ${login} with a snake eating it">` +
    style +
    `<g shape-rendering="crispEdges">${parts.join("")}</g>` +
    snake.join("") +
    label +
    `</svg>`
  );
}

// -------------------------------------------------------------------- main --
const calendar = await fetchCalendar(LOGIN);
const grid = toLevels(calendar);

mkdirSync("iso-snake", { recursive: true });
for (const theme of ["dark", "light"]) {
  const svg = render(grid, theme, calendar.totalContributions, LOGIN);
  const file = `iso-snake/iso-snake-${theme}.svg`;
  writeFileSync(file, svg);
  console.log(`${file}  ${(svg.length / 1024).toFixed(1)} KB`);
}
