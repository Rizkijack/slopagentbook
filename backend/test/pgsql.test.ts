import { describe, it, expect, vi } from "vitest";
import { createPgSql, type PgPoolLike } from "../src/pgsql.js";

function fakePool() {
  const poolQueries: Array<{ text: string; values?: unknown[] }> = [];
  const clientQueries: Array<{ text: string; values?: unknown[] }> = [];
  const release = vi.fn();

  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      clientQueries.push({ text, values });
      if (/BOOM/.test(text)) throw new Error("boom");
      return { rows: [{ text, values }] };
    }),
    release,
  };

  const pool: PgPoolLike = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      poolQueries.push({ text, values });
      return { rows: [{ text, values }] };
    }),
    connect: vi.fn(async () => client),
  };

  return { pool, client, release, poolQueries, clientQueries };
}

describe("createPgSql — tagged queries", () => {
  it("captures until awaited, then runs with numbered parameters", async () => {
    const { pool, poolQueries } = fakePool();
    const sql = createPgSql(pool);

    const pending = sql`SELECT ${7} AS n WHERE id = ${"town"}`;
    expect(poolQueries).toHaveLength(0);

    const rows = await pending;
    expect(rows).toEqual([{ text: "SELECT $1 AS n WHERE id = $2", values: [7, "town"] }]);
    expect(poolQueries).toEqual([{ text: "SELECT $1 AS n WHERE id = $2", values: [7, "town"] }]);
  });

  it("does not execute a captured query twice when awaited twice", async () => {
    const { pool, poolQueries } = fakePool();
    const sql = createPgSql(pool);
    const pending = sql`SELECT 1`;

    await pending;
    await pending;
    expect(poolQueries).toHaveLength(1);
  });
});

describe("createPgSql — transaction(array)", () => {
  it("runs every statement on one client, in order, inside BEGIN/COMMIT", async () => {
    const { pool, client, release, clientQueries, poolQueries } = fakePool();
    const sql = createPgSql(pool);

    const result = await sql.transaction([sql`SELECT 1`, sql`SELECT ${2}`]);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(poolQueries).toHaveLength(0);
    expect(clientQueries.map((q) => q.text)).toEqual(["BEGIN", "SELECT 1", "SELECT $1", "COMMIT"]);
    expect(clientQueries[2]!.values).toEqual([2]);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual([{ text: "SELECT $1", values: [2] }]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases when a statement fails", async () => {
    const { pool, clientQueries, release } = fakePool();
    const sql = createPgSql(pool);

    await expect(sql.transaction([sql`SELECT 1`, sql`BOOM`])).rejects.toThrow("boom");

    expect(clientQueries.map((q) => q.text)).toEqual(["BEGIN", "SELECT 1", "BOOM", "ROLLBACK"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses a plain promise that did not capture text/values", async () => {
    const { pool, clientQueries, release } = fakePool();
    const sql = createPgSql(pool);

    await expect(sql.transaction([Promise.resolve([])])).rejects.toThrow(
      "transaction() requires queries created by this sql tag",
    );
    expect(clientQueries.map((q) => q.text)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
