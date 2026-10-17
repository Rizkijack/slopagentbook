import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LOCATIONS, PLACE_PARCEL, parcelOf } from "../src/canvas/locationsData.js";
import { MM_H, MM_W, cameraRect, drawMinimap, fitParcelZoom, mmScale, parcelCentre } from "../src/canvas/minimap.js";
import { LABEL_MIN_ZOOM, MIN_ZOOM, MAX_ZOOM } from "../src/canvas/engine.js";
import { Pe, vt, V } from "../src/canvas/constants.js";
import { DISTRICT_PARCELS } from "@slopagentbook/shared";

// The overview map exists because the world does not fit: 1050x640 tiles into a
// viewport of at most 1232x560 CSS px, so MIN_ZOOM puts a resident at half a
// screen pixel. These pin the arithmetic that decides what the minimap claims
// about the world — a minimap that is slightly wrong is worse than none.

/** The widest box WorldCanvas ever hands the canvas (.page max-width 1280). */
const VIEW_W = 1232;
const VIEW_H = 560;

describe("minimap geometry", () => {
  it("keeps the world's own aspect, so it never lies about shape", () => {
    expect(MM_H).toBe(Math.round((MM_W * vt) / Pe));
    // a 1050x640 world in a 208-wide box is 127 tall; allow the rounding to
    // move it by less than one pixel per axis
    expect(Math.abs(MM_W / MM_H - Pe / vt) * MM_H).toBeLessThan(1);
  });

  it("reports CSS px per tile", () => {
    expect(mmScale()).toBeCloseTo(MM_W / Pe, 10);
  });
});

describe("the camera box on the minimap", () => {
  const cam = { x: 8400, y: 5120, zoom: 1 };

  it("is the real view extent, not a fixed box", () => {
    const r = cameraRect(cam, VIEW_W, VIEW_H);
    // 1232 CSS px of viewport, at 208 px per 1050 tiles
    expect(r.w).toBeCloseTo(VIEW_W * mmScale(), 6);
    expect(r.h).toBeCloseTo(VIEW_H * mmScale(), 6);
  });

  it("is centred on the camera", () => {
    const r = cameraRect(cam, VIEW_W, VIEW_H);
    expect(r.x + r.w / 2).toBeCloseTo(cam.x * mmScale(), 6);
    expect(r.y + r.h / 2).toBeCloseTo(cam.y * mmScale(), 6);
  });

  it("grows as the camera pulls back", () => {
    const near = cameraRect({ ...cam, zoom: 1 }, VIEW_W, VIEW_H);
    const far = cameraRect({ ...cam, zoom: 0.5 }, VIEW_W, VIEW_H);
    const wide = cameraRect({ ...cam, zoom: MIN_ZOOM }, VIEW_W, VIEW_H);
    expect(far.w).toBeCloseTo(near.w * 2, 6);
    expect(wide.w).toBeGreaterThan(far.w);
    // MIN_ZOOM is the contain zoom for the whole world, so the box covers it
    expect(wide.w).toBeGreaterThanOrEqual(MM_W);
  });
});

describe("district framing", () => {
  it("frames every parcel whole", () => {
    for (const p of DISTRICT_PARCELS) {
      const z = fitParcelZoom(p, VIEW_W, VIEW_H);
      // the parcel must fit the viewport at that zoom, on both axes
      expect(VIEW_W / z, `${p.name} is wider than the viewport`).toBeGreaterThanOrEqual(p.w * V - 1);
      expect(VIEW_H / z, `${p.name} is taller than the viewport`).toBeGreaterThanOrEqual(p.h * V - 1);
    }
  });

  it("never floors, because framing a district is worth more than a readable llama", () => {
    // The clamp in fitParcelZoom exists for when a parcel grows. Today the
    // largest one (the town proper, 0.365) is still above the label floor
    // (0.286), so the floor never fires — if it starts firing, some district
    // has outgrown the viewport and that is worth knowing before the numbers
    // move.
    for (const p of DISTRICT_PARCELS) {
      expect(fitParcelZoom(p, VIEW_W, VIEW_H), `${p.name} hit the floor`).toBeGreaterThan(LABEL_MIN_ZOOM);
    }
  });

  it("stays inside the engine's zoom limits, whatever it is handed", () => {
    const p = DISTRICT_PARCELS[0]!;
    for (const [w, h] of [[0, 0], [10, 10], [1e9, 1e9], [Number.NaN, 560]]) {
      const z = fitParcelZoom(p, w, h);
      expect(Number.isFinite(z), `zoom went non-finite for ${w}x${h}`).toBe(true);
      expect(z).toBeGreaterThanOrEqual(MIN_ZOOM);
      expect(z).toBeLessThanOrEqual(MAX_ZOOM);
    }
  });

  it("targets the parcel's middle", () => {
    const p = DISTRICT_PARCELS[0]!;
    const [cx, cy] = parcelCentre(p);
    expect(cx).toBeCloseTo(p.x + p.w / 2, 6);
    expect(cy).toBeCloseTo(p.y + p.h / 2, 6);
  });
});

