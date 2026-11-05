// Generates frontend/public/cyberpunk-city.svg — a neon canyon street in
// one-point perspective, the way the reference photos read: two walls of
// towers converging on a hazy bright vanishing point, signage hung off the
// facades, wet asphalt carrying the colours back down.
//
// Deterministic: same seed, same bytes. Regenerate with
//   node tools/gen-cyberpunk-city.mjs
import { writeFileSync } from "node:fs";

let seed = 20261106;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const between = (a, b) => a + rnd() * (b - a);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const n = (v) => Number(v.toFixed(1));

const W = 1920;
const H = 760;
const HORIZON = 470;
const VP = { x: 960, y: 478 };
const STREET = 600;

const NEON = ["#59f6ff", "#ff5fb0", "#a06bff", "#ffb36b", "#ff3d6e", "#6bffd0"];
const WINDOW = ["#9fe9ff", "#ffd0a4", "#ffb4d8", "#c7b8ff", "#ffe9c9"];

const quad = (pts, fill, extra = "") =>
  `<polygon points="${pts.map(([x, y]) => `${n(x)},${n(y)}`).join(" ")}" fill="${fill}"${extra}/>`;
const line = (x1, y1, x2, y2, stroke, w, extra = "") =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${w}"${extra}/>`;
const rect = (x, y, w, h, fill, extra = "") =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"${extra}/>`;

const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Cyberpunk street: neon signage on converging towers above wet asphalt">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#04050e"/>
  <stop offset=".45" stop-color="#0c0b22"/>
  <stop offset=".72" stop-color="#241338"/>
  <stop offset="1" stop-color="#4b1c40"/>
</linearGradient>
<linearGradient id="asphalt" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#0d0b18"/>
  <stop offset=".35" stop-color="#0a0813"/>
  <stop offset="1" stop-color="#04030a"/>
</linearGradient>
<linearGradient id="fog" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#ff6ba8" stop-opacity="0"/>
  <stop offset=".45" stop-color="#ff6ba8" stop-opacity=".3"/>
  <stop offset=".75" stop-color="#ffb0cf" stop-opacity=".2"/>
  <stop offset="1" stop-color="#59f6ff" stop-opacity=".16"/>
</linearGradient>
<radialGradient id="vpGlow" cx=".5" cy=".5" r=".5">
  <stop offset="0" stop-color="#ffd9e6" stop-opacity=".85"/>
  <stop offset=".35" stop-color="#ff6ba8" stop-opacity=".42"/>
  <stop offset=".7" stop-color="#7a3bb0" stop-opacity=".14"/>
  <stop offset="1" stop-color="#0a0814" stop-opacity="0"/>
</radialGradient>
<radialGradient id="streetGlow" cx=".5" cy="0" r=".9">
  <stop offset="0" stop-color="#ff5fa2" stop-opacity=".3"/>
  <stop offset=".55" stop-color="#7a2f74" stop-opacity=".12"/>
  <stop offset="1" stop-color="#05040b" stop-opacity="0"/>
</radialGradient>
<radialGradient id="vignette" cx=".5" cy=".42" r=".8">
  <stop offset=".5" stop-color="#000" stop-opacity="0"/>
  <stop offset="1" stop-color="#000" stop-opacity=".66"/>
</radialGradient>
<linearGradient id="reflCyan" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#59f6ff" stop-opacity=".5"/>
  <stop offset=".45" stop-color="#59f6ff" stop-opacity=".12"/>
  <stop offset="1" stop-color="#59f6ff" stop-opacity="0"/>
</linearGradient>
<linearGradient id="reflMagenta" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#ff5fb0" stop-opacity=".5"/>
  <stop offset=".45" stop-color="#ff5fb0" stop-opacity=".12"/>
  <stop offset="1" stop-color="#ff5fb0" stop-opacity="0"/>
</linearGradient>
<linearGradient id="reflViolet" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#a06bff" stop-opacity=".45"/>
  <stop offset=".45" stop-color="#a06bff" stop-opacity=".1"/>
  <stop offset="1" stop-color="#a06bff" stop-opacity="0"/>
</linearGradient>
<linearGradient id="reflAmber" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#ffb36b" stop-opacity=".4"/>
  <stop offset=".45" stop-color="#ffb36b" stop-opacity=".1"/>
  <stop offset="1" stop-color="#ffb36b" stop-opacity="0"/>
