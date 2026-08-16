/**
 * activity-graph — the last few weeks of contributions drawn as a cardiac
 * monitor trace, beating on a loop.
 *
 * This replaces github-readme-activity-graph.vercel.app. That service renders
 * on its own host, so its output could not be animated from here — and a free
 * third-party host is the thing on this profile most likely to start returning
 * 402s one morning. Generated here, committed to the repo, it cannot go down.
 *
 * The animation is one sweep per loop: a ghost of the whole trace is always
 * visible so the shape reads at a glance, a bright line draws itself across it
 * behind a glowing head, each peak blips as the head reaches it, then the whole
 * trace holds long enough to be read before fading back to the ghost.
 *
 * The head rides `offset-path` while the line is drawn by `stroke-dashoffset`.
 * Both are parameterised by path length, so they stay in step for free — an
 * x-based wipe would drift ahead of the head on the steep segments.
 *
 * Animation is CSS keyframes rather than SMIL, so one shared definition can
 * drive several elements at different phases. Both run inside an <img>; a
 * screenshot of one can return a stale raster and look frozen, so force a
 * repaint before believing it is broken.
 *
 * Usage: GITHUB_TOKEN=... node scripts/activity-graph.mjs <login>
 */

import { writeFileSync, mkdirSync } from "node:fs";

const LOGIN = process.argv[2] || "hykelauncher";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

// ---------------------------------------------------------------- geometry --
const DAYS = 42; // six weeks: enough spikes to have a rhythm, still legible
const W = 900;
const H = 260;
const PAD = { l: 44, r: 22, t: 56, b: 34 };
const PLOT_W = W - PAD.l - PAD.r;
const PLOT_H = H - PAD.t - PAD.b;
const BEAT = 8; // seconds per sweep
const DRAWN = 62; // % of the loop spent drawing…
const HELD = 88; // …then holding the finished trace, then fading back

const THEMES = {
  dark: {
    bg: "#1a1b27",
    grid: "#252740",
    ghost: "#2f3358",
    line: "#70a5fd",
    glow: "#bf91f3",
    title: "#70a5fd",
    text: "#38bdae",
    muted: "#565f89",
  },
  light: {
    bg: "#ffffff",
    grid: "#eaeef2",
    ghost: "#d0d7de",
    line: "#0969da",
    glow: "#8250df",
    title: "#0969da",
    text: "#1a7f37",
    muted: "#6e7781",
  },
};

