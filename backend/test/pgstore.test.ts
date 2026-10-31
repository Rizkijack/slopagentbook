import { describe, it, expect } from "vitest";
import { ensureSchema, mergeSnapshots, normalizeHerd, pgLoad, pgSave, planRemoval } from "../src/pgstore.js";

// pgstore is where the town lost residents: every Vercel instance holds its own
// in-memory world and the row is one JSONB blob, so a plain upsert made a
// lagging instance delete whatever another instance had added. The save is now
// a locked read-merge-write, and these tests pin the rule that makes that safe:
// the written snapshot is the union of the row and the writer's copy, never the
// writer's copy alone.

interface Row {
  snapshot: unknown;
  rev: number;
}

type DbState = { row: Row | null };

/**
 * In-memory stand-in for town_state.
 *
 * It models @neondatabase/serverless 1.2.0 FAITHFULLY, which is the whole
 * point: the previous version of this file accepted a CALLBACK transaction, so
 * the suite went fully green while production returned 500 on every write
 * ("transaction() expects an array of queries"). A stub more permissive than
 * the real driver is worse than no stub, so:
 *
 *  - `sql` returns a pending-query object; awaiting it runs it
 *  - `transaction` REQUIRES an array and throws on anything else, exactly like
 *    the driver does
 *  - the `rev` counter is honoured, so compare-and-swap really does reject a
 *    stale writer instead of pretending every write lands
 *
 * Pass one `state` to several `fakeDb()` calls to model several instances
 * sharing one row.
 */
function fakeDb(initial?: unknown, state: DbState = { row: initial === undefined ? null : { snapshot: initial, rev: 1 } }) {
  const log: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  /** Make the next CAS lose, simulating an instance that lost the race. */
  let stealOnce = false;

  function run(text: string, values: unknown[]): Record<string, unknown>[] {
    log.push(text);
    if (text.includes("pg_advisory_xact_lock")) return [{ pg_advisory_xact_lock: "" }];

    if (/SELECT snapshot(?:, rev)? FROM town_state/i.test(text)) {
      return state.row ? [{ snapshot: state.row.snapshot, rev: state.row.rev }] : [];
    }
    if (/INSERT INTO town_state/i.test(text)) {
      state.row = { snapshot: JSON.parse(values[1] as string), rev: (state.row?.rev ?? 0) + 1 };
      return [{ rev: state.row.rev }];
    }
    if (/UPDATE town_state SET snapshot/i.test(text)) {
      // three interpolations: merged json, id, seen rev
      if (!state.row) return [];
      if (stealOnce) {
        // another instance committed and moved rev on while we were merging
        stealOnce = false;
        state.row = { snapshot: state.row.snapshot, rev: state.row.rev + 1 };
        return [];
      }
      if (state.row.rev !== values[2]) return []; // compare-and-swap lost
      state.row = { snapshot: JSON.parse(values[0] as string), rev: state.row.rev + 1 };
      return [{ rev: state.row.rev }];
    }
    return [];
  }

  // Lazy on purpose: building `sql\`UPDATE ...\`` inside transaction([...]) must
  // NOT execute it yet — the real driver does not, and an eager stub would let
  // writes escape the transaction queue and pass the compare-and-swap check
  // against a revision that had not moved yet.
  const exec = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const pending: PromiseLike<Record<string, unknown>[]> = {
      then: (onOk, onErr) => Promise.resolve().then(() => run(text, values)).then(onOk, onErr),
    };
    return pending as never as ReturnType<Parameters<typeof pgSave>[0]>;
  };

  const sql = Object.assign(exec, {
    transaction: (queries: unknown) => {
      // the real driver's contract: a callback here is a 500 in production
      if (!Array.isArray(queries)) {
        throw new Error(
          "transaction() expects an array of queries, or a function returning an array of queries",
        );
      }
      const batch = queue.then(async () => {
        const out: Record<string, unknown>[][] = [];
        for (const q of queries as Array<PromiseLike<Record<string, unknown>[]>>) out.push(await q);
        return out;
      });
      queue = batch.then(
        () => undefined,
        () => undefined,
      );
      return batch;
    },
  }) as never as Parameters<typeof pgSave>[0];

  return { sql, log, state, stealOnce: () => (stealOnce = true) };
}

type Snap = Record<string, unknown>;

function resident(id: string, over: Snap = {}): Snap {
  return { id, name: id, mind: { doing: { place: "square" }, relationships: {} }, ...over };
}

function post(id: string, t: number): Snap {
  return { id, t, by: "someone", text: `hello ${id}`, kind: "post", replyTo: null };
}

