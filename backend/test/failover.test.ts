import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Two-store failover: the primary is authoritative until a save or load fails,
 * then the standby takes over. The store is mocked at the provider boundary so
 * this exercises persist.ts, not node-postgres.
 */
let primaryDb: FakeDb;
let fallbackDb: FakeDb;

interface FakeDb {
  sql: any;
  calls: string[];
  writes: unknown[];
}

function fakeDb(options: { fail?: boolean; row?: unknown } = {}): FakeDb {
  const calls: string[] = [];
  const writes: unknown[] = [];
  const exec = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push(text);
    if (options.fail) throw new Error("store down");
    if (/SELECT snapshot, rev FROM town_state/i.test(text)) {
      return options.row ? [{ snapshot: options.row, rev: 1 }] : [];
    }
    if (/SELECT rev, updated_at FROM town_state/i.test(text)) {
      return options.row ? [{ rev: 1, updated_at: new Date(1_000) }] : [];
    }
    if (/SELECT rev FROM town_state/i.test(text)) return [];
    if (/INSERT INTO town_state/i.test(text)) {
      writes.push(JSON.parse(String(values[1])));
      return [];
    }
    if (/UPDATE town_state/i.test(text)) return [{ rev: 2 }];
    return [];
  };
  const sql = Object.assign(exec, {
    transaction: async (queries: unknown[]) => {
      if (options.fail) throw new Error("store down");
      if (!Array.isArray(queries)) throw new Error("transaction() expects an array of queries");
      return [[], [{ rev: 2 }]];
    },
  });
  return { sql, calls, writes };
}

vi.mock("../src/pgsql.js", () => {
  const configured = () => Boolean(process.env.DATABASE_URL || process.env.FALLBACK_DATABASE_URL);
  return {
    hasDatabase: configured,
    pgSql: () => primaryDb.sql,
    fallbackPgSql: () => fallbackDb.sql,
    databaseTargets: () => {
      const targets: Array<{ role: "primary" | "fallback"; sql: any }> = [];
      if (process.env.DATABASE_URL) targets.push({ role: "primary", sql: primaryDb.sql });
      if (process.env.FALLBACK_DATABASE_URL) targets.push({ role: "fallback", sql: fallbackDb.sql });
      return targets;
    },
    resetPgPools: async () => {},
  };
});

let persist: typeof import("../src/persist.js");

beforeEach(async () => {
  vi.resetModules();
  process.env.DATABASE_URL = "postgres://primary";
  process.env.FALLBACK_DATABASE_URL = "postgres://fallback";
  primaryDb = fakeDb();
  fallbackDb = fakeDb();
  persist = await import("../src/persist.js");
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.FALLBACK_DATABASE_URL;
  delete process.env.DB_MIRROR_MS;
});

describe("two-store failover", () => {
  it("writes the standby when the primary save fails, then stays on the standby", async () => {
    primaryDb = fakeDb({ fail: true });

    await persist.saveAtomically("/tmp/never.json", { herd: [{ id: "a" }] });
    expect(fallbackDb.writes).toHaveLength(1);
    expect((fallbackDb.writes[0] as { herd: Array<{ id: string }> }).herd[0]!.id).toBe("a");

    // The failed primary gets a cooldown, so the next save must not retry it
    // before mirroring the standby.
    const primaryCalls = primaryDb.calls.length;
    await persist.saveAtomically("/tmp/never.json", { herd: [{ id: "b" }] });
    expect(primaryDb.calls.length).toBe(primaryCalls);
    expect(fallbackDb.writes).toHaveLength(2);
  });

  it("loads the standby when the primary is unreadable", async () => {
    primaryDb = fakeDb({ fail: true });
    fallbackDb = fakeDb({ row: { herd: [{ id: "stored" }], config: {} } });

    const loaded = (await persist.loadWithRecovery("/tmp/never.json")) as {
      herd: Array<{ id: string }>;
    };
    expect(loaded.herd[0]!.id).toBe("stored");
  });

  it("splits saves 50/50 between the two stores — one write per save, alternating", async () => {
    // One configured pair, N saves: the stores take turns (primary, fallback,
    // primary, …). Neither store receives a duplicate write for the same save,
    // which is the 100/100 duplication the split exists to avoid.
    delete process.env.DB_MIRROR_MS;
    for (let i = 0; i < 4; i++) {
      persist.saveDebounced("/tmp/never.json", { herd: [{ id: `a${i}` }] }, 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(primaryDb.writes).toHaveLength(2);
    expect(fallbackDb.writes).toHaveLength(2);
  });

  it("hands a failed turn to the peer instead of dropping the save", async () => {
    delete process.env.DB_MIRROR_MS;
    primaryDb = fakeDb({ fail: true }); // this turn's store is down
    await persist.saveAtomically("/tmp/never.json", { herd: [{ id: "failover" }] });
    expect(fallbackDb.writes).toHaveLength(1);
  });

  it("copies to the peer only when DB_MIRROR_MS asks for it", async () => {
    // opt-in belt: a critical save mirrors immediately inside a window
    process.env.DB_MIRROR_MS = "600000";
    await persist.saveAtomically("/tmp/never.json", { herd: [{ id: "belt" }] });
    expect(primaryDb.writes).toHaveLength(1);
    expect(fallbackDb.writes).toHaveLength(1);
  });
});