describe("the location→parcel partition", () => {
  const built = LOCATIONS.filter((l) => l.category !== "Food" && l.category !== "Water");
  const terrain = LOCATIONS.filter((l) => l.category === "Food" || l.category === "Water");

  it("puts every building in exactly one parcel", () => {
    // The rail counts residents by this map and the minimap draws by it, so a
    // building that fell out of every parcel would silently vanish from both.
    const orphans = built.filter((l) => parcelOf(l) === null).map((l) => l.id);
    expect(orphans).toEqual([]);
  });

  it("leaves no parcel empty", () => {
    for (const p of DISTRICT_PARCELS) {
      const n = built.filter((l) => parcelOf(l) === p.name).length;
      expect(n, `${p.name} has no buildings`).toBeGreaterThan(0);
    }
  });

  it("accounts for every location, terrain included", () => {
    expect(PLACE_PARCEL.size).toBe(LOCATIONS.length);
    // Terrain is not special-cased: the pond, the west meadow, the orchard and
    // the oat trough genuinely sit inside the town parcel, so a llama drinking
    // at the trough belongs to the town count. Only the remote ground — both
    // rivers, the fen, the outer meadows — maps to no district at all.
    for (const id of ["pond", "meadowW", "meadowE", "orchard", "trough"]) {
      expect(PLACE_PARCEL.get(id), `${id} lost its district`).toBe("SlopAgentbook");
    }
    for (const id of ["riverRun", "riverMouth", "eastFen", "millpond", "northMeadow"]) {
      expect(PLACE_PARCEL.get(id), `${id} was given a district it is not in`).toBeNull();
    }
    expect(terrain.length).toBe(13);
  });

  it("is a partition, not a first-match pile: no parcel can claim another's buildings", () => {
    const counts = new Map<string, number>();
    for (const l of built) {
      const p = parcelOf(l);
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(built.length);
  });
});

describe("drawMinimap", () => {
  /**
   * jsdom ships no 2D context and prints a "Not implemented" virtual-console
   * error when you ask for one. bake() catches that and returns null, which is
   * exactly the path under test — so stub it to return null outright and the
   * assertion says what it means instead of leaning on an error being logged.
   */
  let restore: (() => void) | null = null;
  beforeAll(() => {
    const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
    const was = proto.getContext;
    proto.getContext = () => null;
    restore = () => { proto.getContext = was; };
  });
  afterAll(() => restore?.());

  /** A ctx that records every call, since the real one does not exist here. */
  const stubCtx = () => {
    const calls: Record<string, number> = {};
    const rec =
      (name: string) =>
      (..._a: unknown[]) => {
        calls[name] = (calls[name] ?? 0) + 1;
      };
    const ctx = new Proxy(
      { measureText: (t: string) => ({ width: t.length * 6 }) } as Record<string, unknown>,
      {
        get(t, k: string) {
          if (k in t) return t[k];
          return rec(k);
        },
        set(t, k: string, v) {
          t[k] = v;
          return true;
        },
      },
    );
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  };

  it("draws without a baked field, and touches the canvas every frame", () => {
    const { ctx, calls } = stubCtx();
    drawMinimap(ctx, {
      cam: { x: 8400, y: 5120, zoom: 1 },
      viewW: VIEW_W,
      viewH: VIEW_H,
      agents: [{ id: "a", x: 8368, y: 5040 }],
      followId: null,
      hover: null,
    });
    expect(calls.clearRect).toBeGreaterThan(0);
    expect(calls.strokeRect).toBeGreaterThan(0);
    // one dot per resident, plus the camera box
    expect(calls.fillRect).toBeGreaterThan(0);
  });

  it("takes an empty town without complaining", () => {
    const { ctx } = stubCtx();
    expect(() =>
      drawMinimap(ctx, {
        cam: { x: 0, y: 0, zoom: MIN_ZOOM },
        viewW: VIEW_W,
        viewH: VIEW_H,
        agents: [],
        followId: null,
        hover: null,
      }),
    ).not.toThrow();
  });
});