function snap(over: Snap = {}): Snap {
  return {
    now: 1_700_000_000_000,
    config: { name: "SlopAgentbook", maxHerd: 64 },
    herd: [],
    feed: [],
    events: [],
    editions: [],
    projects: [],
    factions: [],
    quests: [],
    agents: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// BRAWL money — vault.ts records, and why they need their own merge rules
// ---------------------------------------------------------------------------
//
// The whole BRAWL suite ran file-based (DATABASE_URL unset), so `pgSave` was
// never entered by any money test and the town stayed green while production
// lost every funding. These fixtures are deliberately plain records:
// `mergeSnapshots` works on untyped rows, so what is pinned here is the merge
// rule, not the TypeScript shape.

function vault(id: string, over: Snap = {}): Snap {
  return {
    id,
    keeperId: "keeper",
    agentId: "trader",
    balance: 0,
    leash: { daily: 1, perTrade: 0.25, share: 20, sl: -20, tp: 40 },
    paused: false,
    createdAt: 1_000,
    ...over,
  };
}

function trade(id: string, over: Snap = {}): Snap {
  return {
    id,
    vaultId: "vault_1",
    agentId: "trader",
    size: 1,
    entryPrice: 100,
    pnl: 0,
    status: "open",
    openedAt: 1_000,
    ...over,
  };
}

/** One row per closed trade, so `tradeId` is the natural key. */
function entry(tradeId: string, over: Snap = {}): Snap {
  return { tradeId, agentId: "trader", pnl: 0, callerPaid: 0, keeperPaid: 0, t: 1_000, ...over };
}

function caller(id: string, over: Snap = {}): Snap {
  return { id, residentId: "caller_resident", handle: "caller", winRate: 0, totalPnl: 0, followers: [], ...over };
}

describe("BRAWL money survives pgSave — the lost-update rule for money", () => {
  it("a funded vault survives pgSave -> pgLoad", async () => {
    // THE regression test for the reported bug. With DATABASE_URL set, pgSave
    // writes mergeSnapshots(stored, mine), and money was not one of the merged
    // fields — so every funding was discarded on the next write while the
    // instance kept serving the funded balance out of memory.
    const db = fakeDb(snap({ vaults: [], trades: [], ledger: [], callers: [] }));

    await pgSave(db.sql, snap({ vaults: [vault("vault_1", { balance: 250, updatedAt: 9_000 })] }));

    const after = (await pgLoad(db.sql)) as Snap;
    expect((after.vaults as Snap[]).map((v) => v.balance)).toEqual([250]);
  });

  it("a stale instance cannot revert a funding", async () => {
    // instance B booted before A funded and still believes the vault is empty
    const shared: DbState = { row: { snapshot: snap({ vaults: [] }), rev: 1 } };

    const a = fakeDb(undefined, shared);
    await pgSave(a.sql, snap({ vaults: [vault("vault_1", { balance: 250, updatedAt: 9_000 })] }));

    const b = fakeDb(undefined, shared);
    await pgSave(b.sql, snap({ vaults: [vault("vault_1", { balance: 0, updatedAt: 1_000 })] }));

    expect(((shared.row!.snapshot as Snap).vaults as Snap[])[0]!.balance).toBe(250);
  });

  it("two instances' ledger rows both survive, neither duplicated", async () => {
    const shared: DbState = { row: { snapshot: snap({ ledger: [] }), rev: 1 } };

    const a = fakeDb(undefined, shared);
    await pgSave(a.sql, snap({ ledger: [entry("t1", { pnl: 5 }), entry("t2", { pnl: -2 })] }));

    const b = fakeDb(undefined, shared);
    // B has only its own close, and re-sends t2 because it was in its memory too
    await pgSave(b.sql, snap({ ledger: [entry("t2", { pnl: -2 }), entry("t3", { pnl: 9 })] }));

    const rows = (shared.row!.snapshot as Snap).ledger as Snap[];
    expect(rows.map((r) => r.tradeId).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("a leash change and a halt survive a stale instance's save", async () => {
    const shared: DbState = { row: { snapshot: snap({ vaults: [] }), rev: 1 } };

    const a = fakeDb(undefined, shared);
    await pgSave(
      a.sql,
      snap({ vaults: [vault("vault_1", { paused: true, leash: { daily: 9, perTrade: 9, share: 9, sl: -9, tp: 9 }, updatedAt: 9_000 })] }),
    );

    const b = fakeDb(undefined, shared);
    await pgSave(b.sql, snap({ vaults: [vault("vault_1", { paused: false, updatedAt: 1_000 })] }));

    const kept = (shared.row!.snapshot as Snap).vaults as Snap[];
    expect(kept[0]!.paused).toBe(true);
    expect((kept[0]!.leash as Snap).daily).toBe(9);
  });

  it("a closed trade and its ledger row survive a stale instance's save", async () => {
    const shared: DbState = { row: { snapshot: snap({ trades: [], ledger: [] }), rev: 1 } };

    const a = fakeDb(undefined, shared);
    await pgSave(
      a.sql,
      snap({
        trades: [trade("t1", { status: "closed", pnl: 5, closedAt: 9_000, updatedAt: 9_000 })],
        ledger: [entry("t1", { pnl: 5, t: 9_000 })],
      }),
    );

    // B booted before the close and still holds the trade open
    const b = fakeDb(undefined, shared);
    await pgSave(b.sql, snap({ trades: [trade("t1", { status: "open", updatedAt: 1_000 })] }));

    const after = (shared.row!.snapshot as Snap);
    expect((after.trades as Snap[])[0]!.status).toBe("closed");
    expect((after.ledger as Snap[]).map((r) => r.tradeId)).toEqual(["t1"]);
  });

  it("a registered caller survives a stale instance's save, with both followers", async () => {
    const shared: DbState = { row: { snapshot: snap({ callers: [] }), rev: 1 } };

    const a = fakeDb(undefined, shared);
    await pgSave(a.sql, snap({ callers: [caller("caller_1", { followers: ["f1"], updatedAt: 9_000 })] }));

    // B has never heard of the registration and re-saves an empty registry
    const b = fakeDb(undefined, shared);
    await pgSave(b.sql, snap({ callers: [] }));

    const kept = (shared.row!.snapshot as Snap).callers as Snap[];
    expect(kept.map((c) => c.id)).toEqual(["caller_1"]);
    expect(kept[0]!.followers).toEqual(["f1"]);
  });
});

describe("mergeSnapshots — the BRAWL money contract", () => {
  const mergedOf = (stored: Snap, mine: Snap) => mergeSnapshots(snap(stored), snap(mine)) as Snap;

  it("unions ledger rows by tradeId, the live side winning a conflict", () => {
    const merged = mergedOf(
      { ledger: [entry("t1", { pnl: 5 })] },
      { ledger: [entry("t1", { pnl: 50 }), entry("t2", { pnl: 7 })] },
    );

    const rows = merged.ledger as Snap[];
    expect(rows).toHaveLength(2); // one row per closed trade, never duplicated
    expect(rows.find((r) => r.tradeId === "t1")!.pnl).toBe(50);
  });

  it("never lets a stale open trade overwrite a closed one", () => {
    // balance is debited at open and credited at close, so resurrecting an
    // `open` row would silently rewrite money that already settled.
    // RANK and RECENCY DISAGREE here: the stored `open` is newer (9_000) than the
    // live `closed` (1_000), so only the terminal-first rule keeps this correct.
    // The winner is on the LIVE side on purpose — a rule inverted to "stored
    // always wins" must not be able to pass this.
    const merged = mergedOf(
      { trades: [trade("t1", { status: "open", updatedAt: 9_000 })] },
      { trades: [trade("t1", { status: "closed", pnl: 5, closedAt: 1_000, updatedAt: 1_000 })] },
    );

    const kept = (merged.trades as Snap[])[0]!;
    expect(kept.status).toBe("closed");
    expect(kept.pnl).toBe(5);
  });

  it("keeps a rejected trade terminal against a newer stale open record", () => {
    // the mirror of the case above: the LIVE side holds the terminal record and
    // the STORED side holds a newer `open` one
    const merged = mergedOf(
      { trades: [trade("t1", { status: "open", updatedAt: 9_000 })] },
      { trades: [trade("t1", { status: "rejected", reason: "leash", updatedAt: 1_000 })] },
    );

    expect((merged.trades as Snap[])[0]!.status).toBe("rejected");
  });

  it("takes the vault with the greater updatedAt", () => {
    // the winner is the LIVE side, so "stored always wins" cannot pass
    const merged = mergedOf(
      { vaults: [vault("vault_1", { balance: 0, updatedAt: 1_000 })] },
      { vaults: [vault("vault_1", { balance: 250, updatedAt: 9_000 })] },
    );

    expect((merged.vaults as Snap[])[0]!.balance).toBe(250);
  });

  it("lets the live side win when the stored row predates updatedAt", () => {
    // a save written before updatedAt existed must still merge, and must not
    // lose to itself on a tie of "neither side knows when this changed"
    const merged = mergedOf(
      { vaults: [vault("vault_1", { balance: 100 })] },
      { vaults: [vault("vault_1", { balance: 250, updatedAt: 9_000 })] },
    );

    expect((merged.vaults as Snap[])[0]!.balance).toBe(250);
  });

  it("does not throw when neither side carries updatedAt", () => {
    let merged!: Snap;
    expect(() => {
      merged = mergedOf(
        { vaults: [vault("vault_1", { balance: 100 })] },
        { vaults: [vault("vault_1", { balance: 7 })] },
      );
    }).not.toThrow();
    expect((merged.vaults as Snap[])[0]!.balance).toBe(7); // live wins the legacy tie
  });

  it("unions followers within a caller record and takes stats from the newer side", () => {
    const merged = mergedOf(
      { callers: [caller("caller_1", { followers: ["f1"], totalPnl: 5, updatedAt: 1_000 })] },
      { callers: [caller("caller_1", { followers: ["f2"], totalPnl: 50, updatedAt: 9_000 })] },
    );

    const kept = (merged.callers as Snap[])[0]!;
    // followers is a grow-only set, so it unions rather than being overwritten
    expect([...(kept.followers as string[])].sort()).toEqual(["f1", "f2"]);
    // the derived stats come from whichever record is newer
    expect(kept.totalPnl).toBe(50);
  });

  it("drops a tombstoned resident from a caller's follower list", () => {
    // the record survives (the caller is alive); only the dead follower's entry
    // is removed, otherwise it would sit in followers forever
    const merged = mergedOf(
      { callers: [caller("caller_1", { followers: ["gone", "alive"], updatedAt: 1_000 })] },
      { tombstones: [{ id: "gone", reason: "admin", at: 1, agentIds: [] }] },
    );

    expect((merged.callers as Snap[])[0]!.followers).toEqual(["alive"]);
  });

  it("drops a tombstoned resident's vault, ledger rows, caller and agent row", () => {
    const merged = mergedOf(
      {
        vaults: [vault("vault_1", { agentId: "gone" }), vault("vault_2", { agentId: "here" })],
        ledger: [entry("t1", { agentId: "gone" }), entry("t2", { agentId: "here" })],
        callers: [caller("caller_1", { residentId: "gone" })],
        agents: [{ id: "ag1", residentId: "gone" }],
      },
      { tombstones: [{ id: "gone", reason: "admin", at: 1, agentIds: ["ag1"] }] },
    );

    expect((merged.vaults as Snap[]).map((v) => v.id)).toEqual(["vault_2"]);
    expect((merged.ledger as Snap[]).map((r) => r.tradeId)).toEqual(["t2"]);
    expect((merged.callers as Snap[])).toEqual([]);
    expect((merged.agents as Snap[])).toEqual([]);
  });

  it("leaves the four fields empty when neither side has them", () => {
    const merged = mergeSnapshots(snap(), snap()) as Snap;
    expect(merged.vaults).toEqual([]);
    expect(merged.trades).toEqual([]);
    expect(merged.ledger).toEqual([]);
    expect(merged.callers).toEqual([]);
  });
});

describe("planRemoval — money is never destroyed silently", () => {
  const townWithVault = (over: Snap = {}) =>
    snap({
      herd: [resident("A")],
      vaults: [vault("vault_1", { keeperId: "A", agentId: "A", balance: 0, updatedAt: 1_000 })],
      trades: [trade("t1", { agentId: "A", status: "closed" })],
      ledger: [entry("t1", { agentId: "A" })],
      callers: [caller("caller_1", { residentId: "A" })],
      ...over,
    });

  const funded = () =>
    townWithVault({ vaults: [vault("vault_1", { keeperId: "A", agentId: "A", balance: 2.5, updatedAt: 1_000 })] });

  it("refuses to remove a resident whose vault still holds a balance", () => {
    const plan = planRemoval(funded(), "A");

    expect(plan.ok).toBe(false);
    expect(plan.blockedBy).toMatch(/balance/i);
  });

  it("reports the money it WOULD destroy, so a dry run is not a lie", () => {
    const plan = planRemoval(funded(), "A");

    // the operator must see the balance AND the ledger history in the dry run
    expect(plan.wouldRemove.vaults).toHaveLength(1);
    expect(plan.wouldRemove.vaults[0]!.balance).toBe(2.5);
    expect(plan.wouldRemove.trades).toHaveLength(1);
    expect(plan.wouldRemove.ledgerRows).toHaveLength(1);
    expect(plan.wouldRemove.callers).toHaveLength(1);
  });

  it("allows removal when the vault is empty", () => {
    const plan = planRemoval(townWithVault(), "A");

    expect(plan.ok).toBe(true);
    expect(plan.wouldRemove.vaults).toHaveLength(1);
    expect(plan.wouldRemove.ledgerRows).toHaveLength(1);
  });

  it("still reports the money when a pre-existing refusal is what blocks", () => {
    const withChild = townWithVault({
      herd: [resident("A"), resident("B", { parent: "A" })],
      vaults: [vault("vault_1", { keeperId: "A", agentId: "A", balance: 9, updatedAt: 1_000 })],
    });
    const plan = planRemoval(withChild, "A");

    expect(plan.ok).toBe(false);
    expect(plan.blockedBy).toMatch(/child/); // the pre-existing refusal still wins
    expect(plan.wouldRemove.vaults[0]!.balance).toBe(9);
  });
});

describe("ensureSchema", () => {
  it("creates town_state and adds the rev column", async () => {
    const { sql, log } = fakeDb();
    await ensureSchema(sql);
    const all = log.join(" ");
    expect(all).toMatch(/CREATE TABLE IF NOT EXISTS town_state/);
    // CREATE TABLE IF NOT EXISTS is a no-op on the existing row, so the rev
    // column that the compare-and-swap depends on needs its own statement
    expect(all).toMatch(/ALTER TABLE town_state ADD COLUMN IF NOT EXISTS rev bigint/);
  });
});

describe("pgLoad", () => {
  it("returns the snapshot, null when the row is absent", async () => {
    const full = fakeDb({ herd: [] });
    expect(await pgLoad(full.sql)).toEqual({ herd: [] });
    const empty = fakeDb();
    expect(await pgLoad(empty.sql)).toBeNull();
  });

  it("parses a JSONB column that came back as a string", async () => {
    const db = fakeDb();
    const rows = [{ snapshot: JSON.stringify({ herd: [] }) }];
    const sql = (async () => rows) as never as Parameters<typeof pgLoad>[0];
    expect(await pgLoad(sql)).toEqual({ herd: [] });
    expect(db.sql).toBeDefined();
  });
});

describe("mergeSnapshots", () => {
  it("keeps residents the writer has never heard of", () => {
    const stored = snap({ herd: [resident("A"), resident("B")] });
    const mine = snap({ herd: [resident("B"), resident("C")] });
    const merged = mergeSnapshots(stored, mine) as Snap;

    expect((merged.herd as Snap[]).map((r) => r.id)).toEqual(["A", "B", "C"]);
  });

  it("prefers the writer's copy of a resident both instances know", () => {
    const stored = snap({ herd: [resident("A", { job: "miller" })] });
    const mine = snap({ herd: [resident("A", { job: "smith" })] });
    const merged = mergeSnapshots(stored, mine) as Snap;

    expect((merged.herd as Snap[])[0]!.job).toBe("smith");
  });

  it("unions the feed newest-first under the cap", () => {
    const stored = snap({ feed: [post("p1", 100), post("p2", 200)] });
    const mine = snap({ feed: [post("p3", 300)] });
    const merged = mergeSnapshots(stored, mine) as Snap;

    expect((merged.feed as Snap[]).map((p) => p.id)).toEqual(["p3", "p2", "p1"]);

    const flood = snap({ feed: Array.from({ length: 500 }, (_, i) => post(`f${i}`, i)) });
    const capped = mergeSnapshots(snap(), flood) as Snap;
    expect((capped.feed as Snap[])).toHaveLength(400);
    expect((capped.feed as Snap[])[0]!.id).toBe("f499"); // newest survives the cut
  });

  it("deduplicates events that both instances generated, keeping the newest 120", () => {
    const shared = { t: 500, kind: "weather", text: "Rain." };
    const stored = snap({ events: [shared, { t: 100, kind: "weather", text: "Fog." }] });
    const mine = snap({ events: [shared, { t: 900, kind: "quest", text: "Done." }] });
    const merged = mergeSnapshots(stored, mine) as Snap;

    const events = merged.events as Snap[];
    expect(events).toHaveLength(3); // the identical event is one row
    expect(events.map((e) => e.t)).toEqual([100, 500, 900]);

    const flood = Array.from({ length: 200 }, (_, i) => ({ t: i, kind: "weather", text: `w${i}` }));
    const capped = mergeSnapshots(snap(), snap({ events: flood })) as Snap;
    expect((capped.events as Snap[])).toHaveLength(120);
    expect((capped.events as Snap[])[119]!.t).toBe(199);
  });

  it("never shrinks the agent registry and keeps the freshest activity clock", () => {
    const stored = snap({
      agents: [
        { id: "ag1", residentId: "A", tokenHash: "hash1", lastActAt: 5_000 },
        { id: "ag2", residentId: "B", tokenHash: "hash2", lastActAt: 5_000 },
      ],
    });
    // an instance that booted before ag2 was ever registered saves now
    const mine = snap({ agents: [{ id: "ag1", residentId: "A", tokenHash: "hash1", lastActAt: 9_000 }] });
    const merged = mergeSnapshots(stored, mine) as Snap;

    const agents = merged.agents as Snap[];
    expect(agents.map((a) => a.id)).toEqual(["ag1", "ag2"]);
    // stale writer must not age an active agent back into sim control
    expect(agents[0]!.lastActAt).toBe(9_000);
    expect(agents[1]!.lastActAt).toBe(5_000);
  });

  it("caps editions, quests and contests at the lengths the town actually keeps", () => {
    const editions = Array.from({ length: 40 }, (_, i) => ({ no: i + 1, headline: `e${i}` }));
    const quests = Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, createdAt: i, title: `q${i}` }));
    const contests = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, startsAt: i, title: `c${i}` }));

    const merged = mergeSnapshots(snap(), snap({ editions, quests, contests })) as Snap;
    expect((merged.editions as Snap[])).toHaveLength(20);
    expect((merged.editions as Snap[])[0]!.no).toBe(40);
    expect((merged.quests as Snap[])).toHaveLength(12);
    expect((merged.quests as Snap[])[0]!.id).toBe("q29");
    expect((merged.contests as Snap[])).toHaveLength(8);
  });

  // Quest progress is accumulated state — there is no tick that re-derives it,
  // so the ours-wins union used to let a lagging instance rewrite 2/3 back to
  // 1/3 (observed live 2026-10-31). Each quest id now picks by monotonic
  // status/progress instead.
  function quest(id: string, over: Snap = {}): Snap {
    return {
      id,
      title: `quest ${id}`,
      description: "test quest",
      giver: "board",
      giverName: "Board",
      type: "talk",
      progress: 0,
      required: 3,
      reward: { text: "x" },
      status: "available",
      createdAt: 1_000,
      expiresAt: null,
      ...over,
    };
  }

  describe("mergeSnapshots — the quest monotonicity contract", () => {
    it("a lagging instance cannot rewrite higher progress back down", () => {
      const stored = snap({ quests: [quest("q1", { status: "active", progress: 2 })] });
      const mine = snap({ quests: [quest("q1", { status: "active", progress: 1 })] });
      const merged = mergeSnapshots(stored, mine) as Snap;
      expect((merged.quests as Snap[])[0]!.progress).toBe(2);
    });

    it("a claim paid at another instance beats a stale active copy", () => {
      const stored = snap({ quests: [quest("q1", { status: "claimed", progress: 3, claimedBy: "r1", claimedAt: 900 })] });
      const mine = snap({ quests: [quest("q1", { status: "active", progress: 1 })] });
      const merged = mergeSnapshots(stored, mine) as Snap;
      expect((merged.quests as Snap[])[0]!.status).toBe("claimed");
      expect((merged.quests as Snap[])[0]!.claimedBy).toBe("r1");
    });

    it("a quest completed at another instance is never walked back to active", () => {
      const stored = snap({ quests: [quest("q1", { status: "completed", progress: 3 })] });
      const mine = snap({ quests: [quest("q1", { status: "active", progress: 2 })] });
      const merged = mergeSnapshots(stored, mine) as Snap;
      expect((merged.quests as Snap[])[0]!.status).toBe("completed");
    });

    it("an instance that has not yet seen an expiry cannot resurrect the quest", () => {
      // mine has retired q1 (status expired); stored still carries it active.
      // The union starts from the stored row, so only the status rule keeps it
      // retired.
      const stored = snap({ quests: [quest("q1", { status: "active", progress: 1 })] });
      const mine = snap({ quests: [quest("q1", { status: "expired" })] });
      const merged = mergeSnapshots(stored, mine) as Snap;
      expect((merged.quests as Snap[])[0]!.status).toBe("expired");
    });

    it("a writer that has not seen the expiry also cannot resurrect it", () => {
      // mirror of the above with the roles swapped — a writer whose memory
      // never expired the quest must not beat the row that says expired.
      const stored = snap({ quests: [quest("q1", { status: "expired" })] });
      const mine = snap({ quests: [quest("q1", { status: "active", progress: 1 })] });
      const merged = mergeSnapshots(stored, mine) as Snap;
      expect((merged.quests as Snap[])[0]!.status).toBe("expired");
    });

    it("new quests from the other side survive; equal states keep the writer's copy", () => {
      const stored = snap({ quests: [quest("q_old", { status: "active", progress: 2 })] });
      const mine = snap({
        quests: [
          quest("q_new", { status: "available", createdAt: 2_000 }),
          quest("q_old", { status: "active", progress: 2 }),
        ],
      });
      const merged = mergeSnapshots(stored, mine) as Snap;
      expect((merged.quests as Snap[]).map((q) => q.id)).toEqual(["q_new", "q_old"]);
    });
  });

  it("never exceeds maxHerd even when both instances were under the cap", () => {
    // the real failure this fixes: two instances each legitimately under 64
    // saved in turn and the union came out at 69
    const stored = snap({
      herd: Array.from({ length: 64 }, (_, i) => resident(`s${i}`, { born: 1_000 + i })),
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    const mine = snap({
      herd: Array.from({ length: 5 }, (_, i) => resident(`m${i}`, { born: 9_000 + i })),
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });

    const merged = mergeSnapshots(stored, mine) as Snap;
    const herd = merged.herd as Snap[];
    expect(herd).toHaveLength(64);
    // the newest arrivals survive; the oldest of the stale side is what goes
    expect(herd.filter((r) => String(r.id).startsWith("m"))).toHaveLength(5);
    expect(herd.some((r) => r.id === "s0")).toBe(false);
    expect(herd.some((r) => r.id === "s63")).toBe(true);
  });

  it("leaves an under-cap herd untouched", () => {
    const merged = mergeSnapshots(
      snap({ herd: [resident("A", { born: 1 })] }),
      snap({ herd: [resident("B", { born: 2 })] }),
    ) as Snap;
    expect((merged.herd as Snap[]).map((r) => r.id)).toEqual(["A", "B"]);
  });

  it("keeps the older of two residents that share a name", () => {
    // two instances each admitted "Ochre" without seeing the other
    const stored = snap({
      herd: [resident("old", { name: "Ochre", born: 1_000 })],
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    const mine = snap({
      herd: [resident("new", { name: "ochre", born: 2_000 })],
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });

    const herd = (mergeSnapshots(stored, mine) as Snap).herd as Snap[];
    expect(herd).toHaveLength(1);
    expect(herd[0]!.id).toBe("old");
  });

  it("drops a duplicate name BEFORE capping, so the freed slot is reused", () => {
    const stored = snap({
      herd: Array.from({ length: 64 }, (_, i) => resident(`s${i}`, { born: 1_000 + i })),
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    const mine = snap({
      // a fresh resident that collides with the oldest stored name
      herd: [resident("dup", { name: "Resident 0", born: 9_500 })],
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });

    const herd = (mergeSnapshots(stored, mine) as Snap).herd as Snap[];
    expect(herd).toHaveLength(64);
    // the duplicate was pruned, so nothing had to be evicted for capacity
    expect(herd.some((r) => r.id === "dup")).toBe(true);
    expect(herd.filter((r) => String(r.id).startsWith("s"))).toHaveLength(63);
  });

  it("does not treat residents with no name as duplicates of each other", () => {
    const merged = mergeSnapshots(
      snap({ herd: [resident("A"), resident("B")] }),
      snap(),
    ) as Snap;
    expect((merged.herd as Snap[])).toHaveLength(2);
  });

  describe("normalizeHerd — boot-time healing", () => {
  it("trims an over-cap row back to maxHerd, keeping the newest", () => {
    // the row as it exists in production right now: 69 residents, cap 64
    const row = snap({
      herd: Array.from({ length: 69 }, (_, i) => resident(`r${i}`, { born: 1_000 + i })),
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    const out = normalizeHerd(row);
    expect(out).toHaveLength(64);
    expect(out.some((r) => r.id === "r0")).toBe(false); // oldest dropped
    expect(out.some((r) => r.id === "r68")).toBe(true); // newest kept
  });

  it("prunes a duplicate name without touching anything else", () => {
    const row = snap({
      herd: [
        resident("old", { name: "Ochre", born: 1_000 }),
        resident("new", { name: "Ochre", born: 2_000 }),
        resident("x", { name: "Peregrine", born: 1_500 }),
      ],
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    const out = normalizeHerd(row);
    expect(out.map((r) => r.id)).toEqual(["old", "x"]);
  });

  it("leaves a healthy row exactly as it was", () => {
    const row = snap({
      herd: [resident("A", { born: 1 }), resident("B", { born: 2 })],
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    expect(normalizeHerd(row).map((r) => r.id)).toEqual(["A", "B"]);
  });

  it("does not throw on a snapshot with no config or no herd", () => {
    expect(normalizeHerd(null)).toEqual([]);
    expect(normalizeHerd({})).toEqual([]);
    expect(normalizeHerd({ herd: "not an array" })).toEqual([]);
  });
});

it("survives garbage on either side instead of throwing", () => {
    expect(() => mergeSnapshots(null, undefined)).not.toThrow();
    expect(() => mergeSnapshots({ herd: "not an array" }, { feed: 42 })).not.toThrow();
    const merged = mergeSnapshots({ herd: "not an array" }, { feed: 42 }) as Snap;
    expect(merged.herd).toEqual([]);
    expect(merged.feed).toEqual([]);
  });
});

describe("pgSave — the lost-update rule", () => {
  it("writes the union, so a lagging instance cannot delete new residents", async () => {
    // ONE row, two instances — that is the whole point of the merge
    const shared: DbState = { row: { snapshot: snap({ herd: [resident("Vetch")] }), rev: 1 } };

    // instance A boots, forks a resident, saves
    const a = fakeDb(undefined, shared);
    await pgSave(a.sql, snap({ herd: [resident("Vetch"), resident("Garnet")] }));

    // instance B booted BEFORE that and still believes the town is just Vetch
    const b = fakeDb(undefined, shared);
    await pgSave(b.sql, snap({ herd: [resident("Vetch")], quests: [{ id: "q1", createdAt: 1 }] }));

    expect(((shared.row!.snapshot as Snap).herd as Snap[]).map((r) => r.id)).toEqual(["Vetch", "Garnet"]);
    expect((shared.row!.snapshot as Snap).quests).toHaveLength(1);
  });

  it("takes the advisory lock and writes with a compare-and-swap on rev", async () => {
    const db = fakeDb(snap({ herd: [resident("A")] }));
    await pgSave(db.sql, snap({ herd: [resident("A"), resident("B")] }));

    const all = db.log.join(" | ");
    expect(all).toContain("pg_advisory_xact_lock");
    // the write is conditional on the revision we read, which is what stops a
    // stale writer from silently overwriting a fresher one
    expect(all).toMatch(/UPDATE town_state SET snapshot[\s\S]*WHERE id = \? AND rev = \?/);
    // and the read must happen BEFORE that write
    expect(db.log.findIndex((l) => /SELECT snapshot, rev/i.test(l))).toBeLessThan(
      db.log.findIndex((l) => /UPDATE town_state/i.test(l)),
    );
  });

  it("re-reads and re-merges when another writer wins the race", async () => {
    const db = fakeDb(snap({ herd: [resident("A")] }));
    db.stealOnce(); // someone else commits first, moving rev on

    await pgSave(db.sql, snap({ herd: [resident("A"), resident("Mine")] }));

    // the save retried instead of overwriting: our resident is there AND the
    // row's rev advanced past the one we first read
    expect(((db.state.row!.snapshot as Snap).herd as Snap[]).map((r) => r.id)).toEqual(["A", "Mine"]);
    expect(db.state.row!.rev).toBe(3); // 1 → stolen to 2 → our successful CAS to 3
    expect(db.log.filter((l) => /SELECT snapshot, rev/i.test(l))).toHaveLength(2);
  });

  it("still persists when every attempt loses the race", async () => {
    const db = fakeDb(snap({ herd: [resident("A")] }));
    // starve the retry loop: each CAS loses
    for (let i = 0; i < 6; i++) db.stealOnce();

    await pgSave(db.sql, snap({ herd: [resident("A"), resident("Last")] }));

    // the fallback write must land — losing the merge race is not a reason to
    // lose the town's data
    expect(((db.state.row!.snapshot as Snap).herd as Snap[]).map((r) => r.id)).toEqual(["A", "Last"]);
  });

  it("creates the row without a merge when the town has never been saved", async () => {
    const db = fakeDb();
    await pgSave(db.sql, snap({ herd: [resident("First")] }));
    expect((db.state.row!.snapshot as Snap).herd).toEqual([resident("First")]);
  });

  it("survives concurrent saves from two instances — nobody's residents vanish", async () => {
    const db = fakeDb(snap({ herd: [] }));
    await Promise.all([
      pgSave(db.sql, snap({ herd: [resident("A"), resident("B")] })),
      pgSave(db.sql, snap({ herd: [resident("C"), resident("D")] })),
    ]);
    const ids = ((db.state.row!.snapshot as Snap).herd as Snap[]).map((r) => r.id).sort();
    expect(ids).toEqual(["A", "B", "C", "D"]);
  });

  it("rejects a callback-style transaction the way the real driver does", async () => {
    // This is the regression guard for the production outage: the previous
    // implementation passed an `async (tx) => { await tx\`...\` }` callback to
    // neon().transaction(), which throws at runtime on 1.2.0 and 500s every
    // write. The stub enforces the array contract so that shape cannot come
    // back without turning this file red.
    const { sql } = fakeDb();
    const bad = sql as unknown as { transaction: (q: unknown) => Promise<unknown> };
    expect(() => bad.transaction(async () => [])).toThrow(/expects an array of queries/);
  });
});