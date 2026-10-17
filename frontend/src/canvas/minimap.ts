/**
 * The overview map.
 *
 * Why it exists: the world is 1050x640 tiles (16,800 x 10,240 world px) and the
 * canvas is at most 1232 x 560 CSS px. At MIN_ZOOM (0.0547) a resident is
 * NPC_H (10 world px) * 0.0547 = 0.55 screen px. There is a whole-town zoom,
 * and at that zoom the town is a postage stamp. The main map cannot answer
 * "where am I"; this can.
 *
 * Read-only on purpose. Clicking a 38 x 10 px parcel is ambiguous — the user
 * cannot tell which district they hit — so the rail below the map carries the
 * labels and takes the clicks. The minimap only shows: where the camera is,
 * where the districts are, and where everyone is standing.
 *
 * Nothing here reads engine internals beyond the public surface (cam, viewW,
 * viewH, byId, followId, worldW, worldH), so this module is a leaf: it can be
 * deleted without touching the engine.
 */

import { Pe, vt, V } from "./constants.js";
import { DISTRICT_PARCELS, ROADS, type DistrictParcel } from "@slopagentbook/shared";
import { FORESTS, PAVED_RECTS } from "./scenery.js";
import { MAX_ZOOM, MIN_ZOOM, LABEL_MIN_ZOOM, RANK_COLORS } from "./engine.js";

/** Minimap width in CSS px. Height follows the world's own aspect ratio. */
export const MM_W = 208;
export const MM_H = Math.round((MM_W * vt) / Pe);

/** Tiles per baked pixel. 8 keeps the bake at 132x80 (~40 KB) instead of a
 *  672,000-px full-resolution copy nobody would ever see. */
const BAKE = 8;
const BW = Math.ceil(Pe / BAKE);
const BH = Math.ceil(vt / BAKE);

/** CSS px per tile on the minimap. */
export function mmScale(): number {
  return MM_W / Pe;
}

/** A resident dot, in minimap px. Small enough that 200 of them read as a
 *  scatter rather than a crowd. */
const DOT = 1.6;

/**
 * Ink, read from the CSS theme tokens rather than hardcoded.
 *
 * Same reason the contest HUD does it (WorldCanvas.tsx:82): a hardcoded cream
 * plate is a slab of nothing on the dark theme. Canvas has no `var()`, so the
 * tokens are pulled off the document once per theme and cached — the same
 * trade engine.ts:311 makes for the ground pair, for the same reason
 * (getComputedStyle forces a style recalc).
 */
interface Ink {
  plate: string; rule: string; muted: string; accent: string; ink: string;
  forest: string; paved: string; road: string;
}

let inkTheme = "";
let ink: Ink = {
  plate: "rgba(244,241,234,0.94)", rule: "#1b1915", muted: "#6e675d",
  accent: "#b8863b", ink: "#1b1915", forest: "#9ac77d", paved: "#cbc3ae", road: "#8d8272",
};

function readInk(themeAttr: string | null): Ink {
  const theme = themeAttr ?? "light";
  if (inkTheme === theme || typeof document === "undefined") return ink;
  const cs = getComputedStyle(document.documentElement);
  const get = (n: string, fb: string) => cs.getPropertyValue(n).trim() || fb;
  const isDark = theme === "dark" || theme === "stone";
  ink = {
    plate: get("--hud-paper", ink.plate),
    rule: get("--hud-rule", ink.rule),
    muted: get("--muted", ink.muted),
    accent: get("--accent", ink.accent),
    ink: get("--hud-ink", ink.ink),
    forest: isDark ? "#1c3524" : "#9ac77d",
    paved: isDark ? "#33302a" : "#cbc3ae",
    road: isDark ? "#6b6152" : "#8d8272",
  };
  inkTheme = theme;
  return ink;
}

/**
 * Parks, paved ground and the road network, baked once per theme at 1/8
 * resolution.
 *
 * At 0.198 px per tile a 2-tile road is 0.4 px wide — drawn live it turns into
 * an even grey haze that covers everything. Baked, it costs one drawImage and
 * still reads as "there is a town there".
 *
 * Returns null when there is no 2D context (jsdom), so the caller can fall
 * back to the rest of the minimap rather than throw.
 */
const bakes = new Map<string, HTMLCanvasElement | null>();

function bake(theme: string): HTMLCanvasElement | null {
  if (bakes.has(theme)) return bakes.get(theme)!;
  let made: HTMLCanvasElement | null = null;
  try {
    const c = document.createElement("canvas");
    c.width = BW;
    c.height = BH;
    const g = c.getContext("2d");
    if (g) {
      const i = readInk(theme);
      const k = readInk(theme);
      const paint = (list: readonly { x: number; y: number; w: number; h: number }[], col: string) => {
        g.fillStyle = col;
        for (const r of list) {
          g.fillRect(r.x / BAKE, r.y / BAKE, Math.max(1, r.w / BAKE), Math.max(1, r.h / BAKE));
        }
      };
      paint(FORESTS, k.forest);
      paint(PAVED_RECTS, k.paved);
      // roads last: they sit on top of the ground they are carved into
      g.fillStyle = i.road;
      for (const r of ROADS) {
        g.fillRect(r.x1 / BAKE, r.y1 / BAKE, Math.max(1, (r.x2 - r.x1 + 1) / BAKE), Math.max(1, (r.y2 - r.y1 + 1) / BAKE));
      }
      made = c;
    }
  } catch {
    made = null;
  }
  bakes.set(theme, made);
  return made;
}