// -------------------------------------------------------------------- data --
async function fetchCalendar(login) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "activity-graph",
    },
    body: JSON.stringify({
      query: `query($login:String!){
        user(login:$login){
          contributionsCollection{
            contributionCalendar{
              totalContributions
              weeks{ contributionDays{ date contributionCount } }
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

/** The last DAYS days, oldest first. */
function recentDays(calendar) {
  const all = calendar.weeks.flatMap((w) => w.contributionDays);
  return all.slice(-DAYS);
}

// ------------------------------------------------------------------ render --
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

function render(days, theme, login) {
  const t = THEMES[theme];
  const peak = Math.max(1, ...days.map((d) => d.contributionCount));
  const total = days.reduce((n, d) => n + d.contributionCount, 0);
  const active = days.filter((d) => d.contributionCount > 0).length;

  const x = (i) => PAD.l + (i * PLOT_W) / (days.length - 1);
  const y = (c) => PAD.t + PLOT_H - (c / peak) * PLOT_H;
  const pts = days.map((d, i) => ({
    x: x(i),
    y: y(d.contributionCount),
    count: d.contributionCount,
    date: new Date(d.date),
  }));

  // Straight segments, not a spline: a monitor trace is sharp, and a spline
  // would round the peaks off into hills.
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${(PAD.t + PLOT_H).toFixed(1)} L${pts[0].x.toFixed(1)},${(PAD.t + PLOT_H).toFixed(1)} Z`;

  // Where along the drawn line each point falls, so a peak can blip exactly as
  // the head reaches it rather than on a guess from its x.
  const runs = [0];
  for (let i = 1; i < pts.length; i++) {
    runs.push(runs[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const length = runs[runs.length - 1];

  const grid = [];
  for (let n = 0; n <= 4; n++) {
    const gy = (PAD.t + (n * PLOT_H) / 4).toFixed(1);
    grid.push(
      `<line x1="${PAD.l}" y1="${gy}" x2="${W - PAD.r}" y2="${gy}" stroke="${t.grid}" stroke-width="1"/>`,
    );
  }
  for (let i = 0; i < days.length; i += 7) {
    grid.push(
      `<line x1="${x(i).toFixed(1)}" y1="${PAD.t}" x2="${x(i).toFixed(1)}" y2="${PAD.t + PLOT_H}" stroke="${t.grid}" stroke-width="1"/>`,
    );
  }

  const labels = [];
  for (let i = 0; i < days.length; i += 7) {
    const d = pts[i].date;
    labels.push(
      `<text x="${x(i).toFixed(1)}" y="${H - 12}" fill="${t.muted}" font-size="11" text-anchor="middle">${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}</text>`,
    );
  }
  // The last tick can land up to six days short of today. Say where the trace
  // actually ends — how recent this is happens to be the point.
  const last = pts[pts.length - 1];
  if ((days.length - 1) % 7 >= 3) {
    labels.push(
      `<text x="${(W - PAD.r).toFixed(1)}" y="${H - 12}" fill="${t.muted}" font-size="11" text-anchor="end">${MONTHS[last.date.getUTCMonth()]} ${last.date.getUTCDate()}</text>`,
    );
  }
  labels.push(
    `<text x="${PAD.l - 8}" y="${(PAD.t + 4).toFixed(1)}" fill="${t.muted}" font-size="11" text-anchor="end">${peak}</text>`,
    `<text x="${PAD.l - 8}" y="${(PAD.t + PLOT_H + 4).toFixed(1)}" fill="${t.muted}" font-size="11" text-anchor="end">0</text>`,
  );

  // The days worth calling out: the busiest few, each getting a ring as the
  // head passes. Every spike blipping at once would read as noise.
  const marks = pts
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.count >= Math.max(2, peak * 0.5))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const blips = [];
  const blipKeyframes = [];
  marks.forEach((p, n) => {
    const at = (runs[p.i] / length) * DRAWN;
    const gone = Math.min(HELD, at + 9);
    blipKeyframes.push(
      `@keyframes blip${n}{0%,${Math.max(0, at - 0.4).toFixed(2)}%{transform:scale(.2);opacity:0}` +
        `${at.toFixed(2)}%{transform:scale(1);opacity:.85}` +
        `${gone.toFixed(2)}%,100%{transform:scale(2.6);opacity:0}}`,
    );
    blips.push(
      `<circle class="blip b${n}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5"` +
        ` fill="none" stroke="${t.glow}" stroke-width="1.6"/>`,
    );
  });

  const style =
    `<style>` +
    `.trace{stroke-dasharray:${length.toFixed(1)};animation:draw ${BEAT}s linear infinite}` +
    `.head{animation:ride ${BEAT}s linear infinite;offset-path:path("${line}");offset-rotate:0deg}` +
    // The head keeps its own time — a pulse roughly once a second, independent
    // of how far along the trace it happens to be.
    `.pulse{transform-box:fill-box;transform-origin:center;animation:pulse .95s ease-out infinite}` +
    `.halo{transform-box:fill-box;transform-origin:center;animation:halo .95s ease-out infinite}` +
    `.blip{transform-box:fill-box;transform-origin:center;animation-duration:${BEAT}s;` +
    `animation-timing-function:ease-out;animation-iteration-count:infinite}` +
    blipKeyframes.map((_, n) => `.b${n}{animation-name:blip${n}}`).join("") +
    // The line is invisible at both ends of the loop (fully dashed out), so the
    // opacity can snap back to 1 at 0% without anything visibly popping in.
    `@keyframes draw{0%{stroke-dashoffset:${length.toFixed(1)};opacity:1}` +
    `${DRAWN}%,${HELD}%{stroke-dashoffset:0;opacity:1}` +
    `99%,100%{stroke-dashoffset:0;opacity:0}}` +
    `@keyframes ride{0%{offset-distance:0%;opacity:1}` +
    `${DRAWN}%{offset-distance:100%;opacity:1}` +
    `${(DRAWN + 4).toFixed(0)}%,100%{offset-distance:100%;opacity:0}}` +
    `@keyframes pulse{0%,70%,100%{transform:scale(1)}12%{transform:scale(1.45)}30%{transform:scale(.92)}}` +
    `@keyframes halo{0%{transform:scale(.6);opacity:.55}70%,100%{transform:scale(2.6);opacity:0}}` +
    blipKeyframes.join("") +
    `</style>`;

  const defs =
    `<defs>` +
    `<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${t.line}" stop-opacity="0.22"/>` +
    `<stop offset="100%" stop-color="${t.line}" stop-opacity="0"/>` +
    `</linearGradient>` +
    `<filter id="glow" x="-60%" y="-60%" width="220%" height="220%">` +
    `<feGaussianBlur stdDeviation="3" result="b"/>` +
    `<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>` +
    `</filter>` +
    `</defs>`;

  const header =
    `<text x="${PAD.l}" y="30" fill="${t.title}" font-size="17" font-weight="600">Contribution activity</text>` +
    `<text x="${W - PAD.r}" y="30" fill="${t.text}" font-size="13" text-anchor="end">` +
    `${total} contributions · ${active}/${days.length} days active · peak ${peak}</text>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"` +
    ` font-family="Segoe UI,Ubuntu,DejaVu Sans,sans-serif" role="img"` +
    ` aria-label="Contribution activity for ${esc(login)}: ${total} contributions over the last ${days.length} days, busiest day ${peak}">` +
    style +
    defs +
    `<rect width="${W}" height="${H}" rx="10" fill="${t.bg}"/>` +
    header +
    grid.join("") +
    // Always-on ghost, so the shape is readable the instant the image loads —
    // an employer should not have to wait out a sweep to see anything.
    `<path d="${area}" fill="url(#fade)"/>` +
    `<path d="${line}" fill="none" stroke="${t.ghost}" stroke-width="2"` +
    ` stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path class="trace" d="${line}" fill="none" stroke="${t.line}" stroke-width="2.4"` +
    ` stroke-linejoin="round" stroke-linecap="round" filter="url(#glow)"/>` +
    blips.join("") +
    `<g class="head">` +
    `<circle class="halo" r="6" fill="none" stroke="${t.glow}" stroke-width="1.4"/>` +
    `<circle class="pulse" r="4.5" fill="${t.glow}" filter="url(#glow)"/>` +
    `</g>` +
    labels.join("") +
    `</svg>`
  );
}

// -------------------------------------------------------------------- main --
const calendar = await fetchCalendar(LOGIN);
const days = recentDays(calendar);

mkdirSync("activity", { recursive: true });
for (const theme of ["dark", "light"]) {
  const svg = render(days, theme, LOGIN);
  const file = `activity/activity-${theme}.svg`;
  writeFileSync(file, svg);
  console.log(`${file}  ${(svg.length / 1024).toFixed(1)} KB`);
}
