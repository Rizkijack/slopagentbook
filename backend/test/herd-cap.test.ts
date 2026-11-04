import { describe, it, expect } from "vitest";
import { defaultConfig, type TownSnapshot } from "@slopagentbook/shared";
import {
  reduceActiveHerd,
  trimToTargetKeepingBots,
  HERD_REDUCTION_STAMP,
  applyHerdCapDefault,
  reconcileBuiltinHerd,
  isBuiltinSeedBot,
  BUILTIN_HERD_TARGET,
} from "../src/server.js";
import { createInitialWorld, createAgentResident } from "../src/world.js";
import { ensureHouseResidents } from "../src/houseagents.js";
import { normalizeHerd } from "../src/pgstore.js";

/**
 * The operator reduction of 2026-10-30: the ACTIVE herd (61 probe-era
 * residents live at the time) is one-shot-reduced to 20, while the herd CAP
 * stays at the default 200 so joins keep pasture. Two properties have to stay
 * true after this commit:
 *
 *  - One-shot by marker (`herdReduced20261030` in config), never by state: the
 *    herd is dynamic, so a "trim when over 20" rule would silently shave any
 *    later town that legitimately grows past 20. First run stamps + trims;
 *    every boot after that is a no-op.
 *  - The pinned bots: capHerd's oldest-first survivor rule would sweep the
 *    three house bots out first (they were born days before the probe
 *    residents), and a trimmed-without-bots town cannot take them back
 *    (ensureHouseResidents honours the cap). The reduction must keep them.
 */

function resident(id: string, born: number) {
  return {
    id,
    name: id,
    born,
    mind: { doing: { place: "square", act: "wander" }, spirits: 0 },
  } as never;
}

function makeWorld(herd: unknown[], marker: string | boolean = false): TownSnapshot {
  return {
    config: { ...defaultConfig, maxHerd: 200, ...(marker ? { herdReduced20261030: marker } : {}) },
    herd,
  } as unknown as TownSnapshot;
}

const SIXTY_ONE = [
  resident("house-ledger", 1000),
  resident("house-hearth", 1001),
  resident("house-wren", 1002),
  ...Array.from({ length: 58 }, (_, i) => resident(`probe_${String(i).padStart(2, "0")}`, 2000 + i)),
];

describe("reduceActiveHerd (one-shot, 2026-10-30)", () => {
  it("reduces a 61-row to exactly 20 with the three house bots pinned, and stamps", () => {
    const world = makeWorld(SIXTY_ONE);
    expect(reduceActiveHerd(world)).toBe(true);
    expect(world.herd.length).toBe(20);
    expect(world.herd.length).toBeLessThanOrEqual(world.config.maxHerd); // cap untouched, stays 200
    const ids = new Set(world.herd.map((h) => (h as { id: string }).id));
    for (const bot of ["house-ledger", "house-hearth", "house-wren"]) {
      expect(ids.has(bot), `house bot ${bot} must survive the reduction`).toBe(true);
    }
    // the rest is the NEWEST seventeen: probe_41..probe_57
    const nonBotIds = [...ids].filter((id) => !id.startsWith("house-"));
    expect(nonBotIds).toHaveLength(17);
    for (const id of nonBotIds) expect(id, "oldest probes should drop first").toMatch(/probe_(4[1-9]|5[0-7])$/);
    // the stamp is what makes it one-shot
    expect((world.config as unknown as Record<string, unknown>).herdReduced20261030).toBe(HERD_REDUCTION_STAMP);
  });

  it("never runs twice against the same stamp: a v2 town is left alone", () => {
    const world = makeWorld(SIXTY_ONE, HERD_REDUCTION_STAMP);
    const before = world.herd.length;
    expect(reduceActiveHerd(world)).toBe(false);
    expect(world.herd.length).toBe(before);
  });

  it("a v1 stamp (true) is stale: it re-runs exactly once", () => {
    const world = makeWorld(SIXTY_ONE, true);
    expect(reduceActiveHerd(world)).toBe(true);
    expect(world.herd.length).toBe(20);
    expect((world.config as unknown as Record<string, unknown>).herdReduced20261030).toBe(HERD_REDUCTION_STAMP);
  });

  it("a fresh town at 8 accepts the stamp without trimming anything", () => {
    const world = makeWorld(Array.from({ length: 8 }, (_, i) => resident(`seed_${i}`, 1000 + i)));
    expect(reduceActiveHerd(world)).toBe(true);
    expect(world.herd.length).toBe(8);
  });

  it("never leaves the surviving pool over the target after normalize", () => {
    const world = makeWorld([
      resident("house-ledger", 900),
      resident("house-ledger", 901), // duplicate id+name, merge-style mess
      ...Array.from({ length: 30 }, (_, i) => resident(`x_${String(i).padStart(2, "0")}`, 2000 + i)),
    ]);
    reduceActiveHerd(world);
    world.herd = normalizeHerd(world) as unknown as TownSnapshot["herd"];
    expect(world.herd.length).toBeLessThanOrEqual(20);
  });
});

