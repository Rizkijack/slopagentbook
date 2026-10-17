/**
 * The same stale-instance bug on the three sibling doors.
 *
 * `stale-instance-auth.test.ts` pins the reload on the main agent middleware.
 * Three more places resolve a credential from the in-memory `world` only, and
 * `pgSave` merges the row with the writer's copy only when something is WRITTEN
 * — so a warm instance answers the negative on all three for a credential the
 * store already holds:
 *
 *   POST /api/agent/session  -> 400 "invalid agent token"
 *   GET  /api/agent/session  -> 200 {authenticated:false}   (looks signed out)
 *   BRAWL requireAgent       -> 401 "unauthorized"          (vault rail, real capital)
 *
 * Each site is held to the same four guarantees, plus the one that matters most
 * on the vault rail:
 *
 *   - a credential the store holds is accepted after ONE reload
 *   - an UNKNOWN credential still gets the ORIGINAL negative — same status, same
 *     body, same error text
 *   - an ORPHANED record (agent row present, resident gone) is still rejected
 *   - a hot instance that already knows the credential issues ZERO statements
 *   - an unreadable store degrades to the original negative, never a throw
 *   - a TOMBSTONED resident+agent stays rejected: the merge honours removals
 *     exactly as the write path does, so the reload cannot resurrect a
 *     credential an admin deleted
 *
 * `saveAtomically`/`saveDebounced` are mocked and the neon driver is faked, so
 * every assertion is against a controlled row, and a write on the auth path
 * throws rather than passing unnoticed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { TownSnapshot } from "@slopagentbook/shared";

/** The authoritative `town_state` row every fake read answers from. */
let row: { snapshot: unknown; rev: number } | null = null;
/** Every statement the fake client saw. */
const stmts: string[] = [];
/**
 * When set, the fake SELECT blocks on this until a test releases it. Without it
 * every read settles before the next request is even parsed, so a "concurrent"
 * burst never actually overlaps and a test cannot tell a real single-flight join
 * from eight sequential reads that happened to look similar.
 */
let readGate: Promise<void> | null = null;
let releaseRead: (() => void) | null = null;
/** When set, `res.json` throws — used to force a catch's fallback send to fail. */
let throwOnJson = false;
/**
 * After this many `verifyToken` calls, throw instead of comparing. -1 = never.
 * Drives the retry-throw cases independently of any registry row shape, so they
 * keep testing the catch after `hashEquals` stops throwing on a bad row.
 */
let verifyThrowsAfter = -1;
let verifyCalls = 0;

vi.mock("../src/persist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/persist.js")>();
  return {
    ...actual,
    saveAtomically: vi.fn(async () => undefined),
    saveDebounced: vi.fn(),
  };
});

vi.mock("../src/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents.js")>();
  return {
    ...actual,
    verifyToken: (world: TownSnapshot, token: string) => {
      const n = verifyCalls++;
      if (verifyThrowsAfter >= 0 && n >= verifyThrowsAfter) throw new Error("simulated registry fault");
      return actual.verifyToken(world, token);
    },
  };
});

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => {
    const exec = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join("?");
      stmts.push(text);
      if (/SELECT snapshot(?:, rev)? FROM town_state/i.test(text)) {
        // hold the read open so concurrent callers really do overlap
        if (readGate) await readGate;
        return row ? [{ snapshot: row.snapshot, rev: row.rev }] : [];
      }
      throw new Error(`unexpected write on the auth path: ${text}`);
    };
    return Object.assign(exec, {
      transaction: async (qs: Promise<unknown>[]) => Promise.all(qs),
    });
  }),
}));

const { createGatewayRouter } = await import("../src/gateway.js");
const { createBrawlRouter } = await import("../src/brawl.js");
const { createInitialWorld } = await import("../src/world.js");
const { joinWorld } = await import("../src/agents.js");
const { SESSION_COOKIE } = await import("../src/session.js");
// read, not re-declared: the cooldown window is the policy under test here
const { RELOAD_COOLDOWN_MS } = await import("../src/persist.js");

const NEVER = "should-never-be-touched.json";
const UNKNOWN = "sabk_" + "0".repeat(48);

let prevDbUrl: string | undefined;
let seq = 0;

let app: express.Express;
let stale: TownSnapshot;

/**
 * Model production exactly: one town, one instance lagging behind the row. Both
 * copies descend from the same pre-join world, so the only difference is the
 * registration the other instance already wrote.
 */
