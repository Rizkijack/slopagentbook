import { describe, it, expect, beforeEach } from "vitest";
import { clearStoreCache, pgLoad, pgLoadQuests, pgLoadAuthFields, pgSave } from "../src/pgstore.js";

/**
 * The rev-cache fast path, and the int8 wire format.
 *
 * The in-memory stub in pgstore.test.ts hands back `rev` as a NUMBER because
 * that test's subject is the merge, not the wire. This file's subject is the
 * wire, so its stub models @neondatabase/serverless faithfully on the ONE fact
 * that production hits: the bundled pg-types parser for OID 20 (int8/bigint)
 * is `parseBigInteger`, which returns the digits as a STRING. Real neon()
 * answers `SELECT rev ...` with `"12637"`, never 12637 — and the previous
 * coercion read that as rev 0, dropped every compare-and-swap on the floor,
 * and silently ran every production save through the retry loop and the
 * fallback upsert (correct data, ~5x the transfer).
 *
 * So here every rev crosses the stub boundary as a string, in both directions
 * a driver could surface it, and the tests pin the behavior that requires.
 */

interface Row { snapshot: string; rev: string }
type DbState = { row: Row | null };

function fakeDb(initial?: unknown, state: DbState = { row: initial === undefined ? null : { snapshot: JSON.stringify(initial), rev: "1" } }) {
  const log: string[] = [];
  let stealOnce = false;

  function run(text: string, values: unknown[]): Record<string, unknown>[] {
    log.push(text);
    if (text.includes("pg_advisory_xact_lock")) return [{ pg_advisory_xact_lock: "" }];
    if (/SELECT rev(?:, snapshot)? FROM town_state/i.test(text)) {
      return state.row ? [{ rev: state.row.rev }] : [];
    }
    if (/snapshot->'quests' AS quests FROM town_state/i.test(text)) {
      if (!state.row) return [];
      const parsed = JSON.parse(state.row.snapshot) as Record<string, unknown>;
      return [
        {
          kind: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? "object" : "other",
          herd_kind: Array.isArray(parsed.herd) ? "array" : "other",
          quests: parsed.quests ?? null,
        },
      ];
    }
    if (/snapshot->'tombstones' AS tombstones FROM town_state/i.test(text)) {
      if (!state.row) return [];
      const parsed = JSON.parse(state.row.snapshot) as Record<string, unknown>;
      return [
        {
          kind: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? "object" : "other",
          herd_kind: Array.isArray(parsed.herd) ? "array" : "other",
          agents: parsed.agents ?? null,
          herd: parsed.herd ?? null,
          tombstones: parsed.tombstones ?? null,
        },
      ];
    }
    if (/SELECT snapshot(?:, rev)? FROM town_state/i.test(text)) {
      return state.row ? [{ snapshot: state.row.snapshot, rev: state.row.rev }] : [];
    }
    if (/INSERT INTO town_state/i.test(text)) {
      state.row = { snapshot: String(values[1]), rev: String((state.row ? Number(state.row.rev) : 0) + 1) };
      return [{ rev: state.row.rev }];
    }
    if (/UPDATE town_state SET snapshot/i.test(text)) {
      if (!state.row) return [];
      if (stealOnce) {
        stealOnce = false;
        state.row = { snapshot: state.row.snapshot, rev: String(Number(state.row.rev) + 1) };
        return [];
      }
      // the CAS rev is the LAST interpolated value in both write shapes
      // (the snapshot value, sometimes an id, then the expected rev)
      if (Number(state.row.rev) !== Number(values[values.length - 1])) return [];
      state.row = { snapshot: String(values[0]), rev: String(Number(state.row.rev) + 1) };
      return [{ rev: state.row.rev }];
    }
    return [];
  }

  const exec = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    return {
      then: (onOk: (rows: Record<string, unknown>[]) => unknown) =>
        Promise.resolve().then(() => run(text, values)).then(onOk),
    } as never as ReturnType<Parameters<typeof pgSave>[0]>;
  };
  const transaction = (queries: unknown[]) => {
    // like the real driver: run the array in order, return one result per query
    const out: unknown[] = new Array(queries.length);
    let chain: Promise<unknown> = Promise.resolve();
    queries.forEach((q, i) => {
      chain = chain.then(() => Promise.resolve(q).then((r) => { out[i] = r; }));
    });
    return chain.then(() => out);
  };
  return { sql: Object.assign(exec, { transaction }) as never, log, state, stealOnce: () => (stealOnce = true) };
}

beforeEach(() => clearStoreCache());

const snap = (over: Record<string, unknown>) => ({ name: "t", now: 1, ...over });
const resident = (id: string) => ({ id });

describe("rev numbers that come back as int8 strings (the neon wire)", () => {
  it("still compare-and-swaps: the write lands when the row's rev is a string", async () => {
    const db = fakeDb(snap({ herd: [resident("A")] }));
    await pgSave(db.sql, snap({ now: 2, herd: [resident("A"), resident("B")] }));

    const all = db.log.join(" | ");
    expect(all).toMatch(/UPDATE town_state SET snapshot[\s\S]*WHERE id = \? AND rev = \?/);
    expect(Number(db.state.row!.rev)).toBe(2); // 1 (string "1") + our CAS win
    expect((JSON.parse(db.state.row!.snapshot) as { herd: { id: string }[] }).herd.map((r) => r.id)).toEqual(["A", "B"]);
    // AND the write came from the first compare-and-swap, not the retry loop:
    // with rev read as rev-0 the CAS loses SATU KALI per attempt — the old
    // coercion gave 4 losing full-row reads plus the fallback upsert (correct
    // data, ~5x the transfer). One read, one write.
    expect(db.log.filter((l) => /SELECT snapshot, rev/i.test(l))).toHaveLength(1);
  });
});