describe("trimToTargetKeepingBots", () => {
  it("mirror image of capHerd: oldest non-bots leave, newest stay, bots never leave", () => {
    const world = makeWorld(SIXTY_ONE);
    const result = world.herd.filter((h) => typeof h === "object");
    expect(result.length).toBe(61);
    expect(trimToTargetKeepingBots(world, 20)).toBe(true);
    const ids = new Set(world.herd.map((h) => (h as { id: string }).id));
    expect(ids.has("house-ledger")).toBe(true);
    expect(ids.size).toBe(20);
  });

  it("returns false when there is nothing to trim", () => {
    const world = makeWorld(SIXTY_ONE.slice(0, 8));
    expect(trimToTargetKeepingBots(world, 20)).toBe(false);
    expect(world.herd.length).toBe(8);
  });
});

describe("applyHerdCapDefault (200 -> 2000)", () => {
  it("raises the exact old default", () => {
    const config: Record<string, unknown> = { maxHerd: 200 };
    expect(applyHerdCapDefault(config)).toBe(true);
    expect(config.maxHerd).toBe(2000);
  });

  it("leaves a deliberately set cap alone", () => {
    for (const cap of [64, 500, 2000, 5000]) {
      const config: Record<string, unknown> = { maxHerd: cap };
      expect(applyHerdCapDefault(config)).toBe(false);
      expect(config.maxHerd).toBe(cap);
    }
    expect(applyHerdCapDefault({})).toBe(false);
  });
});

describe("reconcileBuiltinHerd — bot herd 20, residents untouched", () => {
  function sweepWorld() {
    const world = createInitialWorld(40);
    world.config = { ...defaultConfig, maxHerd: 2000 };
    world.herd.forEach((r, i) => {
      r.born = 1000 + i;
      r.gen = 0;
      r.parent = undefined;
    });
    ensureHouseResidents(world);
    // The money/contest guards are covered by removal.test.ts; keep this
    // fixture focused on the bot/resident split.
    (world as unknown as Record<string, unknown>).vaults = [];
    (world as unknown as Record<string, unknown>).trades = [];
    (world as unknown as Record<string, unknown>).ledger = [];
    (world as unknown as Record<string, unknown>).callers = [];
    (world as unknown as Record<string, unknown>).contests = [];

    const externals = Array.from({ length: 5 }, (_, i) => {
      const r = createAgentResident({ name: `Agent${i}`, handle: `agent${i}` });
      r.mind.control = "external";
      r.born = 5000 + i;
      return r;
    });
    const forks = [0, 1, 2].map((n) => {
      const parent = world.herd[n]!;
      return {
        ...parent,
        id: `fork${n}`,
        name: `Fork${n}`,
        gen: 1,
        parent: parent.id,
        born: 9000 + n,
        mind: { ...parent.mind, control: undefined },
      } as (typeof world.herd)[number];
    });
    world.herd.push(...externals, ...forks);
    (world as unknown as Record<string, unknown>).agents = externals.map((r, i) => ({
      id: `ag${i}`,
      residentId: r.id,
      tokenHash: `h${i}`,
      origin: "test",
      joinedAt: 1,
      lastActAt: 1,
    }));
    return { world, externals, forks };
  }

  it("keeps 17 oldest seed bots + 3 house bots, and every external agent and fork", () => {
    const { world, externals, forks } = sweepWorld();
    expect(world.herd.length).toBe(51);
    expect(reconcileBuiltinHerd(world)).toBe(true);

    const ids = new Set(world.herd.map((h) => h.id));
    expect(world.herd.length).toBe(BUILTIN_HERD_TARGET + externals.length + forks.length);
    expect(world.herd.filter((h) => isBuiltinSeedBot(world, h))).toHaveLength(17);
    for (const bot of ["house-ledger", "house-hearth", "house-wren"]) expect(ids.has(bot)).toBe(true);
    for (const a of externals) {
      expect(ids.has(a.id), `external ${a.name} must survive`).toBe(true);
      expect(world.herd.find((h) => h.id === a.id)!.mind.control).toBe("external");
    }
    for (const f of forks) {
      expect(ids.has(f.id), `fork ${f.name} must survive`).toBe(true);
      expect(ids.has(f.parent!), `fork parent ${f.parent} must survive`).toBe(true);
    }
    expect((world.tombstones ?? []).length).toBe(23);

    const after = world.herd.length;
    expect(reconcileBuiltinHerd(world)).toBe(false);
    expect(world.herd.length).toBe(after);
  });

  it("is a no-op under the target", () => {
    const world = createInitialWorld(10);
    world.config = { ...defaultConfig, maxHerd: 2000 };
    ensureHouseResidents(world);
    expect(world.herd.filter((h) => isBuiltinSeedBot(world, h))).toHaveLength(10);
    expect(reconcileBuiltinHerd(world)).toBe(false);
    expect(world.herd.length).toBe(13);
  });

  it("classifies house bots, external agents and forks as non-bots", () => {
    const { world, externals, forks } = sweepWorld();
    expect(isBuiltinSeedBot(world, world.herd.find((h) => h.id === "house-ledger")!)).toBe(false);
    expect(isBuiltinSeedBot(world, externals[0]!)).toBe(false);
    expect(isBuiltinSeedBot(world, forks[0]!)).toBe(false);
    const seed = world.herd.find((h) => (h.gen ?? 0) === 0 && !h.id.startsWith("house-"))!;
    expect(isBuiltinSeedBot(world, seed)).toBe(true);
  });
});