</linearGradient>
<filter id="glow" x="-70%" y="-70%" width="240%" height="240%">
  <feGaussianBlur stdDeviation="9"/>
</filter>
<filter id="glowTight" x="-50%" y="-50%" width="200%" height="200%">
  <feGaussianBlur stdDeviation="3"/>
</filter>
<filter id="bokeh" x="-90%" y="-90%" width="280%" height="280%">
  <feGaussianBlur stdDeviation="20"/>
</filter>
</defs>
`);

// ── sky, stars, distant haze ─────────────────────────────────────────────────
out.push(`<rect x="-20" y="-20" width="${W + 40}" height="${H + 40}" fill="url(#sky)"/>`);
for (let i = 0; i < 110; i++) {
  out.push(`<circle cx="${n(between(0, W))}" cy="${n(between(0, 300))}" r="${between(0.4, 1.2).toFixed(1)}" fill="#e6ecff" opacity="${between(0.1, 0.4).toFixed(2)}"/>`);
}

// ── the canyon walls ────────────────────────────────────────────────────────
// Each wall is a run of bays. Bays compress toward the vanishing point, so the
// near towers are huge and the far ones become slivers — that compression is
// what makes the street read as a canyon rather than a backdrop.
const walls = {
  left: { nearX: -110, farX: 905, nearTop: -140, farTop: 408, nearBot: 700, farBot: 486, dir: 1 },
  right: { nearX: W + 110, farX: 1015, nearTop: -140, farTop: 408, nearBot: 700, farBot: 486, dir: -1 },
};
const BAYS = 10;
const EASE = 2.6;
// Per-bay roof heights. Without this every bay shares one computed top and the
// wall reads as a single corridor; a jagged profile turns it back into towers.
const ROOFS = { left: [150, 30, -40, 96, -10, 60, 120, 46, 110, 80], right: [-20, 110, 40, -50, 70, 10, 130, 54, 100, 76] };

const signs = []; // remembered so the street can reflect them
const glyphs = [];
function facadeBay(wall, i, side) {
  const t0 = i / BAYS;
  const t1 = (i + 1) / BAYS;
  const e0 = 1 - Math.pow(1 - t0, EASE);
  const e1 = 1 - Math.pow(1 - t1, EASE);
  const lerp = (a, b, e) => a + (b - a) * e;
  const x0 = lerp(wall.nearX, wall.farX, e0);
  const x1 = lerp(wall.nearX, wall.farX, e1);
  // Roof offset tapers out toward the vanishing point, so near towers get to
  // break the skyline and far ones settle onto the horizon.
  const roof = (ROOFS[side]?.[i] ?? 0) * (1 - e0 * 0.85);
  const top0 = lerp(wall.nearTop, wall.farTop, e0) + roof;
  const top1 = lerp(wall.nearTop, wall.farTop, e1) + roof;
  const bot0 = lerp(wall.nearBot, wall.farBot, e0);
  const bot1 = lerp(wall.nearBot, wall.farBot, e1);
  return { x0, x1, top0, top1, bot0, bot1, e: (e0 + e1) / 2 };
}

for (const side of ["left", "right"]) {
  const wall = walls[side];
  for (let i = 0; i < BAYS; i++) {
    const b = facadeBay(wall, i, side);
    // haze lightens the far bays so the wall recedes instead of stamping flat
    const facadeLight = 7 + b.e * 26 + between(-2, 3);
    out.push(quad([[b.x0, b.top0], [b.x1, b.top1], [b.x1, b.bot1], [b.x0, b.bot0]], `hsl(258 40% ${n(facadeLight)}%)`));
    // roof edge, lit
    out.push(line(b.x0, b.top0, b.x1, b.top1, pick(["#59f6ff", "#a06bff", "#ff5fb0"]), i < 3 ? 2.4 : 1.4, ' opacity=".45"'));
    // rooftop clutter: a cornice and an antenna, so the profile is not a clean cut
    out.push(quad([[b.x0, b.top0], [b.x1, b.top1], [b.x1, b.top1 + 7], [b.x0, b.top0 + 7]], "#06050f", ' opacity=".9"'));
    if (i < 6 && rnd() < 0.7) {
      const ax = b.x0 + (b.x1 - b.x0) * between(0.25, 0.75);
      const ay = b.top0 + (b.top1 - b.top0) * 0.5;
      out.push(line(ax, ay, ax, ay - between(16, 48), "#05040c", 1.6, ' opacity=".9"'));
      out.push(`<circle cx="${n(ax)}" cy="${n(ay - between(16, 48))}" r="2" fill="#ff4d6d" opacity=".8"/>`);
    }

    // structural ribs + window grid, both in wall space so they converge
    const cols = i < 3 ? 5 : i < 6 ? 4 : 3;
    const rows = i < 3 ? 24 : i < 6 ? 17 : 11;
    for (let c = 0; c <= cols; c++) {
      const f = c / cols;
      const xt = b.x0 + (b.x1 - b.x0) * f;
      out.push(line(xt, b.top0 + (b.top1 - b.top0) * f, xt, b.bot0 + (b.bot1 - b.bot0) * f, "#04040b", c === 0 || c === cols ? 2 : 1.1, ' opacity=".55"'));
    }
    for (let r = 0; r <= rows; r++) {
      const f = r / rows;
      const yl = b.top0 + (b.bot0 - b.top0) * f;
      const yr = b.top1 + (b.bot1 - b.top1) * f;
      out.push(line(b.x0, yl, b.x1, yr, "#04040b", 0.9, ' opacity=".35"'));
    }
    // lit windows
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (rnd() < 0.62) continue;
        const fx0 = c / cols + 0.14 / cols;
        const fx1 = (c + 0.78) / cols;
        const fy0 = r / rows + 0.16 / rows;
        const fy1 = (r + 0.72) / rows;
        const p = (fx, fy) => {
          const xt = b.x0 + (b.x1 - b.x0) * fx;
          const yt = b.top0 + (b.top1 - b.top0) * fx;
          const yb = b.bot0 + (b.bot1 - b.bot0) * fx;
          return [xt, yt + (yb - yt) * fy];
        };
        out.push(quad([p(fx0, fy0), p(fx1, fy0), p(fx1, fy1), p(fx0, fy1)], pick(WINDOW), ` opacity="${between(0.18, 0.7).toFixed(2)}"`));
      }
    }
  }
}
out.push(`<ellipse cx="${VP.x}" cy="${VP.y}" rx="430" ry="230" fill="url(#vpGlow)" opacity=".85"/>`);

// ── signage on the walls ────────────────────────────────────────────────────
// A sign is a patch of the wall painted bright: it is drawn from the same two
// edge lines as the windows, so it lies ON the facade instead of floating in
// front of it.
function wallPatch(b, fx0, fx1, fy0, fy1) {
  const at = (fx, fy) => {
    const xt = b.x0 + (b.x1 - b.x0) * fx;
    const yt = b.top0 + (b.top1 - b.top0) * fx;
    const yb = b.bot0 + (b.bot1 - b.bot0) * fx;
    return [xt, yt + (yb - yt) * fy];
  };
  return [at(fx0, fy0), at(fx1, fy0), at(fx1, fy1), at(fx0, fy1)];
}

for (const side of ["left", "right"]) {
  const wall = walls[side];
  for (let i = 0; i < BAYS; i++) {
    const b = facadeBay(wall, i, side);
    const count = i < 5 ? 2 : 1;
    for (let s = 0; s < count; s++) {
      if (rnd() < 0.18) continue;
      const color = pick(NEON);
      if (rnd() < 0.55) {
        // vertical blade sign, the kind stacked down the facades in the refs
        const w0 = between(0.08, 0.42);
        const w1 = w0 + between(0.16, 0.3);
        const h0 = between(0.1, 0.5);
        const h1 = Math.min(0.95, h0 + between(0.18, 0.38));
        const pts = wallPatch(b, w0, w1, h0, h1);
        signs.push({ pts, color });
        out.push(`<g filter="url(#glow)" opacity=".65">${quad(pts, color)}</g>`);
        out.push(quad(pts, color, ' opacity=".82"'));
        // glyph cells stacked down the blade
        const cells = Math.max(2, Math.round((h1 - h0) / 0.07));
        for (let g = 0; g < cells; g++) {
          const gy0 = h0 + ((h1 - h0) / cells) * (g + 0.24);
          const gy1 = h0 + ((h1 - h0) / cells) * (g + 0.74);
          glyphs.push(quad(wallPatch(b, w0 + 0.05, w1 - 0.05, gy0, gy1), "#080611", ' opacity=".78"'));
        }
      } else {
        // horizontal band / billboard across the facade
        const h0 = between(0.18, 0.62);
        const h1 = Math.min(0.94, h0 + between(0.08, 0.16));
        const pts = wallPatch(b, 0.06, 0.94, h0, h1);
        signs.push({ pts, color });
        out.push(`<g filter="url(#glow)" opacity=".55">${quad(pts, color)}</g>`);
        out.push(quad(pts, color, ' opacity=".8"'));
        for (let g = 0; g < 5; g++) {
          glyphs.push(quad(wallPatch(b, 0.1 + g * 0.17, 0.1 + g * 0.17 + 0.1, h0 + 0.25 * (h1 - h0), h0 + 0.7 * (h1 - h0)), "#080611", ' opacity=".72"'));
        }
      }
    }
  }
}

// ── far end of the street: stacked billboards on distant towers, in fog ──────
// Silhouettes first, so the vanishing point reads as a city continuing rather
// than a lit hole.
for (let i = 0; i < 7; i++) {
  const w = between(40, 96);
  const x = between(800, 1080) - w / 2;
  const h = between(70, 190);
  const y = HORIZON - h + 26;
  out.push(quad([[x, y], [x + w, y], [x + w, HORIZON + 20], [x, HORIZON + 20]], `hsl(262 34% ${12 + i}%)`, ' opacity=".92"'));
  for (let k = 0; k < 10; k++) {
    if (rnd() < 0.55) continue;
    out.push(`<rect x="${n(x + between(5, w - 10))}" y="${n(y + between(6, h - 12))}" width="3" height="3" fill="${pick(WINDOW)}" opacity="${between(0.25, 0.7).toFixed(2)}"/>`);
  }
}
const farSigns = [
  [802, 300, 150, 74, "#ff5fb0"],
  [978, 336, 132, 62, "#59f6ff"],
  [858, 392, 200, 70, "#a06bff"],
  [1040, 286, 96, 130, "#ffb36b"],
];
for (const [x, y, w, h, color] of farSigns) {
  out.push(`<g filter="url(#glow)" opacity=".5">${`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`}</g>`);
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}" opacity=".72"/>`);
  out.push(`<rect x="${x + 8}" y="${y + 10}" width="${w - 16}" height="${h * 0.22}" fill="#080611" opacity=".8"/>`);
  out.push(`<rect x="${x + 8}" y="${y + h * 0.52}" width="${(w - 16) * 0.6}" height="${h * 0.16}" fill="#080611" opacity=".7"/>`);
}
out.push(`<rect x="0" y="300" width="${W}" height="250" fill="url(#fog)"/>`);
out.push(`<g filter="url(#bokeh)" opacity=".35"><ellipse cx="960" cy="470" rx="260" ry="90" fill="#ffd0e2"/></g>`);
out.push(glyphs.join(""));

