import { describe, it, expect, vi, afterAll } from "vitest";
import os from "os";
import path from "path";
import { createInitialWorld } from "../src/world.js";

// Vercel cold starts have no `/tmp/town.json`. The boot used to gate the store
// read on `existsSync(DATA_PATH)`, so on a cold instance it never consulted
// Postgres: it seeded a fresh town and the next autosave wrote that over the
// real row. The regression: a stored snapshot must win even when the scratch
// file does not exist.
const stored = createInitialWorld(40);
stored.herd[0]!.id = "stored-one";
stored.herd[0]!.name = "Stored One";
// Make it unambiguously the oldest seed, so the built-in-herd sweep keeps it.
stored.herd[0]!.born = 0;
// A real saved town has already been through the one-shot herd reduction and
// carries its stamp. Without it this fixture would be trimmed back to 20 and
// would hide the padding bug instead of exposing it.
(stored.config as unknown as Record<string, unknown>).herdReduced20261030 = "v2";
// Money/contest guards are covered elsewhere; keep this fixture about herd and
// faction reconciliation.
for (const key of ["vaults", "trades", "ledger", "callers", "contests"]) {
  (stored as unknown as Record<string, unknown>)[key] = [];
}
// Two more copies of the seeded faction, as the pre-fix cold-start bug left
// them in production: same name, different ids.
const seededFaction = stored.factions[0]!;
stored.factions.push(
  { ...seededFaction, id: "faction-dup-1" },
  { ...seededFaction, id: "faction-dup-2" },
);

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => {
    // pgLoad runs `SELECT snapshot, rev FROM town_state WHERE id = ...`; every
    // other statement (ensureSchema, a stray save) tolerates the same row.
    const exec = async () => [{ snapshot: stored, rev: 7 }];
    return Object.assign(exec, {
      // neon's transaction takes either a callback or an ARRAY of queries.
      // pgSave uses the array form and reads result[1] as the updated rows.
      transaction: async (arg: unknown) =>
        Array.isArray(arg) ? [[], [{ rev: 8 }]] : (arg as (tx: typeof exec) => Promise<unknown>)(exec),
    });
  }),
}));

process.env.DATABASE_URL = "postgres://test";
process.env.DATA_PATH = path.join(os.tmpdir(), `slab-pg-boot-${Date.now()}`, "town.json");
// Production-like, so the fresh-boot padding path is live and can prove it does
// NOT touch a loaded town. Saved and restored: workers reuse their process
// environment, and leaking `production` would change herd padding in another
// test file's boot.
const previousNodeEnv = process.env.NODE_ENV;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "production";

const { world } = await import("../src/server.js");

describe("boot reads the database when the scratch file is absent", () => {
  it("serves the stored snapshot instead of seeding a fresh town", () => {
    expect(world.herd.some((h) => h.id === "stored-one")).toBe(true);
  });

  it("does not pad a loaded town up to the fresh-boot herd size", () => {
    // The 58-resident padding belongs to a FRESH boot only — otherwise every
    // cold start would add strangers to a saved town. This fixture's saved herd
    // is also swept down to the built-in 20 below.
    expect(world.herd.length).toBeLessThan(58);
  });

  it("keeps the built-in bot herd at 20 and tombstones the extra seeds", () => {
    expect(world.herd.length).toBe(20);
    expect(world.herd.filter((h) => h.id.startsWith("house-"))).toHaveLength(3);
    expect(world.herd.filter((h) => h.id !== "stored-one" && !h.id.startsWith("house-"))).toHaveLength(16);
    expect(world.tombstones).toHaveLength(23);
  });

  it("collapses duplicate factions at boot", () => {
    expect(world.factions).toHaveLength(1);
    expect(world.factions[0]!.name).toBe(seededFaction.name);
  });
});

afterAll(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousDataPath === undefined) delete process.env.DATA_PATH;
  else process.env.DATA_PATH = previousDataPath;
});
