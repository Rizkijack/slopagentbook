import { Pool } from "pg";
import type { PgPendingQuery, PgSql } from "./pgstore.js";

/**
 * Postgres driver adapter.
 *
 * The store used to talk to Neon's fetch driver, whose `sql` tag is inert until
 * awaited and whose `transaction()` takes an ARRAY of already-built queries.
 * Both properties are load-bearing: `pgstore.ts` builds the lock + CAS update
 * as an array so they run on one connection. This adapter keeps that contract
 * on top of node-postgres, which is wire-compatible with Supabase and Prisma
 * Postgres, so switching providers is a `DATABASE_URL` change.
 */

export type DbRole = "primary" | "fallback";

export interface DbTarget {
  role: DbRole;
  sql: PgSql;
}

interface QueryResult {
  rows: Record<string, unknown>[];
}

export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(): void;
}

export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  connect(): Promise<PgClientLike>;
}

/**
 * Build a `PgSql` over an injected pool.
 *
 * Exported so the transaction contract is unit-tested without a database. The
 * real pool supplies `query` and `connect`; a fake only has to do the same.
 */
export function createPgSql(pool: PgPoolLike): PgSql {
  const pending = (strings: TemplateStringsArray, values: unknown[]): PgPendingQuery => {
    let text = strings[0] ?? "";
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1] ?? ""}`;

    // Capture at call, execute on first await. `transaction()` needs the
    // captured form, so it must not run before the transaction begins.
    let result: Promise<Record<string, unknown>[]> | null = null;
    const run = () => (result ??= pool.query(text, values).then((r) => r.rows));

    return {
      __query: { text, values },
      then: (onFulfilled, onRejected) => run().then(onFulfilled, onRejected),
    } as PgPendingQuery;
  };

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    pending(strings, values)) as PgSql;

  sql.transaction = async (queries) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results: Record<string, unknown>[][] = [];
      for (const query of queries) {
        const captured = query.__query;
        if (!captured) {
          throw new Error("transaction() requires queries created by this sql tag");
        }
        const result = await client.query(captured.text, captured.values);
        results.push(result.rows);
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  return sql;
}

const pools = new Map<string, Pool>();

function sslOptions(url: string): { rejectUnauthorized: boolean } | undefined {
  if (/[?&]sslmode=disable(?:&|$)/i.test(url)) return undefined;
  // Managed providers require TLS. Verification is on unless explicitly
  // disabled for a provider whose CA is not in the Node trust store.
  return { rejectUnauthorized: process.env.PG_SSL_VERIFY !== "0" };
}

function poolFor(url: string): Pool {
  let pool = pools.get(url);
  if (!pool) {
    const configured = Number(process.env.PG_POOL_MAX);
    pool = new Pool({
      connectionString: url,
      max: Number.isFinite(configured) && configured > 0 ? configured : 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      ssl: sslOptions(url),
    });
    pools.set(url, pool);
  }
  return pool;
}

function sqlFor(url: string): PgSql {
  return createPgSql(poolFor(url) as unknown as PgPoolLike);
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.FALLBACK_DATABASE_URL);
}

export function pgSql(): PgSql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return sqlFor(url);
}

export function fallbackPgSql(): PgSql | null {
  const url = process.env.FALLBACK_DATABASE_URL;
  return url ? sqlFor(url) : null;
}

/**
 * Configured stores, active first. When both URLs point at the same database
 * the fallback is dropped rather than mirror-writing every save onto itself.
 */
export function databaseTargets(): DbTarget[] {
  const primary = process.env.DATABASE_URL;
  const fallback = process.env.FALLBACK_DATABASE_URL;
  const targets: DbTarget[] = [];
  if (primary) targets.push({ role: "primary", sql: sqlFor(primary) });
  if (fallback && fallback !== primary) targets.push({ role: "fallback", sql: sqlFor(fallback) });
  return targets;
}

/** Test hook: close and forget every pool so a new URL gets a fresh pool. */
export async function resetPgPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((pool) => pool.end().catch(() => {})));
}