// ── cables strung across the canyon ─────────────────────────────────────────
for (let i = 0; i < 7; i++) {
  const y0 = between(120, 420);
  const sag = between(14, 46);
  out.push(`<path d="M${n(between(-40, 60))} ${n(y0)} Q960 ${n(y0 + sag)} ${n(between(1860, 1960))} ${n(y0 + between(-10, 30))}" fill="none" stroke="#04030b" stroke-width="${between(1, 2).toFixed(1)}" opacity=".8"/>`);
}

// ── wet street ──────────────────────────────────────────────────────────────
out.push(`<rect x="0" y="${STREET}" width="${W}" height="${H - STREET}" fill="url(#asphalt)"/>`);
out.push(line(0, STREET, W, STREET, "#161028", 3, ' opacity=".9"'));
out.push(`<rect x="0" y="${STREET}" width="${W}" height="${H - STREET}" fill="url(#streetGlow)"/>`);

// reflection of each sign: a narrow gradient smear that fades before the
// viewer, the way a wet road actually carries a light.
const REFLECT = ["reflCyan", "reflMagenta", "reflViolet", "reflAmber"];
for (const { pts } of signs) {
  const xs = pts.map((p) => p[0]);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const w = Math.max(16, right - left);
  const rw = Math.min(34, Math.max(8, w * 0.35));
  for (let k = 0; k < 2; k++) {
    const sx = left + between(0, Math.max(1, w - rw));
    out.push(`<rect x="${n(sx)}" y="${STREET + 2}" width="${n(rw)}" height="${n(between(70, 140))}" fill="url(#${pick(REFLECT)})" opacity="${between(0.35, 0.8).toFixed(2)}"/>`);
  }
}
// lane sheen converging on the vanishing point
for (let i = 0; i < 26; i++) {
  const y = between(STREET + 8, H);
  const x = between(0, W);
  const len = between(40, 220) * (1 - (y - STREET) / (H - STREET) * 0.5);
  out.push(line(x, y, x + len, y, pick(NEON), between(0.5, 2), ` opacity="${between(0.05, 0.16).toFixed(2)}"`));
}
// puddles
for (let i = 0; i < 12; i++) {
  out.push(`<ellipse cx="${n(between(0, W))}" cy="${n(between(STREET + 40, H - 20))}" rx="${n(between(40, 180))}" ry="${n(between(3, 9))}" fill="${pick(NEON)}" opacity="${between(0.05, 0.13).toFixed(2)}"/>`);
}
// the kerb catches the brightest light in the scene
for (let i = 0; i < 18; i++) {
  out.push(`<ellipse cx="${n(between(0, W))}" cy="${n(between(STREET + 4, STREET + 26))}" rx="${n(between(30, 140))}" ry="${n(between(1.5, 4))}" fill="${pick(NEON)}" opacity="${between(0.1, 0.22).toFixed(2)}"/>`);
}