export interface MinimapState {
  /** Camera centre and zoom, world px / unitless. */
  cam: { x: number; y: number; zoom: number };
  /** Viewport size in CSS px, to draw the camera's actual footprint. */
  viewW: number;
  viewH: number;
  /** Live residents. Positions are world px. */
  agents: Iterable<{ id: string; x: number; y: number }>;
  followId: string | null;
  /** Parcel name the rail is hovering, highlighted. */
  hover: string | null;
}

/**
 * The camera's footprint on the minimap, in minimap px.
 *
 * Exported because it is the one piece of arithmetic here worth pinning: the
 * rect must be the real view extent, not a fixed box, or the overlay lies to
 * the player at every zoom but 1.
 */
export function cameraRect(cam: { x: number; y: number; zoom: number }, viewW: number, viewH: number): {
  x: number; y: number; w: number; h: number;
} {
  const s = mmScale();
  const z = cam.zoom || 1;
  const halfW = viewW / 2 / z;
  const halfH = viewH / 2 / z;
  return { x: (cam.x - halfW) * s, y: (cam.y - halfH) * s, w: viewW / z * s, h: viewH / z * s };
}

/**
 * The zoom that frames a whole parcel, floored at the point building labels
 * stop being readable.
 *
 * Every parcel fits above the floor at today's numbers (the largest, the town
 * proper, is min(1232/3040, 560/1536) = 0.365 against a 0.286 floor), so the
 * clamp never fires today — it is there for when a parcel grows. The trade it
 * encodes: framing a district means its residents are 3.6 screen px. That is
 * deliberate, because the minimap above is what answers "who is where", and a
 * district jump should land on a shape rather than a handful of dots.
 */
export function fitParcelZoom(p: DistrictParcel, viewW: number, viewH: number): number {
  const w = Math.max(1, p.w * V);
  const h = Math.max(1, p.h * V);
  const fit = Math.min((viewW || 1) / w, (viewH || 1) / h);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.max(LABEL_MIN_ZOOM, fit)));
}

/** World-px centre of a parcel, in tiles. */
export function parcelCentre(p: DistrictParcel): [number, number] {
  return [p.x + p.w / 2, p.y + p.h / 2];
}

/**
 * Draw one frame. Call inside the existing rAF loop, after the main map, with
 * a context already scaled for devicePixelRatio.
 */
export function drawMinimap(ctx: CanvasRenderingContext2D, st: MinimapState): void {
  const theme = typeof document === "undefined" ? "light" : document.documentElement.getAttribute("data-theme");
  const i = readInk(theme);
  const s = mmScale();

  ctx.clearRect(0, 0, MM_W, MM_H);
  ctx.fillStyle = i.plate;
  ctx.fillRect(0, 0, MM_W, MM_H);

  const field = bake(theme ?? "light");
  if (field) ctx.drawImage(field, 0, 0, BW, BH, 0, 0, MM_W, MM_H);

  // district parcels — a hairline box each, filled while the rail hovers it
  ctx.lineWidth = 1;
  ctx.strokeStyle = i.rule;
  ctx.globalAlpha = 0.28;
  for (const p of DISTRICT_PARCELS) {
    ctx.strokeRect(p.x * s + 0.5, p.y * s + 0.5, p.w * s - 1, p.h * s - 1);
  }
  ctx.globalAlpha = 1;
  for (const p of DISTRICT_PARCELS) {
    if (p.name !== st.hover) continue;
    ctx.fillStyle = i.accent;
    ctx.globalAlpha = 0.2;
    ctx.fillRect(p.x * s, p.y * s, p.w * s, p.h * s);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = i.accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x * s + 0.75, p.y * s + 0.75, p.w * s - 1.5, p.h * s - 1.5);
    ctx.lineWidth = 1;
  }

  // residents first, camera last: the camera box is the one thing that must
  // stay legible when a hundred llamas are standing in the square
  ctx.fillStyle = i.muted;
  for (const a of st.agents) {
    ctx.fillRect(a.x * s - DOT / 2, a.y * s - DOT / 2, DOT, DOT);
  }
  ctx.fillStyle = RANK_COLORS[0];
  for (const a of st.agents) {
    if (a.id !== st.followId) continue;
    ctx.fillRect(a.x * s - DOT, a.y * s - DOT, DOT * 2, DOT * 2);
  }

  const c = cameraRect(st.cam, st.viewW, st.viewH);
  ctx.strokeStyle = i.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(c.x + 0.75, c.y + 0.75, Math.max(2, c.w - 1.5), Math.max(2, c.h - 1.5));
}