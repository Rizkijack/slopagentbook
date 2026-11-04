import { describe, it, expect, vi } from "vitest";
import { createPgSql, sslOptions, type PgPoolLike } from "../src/pgsql.js";

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

describe("sslOptions — verification per provider", () => {
  const prev = process.env.PG_SSL_VERIFY;
  afterEach(() => {
    if (prev === undefined) delete process.env.PG_SSL_VERIFY;
    else process.env.PG_SSL_VERIFY = prev;
  });

  it("keeps certificate verification on for Neon and Prisma Postgres", () => {
    expect(sslOptions("postgres://u:p@ep-x-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb")).toEqual({ rejectUnauthorized: true });
    expect(sslOptions("postgres://u:p@db.prisma.io:5432/postgres?sslmode=require")).toEqual({ rejectUnauthorized: true });
  });

  it("disables verification ONLY for the Supabase pooler host, whose CA Node cannot verify", () => {
    // Observed live: the pooler chain reports "self-signed certificate in
    // certificate chain" while every other provider verifies. The exception is
    // scoped to this host so the standby keeps full verification.
    expect(sslOptions("postgresql://postgres.ref:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres")).toEqual({ rejectUnauthorized: false });
  });

  it("still honours an explicit sslmode=disable and the blunt PG_SSL_VERIFY=0 override", () => {
    expect(sslOptions("postgres://u:p@db.example.com/postgres?sslmode=disable")).toBeUndefined();
    process.env.PG_SSL_VERIFY = "0";
    expect(sslOptions("postgres://u:p@db.prisma.io:5432/postgres")).toEqual({ rejectUnauthorized: false });
  });
});