// ── foreground silhouettes ──────────────────────────────────────────────────
// Street furniture close to the camera: two stall canopies framing the shot,
// a low railing, and a handful of pedestrians between them. All silhouette, so
// the eye stays on the signage.
out.push(`<g fill="#030208">`);
// left stall
out.push(quad([[-40, 470], [250, 545], [250, 700], [-40, 700]], "#04030a"));
out.push(quad([[-40, 452], [268, 530], [268, 560], [-40, 484]], "#05040c"));
out.push(rect(232, 540, 10, 160, "#04030a"));
// right stall
out.push(quad([[W + 40, 500], [W - 230, 556], [W - 230, 700], [W + 40, 700]], "#04030a"));
out.push(quad([[W + 40, 484], [W - 248, 540], [W - 248, 570], [W + 40, 514]], "#05040c"));
out.push(rect(W - 242, 548, 10, 152, "#04030a"));
out.push(`</g>`);
// warm spill from the two stalls
out.push(`<ellipse cx="150" cy="620" rx="150" ry="70" fill="#ffb36b" opacity=".1" filter="url(#bokeh)"/>`);
out.push(`<ellipse cx="${W - 150}" cy="630" rx="130" ry="60" fill="#ff5fb0" opacity=".1" filter="url(#bokeh)"/>`);