function mount(snapshot: unknown, rail: "gateway" | "brawl", dataPath: string = NEVER): void {
  stale = structuredClone(base) as TownSnapshot;
  row = { snapshot, rev: 7 };
  app = express();
  app.use(express.json({ limit: "64kb" }));
  // installed before the rail, so a response that throws on send is the one the
  // auth path actually uses — that is what makes the catch's fallback observable
  app.use((_req, res, next) => {
    if (throwOnJson) res.json = () => { throw new Error("socket aborted"); };
    next();
  });
  if (rail === "gateway") {
    app.use(createGatewayRouter({ world: stale, broadcast: () => {}, DATA_PATH: dataPath }));
  } else {
    app.use(createBrawlRouter({ world: stale, broadcast: () => {}, save: async () => {}, DATA_PATH: dataPath }));
  }
}

let base: TownSnapshot;
/** The store's copy after another instance registered the agent. */
let authoritative: TownSnapshot;
let joined: { token: string; agentId: string; residentId: string };

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const cookie = (t: string) => ({ Cookie: `${SESSION_COOKIE}=${t}` });

/**
 * The row a store would hold if an admin removed this resident but the row still
 * carried them: both records present, tombstone naming both. The merge must
 * honour the tombstone — this is the case where a reload could widen access.
 */
function rowWithTombstone(): TownSnapshot {
  const resurrected = structuredClone(authoritative) as TownSnapshot;
  resurrected.tombstones = [
    { id: joined.residentId, reason: "admin", at: Date.now(), agentIds: [joined.agentId] },
  ];
  return resurrected;
}

/**
 * A row whose `agents[]` holds a record with no `tokenHash`.
 *
 * `verifyToken` calls `hashEquals(record.tokenHash, hash)` for every row until
 * one matches, and `Buffer.from(undefined)` throws — so one malformed row makes
 * the lookup itself throw. Only reachable AFTER a reload (the pre-reload lookup
 * runs against a clean registry), which is what puts the throw inside the
 * retry's fulfilment callback rather than in the middleware's own frame.
 */
function rowWithMalformedAgent(): unknown {
  return { ...structuredClone(base), agents: [{ id: "ag_malformed", residentId: "r_missing" }] };
}

/** Give `mount()` a registry that misses `token`, so the first lookup misses. */
function withoutJoinedAgent(): TownSnapshot {
  const copy = structuredClone(authoritative) as TownSnapshot;
  copy.agents = (copy.agents ?? []).filter((a) => a.id !== joined.agentId);
  copy.herd = copy.herd.filter((h) => h.id !== joined.residentId);
  return copy;
}

/** Wait out the reload cooldown so the next lookup is allowed to read again. */
const pastCooldown = () => new Promise((r) => setTimeout(r, RELOAD_COOLDOWN_MS + 200));

/**
 * Capture console.error so a swallowed failure can be told from a logged one.
 * Only the call count is asserted — never the arguments, which is how this file
 * avoids pinning a message that might carry something it should not.
 */
function spyErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

/** A ledger-shaped payload, enough to tell "live" from "reverted" by value. */
function money(balance: number, tag: string) {
  return {
    vaults: [{ id: `v_${tag}`, keeperId: `r_${tag}`, balance }],
    trades: [{ id: `t_${tag}` }],
    ledger: [{ id: `l_${tag}` }],
    callers: [{ id: `c_${tag}` }],
  };
}

beforeEach(() => {
  prevDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://test";
  stmts.length = 0;
  row = null;
  readGate = null;
  releaseRead = null;
  throwOnJson = false;
  verifyThrowsAfter = -1;
  verifyCalls = 0;
  seq++;

  base = createInitialWorld();
  authoritative = structuredClone(base) as TownSnapshot;
  const result = joinWorld(authoritative, { name: `StaleRail${seq}`, origin: "vitest" });
  joined = { token: result.token, agentId: result.agentId, residentId: result.resident.id };
});

afterEach(() => {
  if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDbUrl;
});

