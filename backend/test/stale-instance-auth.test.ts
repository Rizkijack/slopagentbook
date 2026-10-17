/**
 * The stale warm instance.
 *
 * `verifyToken` resolves a token against the in-memory `world` (agents.ts), and
 * `mergeSnapshots` only runs inside `pgSave` — that is, only when something is
 * WRITTEN. Nothing on a read path merges. So a Vercel instance that booted
 * before another instance registered a resident has no registry row for that
 * resident's token, and answers 401 for a token that is perfectly valid in
 * postgres: the live MCP smoke saw exactly that, on the same token and the same
 * header, as `OK -> 401 -> OK`.
 *
 * What is pinned here:
 *  - a token valid in the authoritative store is accepted after ONE reload
 *  - a token the store never recorded still 401s
 *  - an ORPHANED record (agent row present, resident gone) still 401s
 *  - a warm instance that already knows the token never queries the store at all
 *
 * `saveAtomically` is mocked (the auth path writes nothing) and the neon driver
 * is faked, so the test asserts against a controlled row instead of a database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import type { TownSnapshot } from "@slopagentbook/shared";

/** The authoritative `town_state` row every fake read answers from. */
let row: { snapshot: unknown; rev: number } | null = null;
/** Every statement the fake client saw — a read-only auth path must only SELECT. */
const stmts: string[] = [];

vi.mock("../src/persist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/persist.js")>();
  // `saveDebounced` is mocked too, not because `/api/agent/me` schedules a save
  // today (it does not) but so a stray timer cannot outlive the suite if that
  // route ever grows one.
  return { ...actual, saveAtomically: vi.fn(async () => undefined), saveDebounced: vi.fn() };
});

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => {
    const exec = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join("?");
      stmts.push(text);
      if (/SELECT snapshot(?:, rev)? FROM town_state/i.test(text)) {
        return row ? [{ snapshot: row.snapshot, rev: row.rev }] : [];
      }
      // A write here would mean the auth path grew a second persistence
      // mechanism; failing loudly beats letting it pass unnoticed.
      throw new Error(`unexpected write on the auth path: ${text}`);
    };
    return Object.assign(exec, {
      transaction: async (qs: Promise<unknown>[]) => Promise.all(qs),
    });
  }),
}));

const { createGatewayRouter } = await import("../src/gateway.js");
const { createInitialWorld } = await import("../src/world.js");
const { joinWorld } = await import("../src/agents.js");

const NEVER = "should-never-be-touched.json";
let prevDbUrl: string | undefined;
let seq = 0;

let app: express.Express;
let stale: TownSnapshot;

/**
 * Model production exactly: one town, one instance lagging behind the row.
 * Both copies descend from the same pre-join world, so the only difference is
 * the registration the other instance already wrote.
 */
function mountLag(snapshot: unknown): void {
  stale = structuredClone(base) as TownSnapshot;
  row = { snapshot, rev: 7 };
  app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(createGatewayRouter({ world: stale, broadcast: () => {}, DATA_PATH: NEVER }));
}

let base: TownSnapshot;
/** The store's copy after another instance registered the agent. */
let authoritative: TownSnapshot;
let joined: { token: string; agentId: string; residentId: string };

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("stale instance auth", () => {
  beforeEach(() => {
    prevDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test";
    stmts.length = 0;
    row = null;
    seq++;

    base = createInitialWorld();
    authoritative = structuredClone(base) as TownSnapshot;
    const result = joinWorld(authoritative, { name: `StaleProbe${seq}`, origin: "vitest" });
    joined = { token: result.token, agentId: result.agentId, residentId: result.resident.id };
  });

  afterEach(() => {
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
  });

  it("accepts a token the store already recorded but this instance never merged", async () => {
    mountLag(authoritative);

    // the warm instance is genuinely missing it — that is the whole bug
    expect(stale.agents?.some((a) => a.id === joined.agentId)).toBeFalsy();
    expect(stale.herd.some((h) => h.id === joined.residentId)).toBe(false);

    const res = await request(app).get("/api/agent/me").set(auth(joined.token));

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(joined.agentId);
    expect(res.body.resident.id).toBe(joined.residentId);
    // the reload merged the row into memory, it did not bypass the lookup
    expect(stale.agents?.some((a) => a.id === joined.agentId)).toBe(true);
    expect(stale.herd.some((h) => h.id === joined.residentId)).toBe(true);
    expect(stmts.some((s) => /SELECT snapshot/i.test(s))).toBe(true);
  });

  it("still 401s a token the store never recorded", async () => {
    mountLag(authoritative);
    const bogus = "sabk_" + "0".repeat(48);

    const res = await request(app).get("/api/agent/me").set(auth(bogus));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("still 401s an orphaned record: agent row present, resident gone", async () => {
    const orphaned = structuredClone(authoritative) as TownSnapshot;
    orphaned.herd = orphaned.herd.filter((h) => h.id !== joined.residentId);
    mountLag(orphaned);

    const res = await request(app).get("/api/agent/me").set(auth(joined.token));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("never touches the store when the instance already knows the token", async () => {
    mountLag(structuredClone(authoritative));
    await request(app).get("/api/agent/me").set(auth(joined.token));
    stmts.length = 0;

    const res = await request(app).get("/api/agent/me").set(auth(joined.token));

    expect(res.status).toBe(200);
    expect(stmts).toEqual([]); // hot path unchanged: no read, no write
  });

  it("401s rather than throwing when the store cannot be read", async () => {
    mountLag(authoritative);
    row = null; // store empty / unreachable

    const res = await request(app).get("/api/agent/me").set(auth(joined.token));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("routes a retry that throws to 401 instead of dying", async () => {
    // A clean registry first, so the lookup misses without throwing, then a row
    // whose agents[] entry has no tokenHash — verifyToken throws on it once
    // merged, which puts the throw inside the retry's fulfilment callback.
    const clean = structuredClone(authoritative) as TownSnapshot;
    clean.agents = (clean.agents ?? []).filter((a) => a.id !== joined.agentId);
    clean.herd = clean.herd.filter((h) => h.id !== joined.residentId);
    mountLag(clean);
    row = {
      snapshot: { ...structuredClone(base), agents: [{ id: "ag_malformed", residentId: "r_missing" }] },
      rev: 7,
    };

    const res = await request(app).get("/api/agent/me").set(auth(joined.token));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });
});