out.push(`<g fill="#030208">`);
out.push(`<rect x="0" y="${H - 46}" width="${W}" height="4"/>`);
out.push(`<rect x="0" y="${H - 16}" width="${W}" height="3"/>`);
for (let i = 0; i < 46; i++) out.push(`<rect x="${n(between(0, W))}" y="${H - 46}" width="${n(between(2, 3.5))}" height="46"/>`);
for (let i = 0; i < 5; i++) {
  const px = between(320, W - 320);
  const ph = between(40, 60);
  const py = H - 42;
  out.push(`<circle cx="${n(px)}" cy="${n(py - ph)}" r="${n(ph * 0.1)}"/>`);
  out.push(`<path d="M${n(px - ph * 0.14)} ${n(py)} L${n(px - ph * 0.11)} ${n(py - ph * 0.7)} Q${n(px)} ${n(py - ph * 0.88)} ${n(px + ph * 0.11)} ${n(py - ph * 0.7)} L${n(px + ph * 0.14)} ${n(py)} Z"/>`);
}
out.push(`</g>`);
for (let i = 0; i < 10; i++) {
  out.push(`<circle cx="${n(between(0, W))}" cy="${n(between(340, H))}" r="${n(between(8, 26))}" fill="${pick(NEON)}" opacity="${between(0.04, 0.1).toFixed(2)}" filter="url(#bokeh)"/>`);
}
out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#vignette)"/>`);
out.push(`</svg>
`);

writeFileSync(new URL("../frontend/public/cyberpunk-city.svg", import.meta.url), out.join("\n"));
console.log("wrote frontend/public/cyberpunk-city.svg", out.join("\n").length, "bytes");