describe("the rev-cache fast path", () => {
  it("answers an unchanged second save with ONE rev ping and nothing else", async () => {
    const db = fakeDb();
    await pgSave(db.sql, snap({ herd: [resident("A")] }));   // full path: INSERT
    db.log.length = 0;
    await pgSave(db.sql, snap({ now: 999, herd: [resident("A")] })); // only the clock moved

    // one tiny read, no UPDATE, no INSERT: the row is already this content
    expect(db.log).toHaveLength(1);
    expect(db.log[0]).toMatch(/SELECT rev FROM town_state/);
    expect(Number(db.state.row!.rev)).toBe(1);
  });

  it("merges against the cache instead of re-reading the whole row", async () => {
    const db = fakeDb();
    await pgSave(db.sql, snap({ herd: [resident("A")] }));
    db.log.length = 0;
    await pgSave(db.sql, snap({ now: 9, herd: [resident("A"), resident("B")] }));

    const all = db.log.join(" | ");
    expect(all).not.toMatch(/SELECT snapshot/);       // the old full-row read is gone
    expect(all).toMatch(/UPDATE town_state SET snapshot/); // and the write is there
    const herd = (JSON.parse(db.state.row!.snapshot) as { herd: { id: string }[] }).herd.map((r) => r.id);
    expect(herd).toEqual(["A", "B"]);
  });

  it("falls back to the full path when ANOTHER instance moved rev, and keeps their data", async () => {
    const shared: DbState = { row: null };
    const a = fakeDb(undefined, shared);
    await pgSave(a.sql, snap({ herd: [resident("A")] }));

    // a foreign writer lands while instance a's cache still says rev 1
    shared.row!.snapshot = JSON.stringify(snap({ now: 5, herd: [resident("A"), resident("Other")] }));
    shared.row!.rev = String(Number(shared.row!.rev) + 1);

    await pgSave(a.sql, snap({ now: 6, herd: [resident("A"), resident("Mine")] }));

    const all = a.log.join(" | ");
    expect(all).toMatch(/SELECT snapshot, rev/);                     // full path ran
    const herd = (JSON.parse(shared.row!.snapshot) as { herd: { id: string }[] }).herd.map((r) => r.id);
    expect(herd).toEqual(["A", "Other", "Mine"]);                    // foreign data survives
  });

  it("loses the CAS fairly when the rev moves between read and write", async () => {
    const db = fakeDb();
    await pgSave(db.sql, snap({ herd: [resident("A")] }));
    db.stealOnce();
    db.log.length = 0;

    await pgSave(db.sql, snap({ now: 3, herd: [resident("A"), resident("Late")] }));

    // fast path's CAS lost → the old full path must complete the save merged
    const all = db.log.join(" | ");
    expect(all).toMatch(/SELECT snapshot, rev/);
    const herd = (JSON.parse(db.state.row!.snapshot) as { herd: { id: string }[] }).herd.map((r) => r.id);
    expect(herd).toEqual(["A", "Late"]);
  });
});

describe("cache seeding", () => {
  it("a pgLoad caches the row, so the first unchanged save takes the fast path", async () => {
    const db = fakeDb(snap({ herd: [resident("A")] }));
    await pgLoad(db.sql);
    db.log.length = 0;

    await pgSave(db.sql, snap({ now: 77, herd: [resident("A")] }));
    expect(db.log).toEqual([expect.stringMatching(/SELECT rev FROM town_state/)]);
  });

  it("an empty row invalidates instead of seeding", async () => {
    const db = fakeDb();
    await pgLoad(db.sql); // no row → no cache
    db.state.row = { snapshot: JSON.stringify(snap({ herd: [resident("Nil")] })), rev: "1" };

    await pgSave(db.sql, snap({ herd: [resident("Nil")] }));
    const all = db.log.join(" | ");
    expect(all).toMatch(/SELECT snapshot, rev/);   // full path: cache was empty
    expect(all).toMatch(/UPDATE town_state SET snapshot/);
  });
});

describe("field-narrowed reads", () => {
  it("pgLoadQuests ships only the board — and never seeds the save cache", async () => {
    const db = fakeDb(snap({
      herd: [resident("A")],
      quests: [{ id: "q1" }],
      feed: [{ id: "p1" }],
    }));
    expect(await pgLoadQuests(db.sql)).toEqual([{ id: "q1" }]);

    // the read pulled ~one array out of a full row; the cache must stay empty
    // so the next save takes the FULL path — a partial row must never be
    // trusted as the whole town, or the fast-path merge would drop the fields
    // the narrow read never fetched
    await pgSave(db.sql, snap({ now: 2, herd: [resident("A")] }));
    expect(db.log.join(" | ")).toMatch(/SELECT snapshot, rev/);
  });

  it("pgLoadQuests: null on a missing row, [] when the key is absent", async () => {
    expect(await pgLoadQuests(fakeDb().sql)).toBeNull();
    expect(await pgLoadQuests(fakeDb(snap({ herd: [] })).sql)).toEqual([]);
  });

  it("pgLoadAuthFields ships exactly agents/herd/tombstones", async () => {
    const db = fakeDb(snap({
      herd: [resident("A")],
      agents: [{ id: "ag1" }],
      tombstones: [{ id: "gone" }],
      feed: [{ id: "p1" }],
      ledger: [{ tradeId: "t1" }],
    }));
    const fields = await pgLoadAuthFields(db.sql);
    expect(fields!.agents).toEqual([{ id: "ag1" }]);
    expect(fields!.herd).toEqual([{ id: "A" }]);
    expect(fields!.tombstones).toEqual([{ id: "gone" }]);
    // and a missing row is the same honest null the full load gives
    expect(await pgLoadAuthFields(fakeDb().sql)).toBeNull();
  });
});