describe("stale instance auth — POST /api/agent/session", () => {
  it("accepts a token the store holds but this instance never merged", async () => {
    mount(structuredClone(authoritative), "gateway");

    const res = await request(app).post("/api/agent/session").send({ token: joined.token });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.resident.id).toBe(joined.residentId);
    expect(res.headers["set-cookie"]?.[0]).toContain(SESSION_COOKIE);
    expect(stale.agents?.some((a) => a.id === joined.agentId)).toBe(true);
  });

  it("still answers 400 invalid agent token for an unknown token", async () => {
    mount(structuredClone(authoritative), "gateway");

    const res = await request(app).post("/api/agent/session").send({ token: UNKNOWN });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid agent token" });
  });

  it("still answers 400 for an orphaned record: agent row present, resident gone", async () => {
    const orphaned = structuredClone(authoritative) as TownSnapshot;
    orphaned.herd = orphaned.herd.filter((h) => h.id !== joined.residentId);
    mount(orphaned, "gateway");

    const res = await request(app).post("/api/agent/session").send({ token: joined.token });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid agent token" });
  });

  it("never touches the store when the instance already knows the token", async () => {
    mount(structuredClone(authoritative), "gateway");
    await request(app).post("/api/agent/session").send({ token: joined.token });
    stmts.length = 0;

    const res = await request(app).post("/api/agent/session").send({ token: joined.token });

    expect(res.status).toBe(200);
    expect(stmts).toEqual([]);
  });

  it("answers the same 400 rather than throwing when the store cannot be read", async () => {
    mount(structuredClone(authoritative), "gateway");
    row = null;

    const res = await request(app).post("/api/agent/session").send({ token: joined.token });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid agent token" });
  });

  it("routes a retry that throws to the same 400 instead of dying", async () => {
    // clean registry first (the lookup misses cleanly), then a throw injected into
    // the post-reload lookup — so the throw lands in the retry's callback
    mount(structuredClone(authoritative), "gateway");
    verifyThrowsAfter = 1;
    const errors = spyErrors();

    const res = await request(app).post("/api/agent/session").send({ token: joined.token });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid agent token" });
    expect(errors.mock.calls.length).toBe(1); // not swallowed
    errors.mockRestore();
  });

  it("degrades to the same 400 on a malformed registry row instead of throwing", async () => {
    mount(withoutJoinedAgent(), "gateway");
    row = { snapshot: rowWithMalformedAgent(), rev: 7 };

    const res = await request(app).post("/api/agent/session").send({ token: joined.token });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid agent token" });
  });
});

describe("stale instance auth — GET /api/agent/session", () => {
  it("reports authenticated for a cookie the store holds but this instance never merged", async () => {
    mount(structuredClone(authoritative), "gateway");

    const res = await request(app).get("/api/agent/session").set(cookie(joined.token));

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.resident.id).toBe(joined.residentId);
  });

  it("still answers authenticated:false for an unknown cookie", async () => {
    mount(structuredClone(authoritative), "gateway");

    const res = await request(app).get("/api/agent/session").set(cookie(UNKNOWN));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it("still answers authenticated:false for an orphaned record", async () => {
    const orphaned = structuredClone(authoritative) as TownSnapshot;
    orphaned.herd = orphaned.herd.filter((h) => h.id !== joined.residentId);
    mount(orphaned, "gateway");

    const res = await request(app).get("/api/agent/session").set(cookie(joined.token));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it("never touches the store when the instance already knows the cookie", async () => {
    mount(structuredClone(authoritative), "gateway");
    await request(app).get("/api/agent/session").set(cookie(joined.token));
    stmts.length = 0;

    const res = await request(app).get("/api/agent/session").set(cookie(joined.token));

    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(stmts).toEqual([]);
  });

  it("answers authenticated:false rather than throwing when the store cannot be read", async () => {
    mount(structuredClone(authoritative), "gateway");
    row = null;

    const res = await request(app).get("/api/agent/session").set(cookie(joined.token));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it("never touches the store for an anonymous visitor, who has no credential", async () => {
    mount(structuredClone(authoritative), "gateway");

    const res = await request(app).get("/api/agent/session");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
    // every page load polls this; a reload here would be a store read per visitor
    expect(stmts).toEqual([]);
  });

  it("routes a retry that throws to authenticated:false instead of dying", async () => {
    mount(structuredClone(authoritative), "gateway");
    verifyThrowsAfter = 1;
    const errors = spyErrors();

    const res = await request(app).get("/api/agent/session").set(cookie(joined.token));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
    expect(errors.mock.calls.length).toBe(1);
    errors.mockRestore();
  });

  it("degrades to authenticated:false on a malformed registry row", async () => {
    mount(withoutJoinedAgent(), "gateway");
    row = { snapshot: rowWithMalformedAgent(), rev: 7 };

    const res = await request(app).get("/api/agent/session").set(cookie(joined.token));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
  });
});

describe("stale instance auth — BRAWL rail", () => {
  const openVault = () =>
    request(app).post("/api/brawl/vaults").set(bearer(joined.token)).send({});

  it("accepts a token the store holds but this instance never merged", async () => {
    mount(structuredClone(authoritative), "brawl");

    const res = await openVault();

    expect(res.status).toBe(200);
    // the keeper identity came from the reloaded store, not from memory
    expect(res.body.keeperId).toBe(joined.residentId);
  });

  it("still answers 401 unauthorized for an unknown token", async () => {
    mount(structuredClone(authoritative), "brawl");

    const res = await request(app).post("/api/brawl/vaults").set(bearer(UNKNOWN)).send({});

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("still answers 401 for an orphaned record: agent row present, resident gone", async () => {
    const orphaned = structuredClone(authoritative) as TownSnapshot;
    orphaned.herd = orphaned.herd.filter((h) => h.id !== joined.residentId);
    mount(orphaned, "brawl");

    const res = await openVault();

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("does not resurrect a tombstoned resident and agent", async () => {
    mount(rowWithTombstone(), "brawl");

    const res = await openVault();

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    // the reload happened, and it still refused: the tombstone was honoured
    expect(stmts.some((s) => /SELECT snapshot/i.test(s))).toBe(true);
    expect(stale.agents?.some((a) => a.id === joined.agentId)).toBe(false);
    expect(stale.herd.some((h) => h.id === joined.residentId)).toBe(false);
  });

  it("never touches the store when the instance already knows the token", async () => {
    mount(structuredClone(authoritative), "brawl");
    await openVault();
    stmts.length = 0;

    const res = await openVault();

    expect(res.status).toBe(200);
    expect(stmts).toEqual([]);
  });

  it("answers 401 rather than throwing when the store cannot be read", async () => {
    mount(structuredClone(authoritative), "brawl");
    row = null;

    const res = await openVault();

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("routes a retry that throws to 401 instead of dying", async () => {
    mount(structuredClone(authoritative), "brawl");
    verifyThrowsAfter = 1;
    const errors = spyErrors();

    const res = await openVault();

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(errors.mock.calls.length).toBe(1);
    errors.mockRestore();
  });

  it("degrades to 401 on a malformed registry row", async () => {
    mount(withoutJoinedAgent(), "brawl");
    row = { snapshot: rowWithMalformedAgent(), rev: 7 };

    const res = await openVault();

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });
});

describe("stale instance auth — reload safety", () => {
  it("bounds store reads when a burst of distinct wrong tokens arrives", async () => {
    mount(structuredClone(authoritative), "gateway");

    // sequential on purpose: single-flight alone does NOT bound this, because it
    // clears on settle, so each request would otherwise buy its own full-row read
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .get("/api/agent/me")
        .set(bearer(`sabk_${String(i).repeat(48)}`));
      expect(res.status).toBe(401);
    }

    expect(stmts.filter((s) => /SELECT snapshot/i.test(s)).length).toBeLessThanOrEqual(1);
  });

  it("collapses genuinely concurrent misses into one read, and every joiner gets the merge", async () => {
    mount(structuredClone(authoritative), "gateway");
    // hold the read open: without this the requests are merely sequential and the
    // test would pass even with the in-flight join branch deleted
    readGate = new Promise<void>((r) => { releaseRead = r; });

    const inflight = Promise.all(
      Array.from({ length: 8 }, () => request(app).get("/api/agent/me").set(bearer(joined.token))),
    );
    await vi.waitFor(() => {
      expect(stmts.filter((s) => /SELECT snapshot/i.test(s)).length).toBe(1);
    });
    releaseRead!();

    const results = await inflight;
    // one read, and every joiner authenticated against the merged world rather
    // than being refused by the cooldown while the read was still running
    expect(stmts.filter((s) => /SELECT snapshot/i.test(s)).length).toBe(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.resident?.id === joined.residentId)).toBe(true);
  });

  it("ignores the file on disk without DATABASE_URL, where this process IS the store", async () => {
    // a real town on disk, holding the very credential being presented. If the
    // guard were removed the reload would read it and authenticate the request,
    // so this pins the guard rather than just observing that no SQL was issued.
    const dir = mkdtempSync(path.join(tmpdir(), "agentbook-rails-"));
    const dataPath = path.join(dir, "town.json");
    writeFileSync(dataPath, JSON.stringify(structuredClone(authoritative)), "utf8");
    try {
      mount(structuredClone(authoritative), "gateway", dataPath);
      delete process.env.DATABASE_URL;

      const res = await request(app).get("/api/agent/me").set(bearer(joined.token));

      expect(res.status).toBe(401);
      expect(stmts).toEqual([]);
      // the file was not read into memory
      expect(stale.agents?.some((a) => a.id === joined.agentId)).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the live world untouched when the stored row is not a town", async () => {
    // `mergeSnapshots` does not throw on any of these, so "did not throw" proves
    // nothing; the assertion is that the live world's own array is left in place
    for (const snapshot of [{}, 0, [], "not a town", null]) {
      mount(structuredClone(authoritative), "gateway");
      const herdBefore = stale.herd;
      const agentsBefore = stale.agents;
      row = { snapshot, rev: 7 };

      const res = await request(app).get("/api/agent/me").set(bearer(joined.token));

      expect(res.status).toBe(401);
      expect(stale.herd).toBe(herdBefore);
      expect(stale.agents).toBe(agentsBefore);
    }
  });

  it("keeps live money state when the stored row carries an older copy", async () => {
    // mergeSnapshots returns `...a` for anything it does not merge, and it does
    // not merge vaults/trades/ledger/callers — so applying the whole merged
    // object would revert this instance's live balances to the row's.
    const stored = structuredClone(authoritative) as TownSnapshot;
    Object.assign(stored, money(100, "stored"));
    mount(stored, "brawl");
    Object.assign(stale, money(250, "live"));

    const res = await request(app).post("/api/brawl/vaults").set(bearer(joined.token)).send({});

    expect(res.status).toBe(200); // the reload really did run
    expect(stmts.some((s) => /SELECT snapshot/i.test(s))).toBe(true);
    // by id, because the request itself appends the vault it just created
    const has = (list: unknown, id: string) =>
      (Array.isArray(list) ? list : []).some((x) => (x as { id?: unknown })?.id === id);
    expect(stale.vaults?.find((v) => v.id === "v_live")?.balance).toBe(250);
    for (const [field, live] of [["vaults", "v_live"], ["trades", "t_live"], ["ledger", "l_live"], ["callers", "c_live"]] as const) {
      expect(has(stale[field], live)).toBe(true);
      expect(has(stale[field], live.replace("live", "stored"))).toBe(false);
    }
  });

  it("still applies the fields the merge genuinely owns", async () => {
    mount(structuredClone(authoritative), "gateway");

    const res = await request(app).get("/api/agent/me").set(bearer(joined.token));

    expect(res.status).toBe(200);
    expect(stale.agents?.some((a) => a.id === joined.agentId)).toBe(true);
    expect(stale.herd.some((h) => h.id === joined.residentId)).toBe(true);
    expect(Array.isArray(stale.tombstones)).toBe(true);
  });

  it("keeps the throw inside the catch, even when the fallback send itself throws", async () => {
    mount(structuredClone(authoritative), "gateway");
    verifyThrowsAfter = 1;
    throwOnJson = true;
    const errors = spyErrors();

    // no response is ever written, so the client times out; what matters is that
    // the send's own throw stays inside the catch instead of escaping as an
    // unhandled rejection, which vitest reports as a run-level error
    await request(app)
      .get("/api/agent/me")
      .set(bearer(joined.token))
      .timeout({ response: 200 })
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 50));

    expect(errors.mock.calls.length).toBe(1);
    errors.mockRestore();
  });

  it("resolves the valid stale token on the next request, inside the cooldown", async () => {
    mount(structuredClone(authoritative), "gateway");
    // an unrelated miss pays for the reload, which also merges our join
    await request(app).get("/api/agent/me").set(bearer(UNKNOWN));
    stmts.length = 0;

    const res = await request(app).get("/api/agent/me").set(bearer(joined.token));

    expect(res.status).toBe(200);
    expect(stmts).toEqual([]); // already in memory; the cooldown costs nothing here
  });

  it("still reads again once the cooldown has passed, and resolves a newly stored credential", async () => {
    mount(withoutJoinedAgent(), "gateway");
    await request(app).get("/api/agent/me").set(bearer(UNKNOWN)); // pays for one read
    // another instance registers, AFTER this one last reloaded
    row = { snapshot: structuredClone(authoritative), rev: 8 };

    const inside = await request(app).get("/api/agent/me").set(bearer(joined.token));
    expect(inside.status).toBe(401); // deliberately inside the cooldown window

    await pastCooldown();

    const after = await request(app).get("/api/agent/me").set(bearer(joined.token));
    expect(after.status).toBe(200);
    expect(after.body.resident.id).toBe(joined.residentId);
  });
});