import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { saveAtomically, saveDebounced, loadWithRecovery, refreshQuestsFromStore, tickSaveDue } from "../src/persist.js";
import { existsSync, rmSync } from "fs";
import path from "path";
import os from "os";

const tmpDir = path.join(os.tmpdir(), "agentbook-test-" + Date.now());
const testPath = path.join(tmpDir, "town.json");

describe("Atomic persist", () => {
  beforeEach(() => {
    // ensure tmpDir exists via saveAtomically mkdir
  });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("writes atomically and creates backup on second write", async () => {
    await saveAtomically(testPath, { herd: [{ id: "a" }] });
    expect(existsSync(testPath)).toBe(true);
    const raw1 = await import("fs/promises").then((m) => m.readFile(testPath, "utf8"));
    expect(JSON.parse(raw1).herd[0].id).toBe("a");

    await saveAtomically(testPath, { herd: [{ id: "b" }] });
    expect(existsSync(testPath.replace(".json", ".backup.json"))).toBe(true);
    const raw2 = await import("fs/promises").then((m) => m.readFile(testPath, "utf8"));
    expect(JSON.parse(raw2).herd[0].id).toBe("b");
    const backupRaw = await import("fs/promises").then((m) => m.readFile(testPath.replace(".json", ".backup.json"), "utf8"));
    expect(JSON.parse(backupRaw).herd[0].id).toBe("a");
  });

  it("recovers from backup if main corrupted", async () => {
    await saveAtomically(testPath, { herd: [{ id: "a" }] });
    await saveAtomically(testPath, { herd: [{ id: "b" }] });
    // corrupt main
    await import("fs/promises").then((m) => m.writeFile(testPath, "corrupt"));
    const recovered: any = await loadWithRecovery(testPath);
    expect(recovered.herd[0].id).toBe("a");
  });
});

// pgSave is a locked read-merge-write, so the client it is handed must be able
// to open a transaction — the real pg adapter always can. Tests swap `fakeSql`
// per case; `pgSqlCalls` counts save attempts, not individual statements.
let fakeSql: any;
let pgSqlCalls = 0;

function makeFakeSql(
  impl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>,
): any {
  const exec = impl as any;
  exec.transaction = async (queries: unknown[]) => {
    if (!Array.isArray(queries)) throw new Error("transaction() expects an array of queries");
    return [];
  };
  return exec;
}

fakeSql = makeFakeSql(async () => []);

vi.mock("../src/pgsql.js", () => {
  const configured = () => Boolean(process.env.DATABASE_URL || process.env.FALLBACK_DATABASE_URL);
  const pgSqlFn = () => {
    pgSqlCalls += 1;
    return fakeSql;
  };
  return {
    primaryUrl: () => process.env.PRIMARY_DATABASE_URL ?? process.env.DATABASE_URL ?? null,
    hasDatabase: configured,
    pgSql: pgSqlFn,
    fallbackPgSql: () => null,
    databaseTargets: () =>
      configured() ? [{ role: "primary", sql: pgSqlFn() }] : [],
    resetPgPools: async () => {},
  };
});

describe("persist pg routing (DATABASE_URL set)", () => {
  const pgDir = path.join(os.tmpdir(), "agentbook-pg-test-" + Date.now());
  const neverPath = path.join(pgDir, "never.json");
  let prevDbUrl: string | undefined;

  beforeEach(() => {
    prevDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test";
    fakeSql = makeFakeSql(async () => []);
    pgSqlCalls = 0;
  });

  afterEach(() => {
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    try { rmSync(pgDir, { recursive: true, force: true }); } catch {}
  });

  it("saveAtomically routes to pg and does not touch disk", async () => {
    expect(existsSync(neverPath)).toBe(false);
    await saveAtomically(neverPath, { herd: [] });
    expect(pgSqlCalls).toBeGreaterThan(0);
    expect(existsSync(neverPath)).toBe(false);
  });

  it("loadWithRecovery pg-miss throws no-data error without reading disk", async () => {
    // pg-miss contract: empty pg rows → same `no data at <path> or backup`
    // error so server.ts boot falls back to createInitialWorld().
    await expect(loadWithRecovery(neverPath)).rejects.toThrow(/no data at/);
    // Disk isolation: even a real file on disk must be ignored on the pg path.
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(pgDir, { recursive: true });
    await writeFile(neverPath, JSON.stringify({ disk: true }), "utf8");
    await expect(loadWithRecovery(neverPath)).rejects.toThrow(/no data at/);
    expect(pgSqlCalls).toBeGreaterThan(0);
  });

  it("a failed debounced save is caught, not left as an unhandled rejection", async () => {
    // The debounce timer has no caller to catch a rejection. Before this guard a
    // database blip during a tick rejected out of the timer and could terminate
    // the process — the world must keep running, and the next tick rewrites the row.
    fakeSql = makeFakeSql(async () => {
      throw new Error("db down");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    saveDebounced(neverPath, { herd: [] }, 0);
    await new Promise((r) => setTimeout(r, 100));

    expect(logged).toHaveBeenCalledWith("[persist] debounced save failed:", expect.stringContaining("db down"));
    logged.mockRestore();
  });
});

describe("refreshQuestsFromStore — the board's read-through", () => {
  const pgDir = path.join(os.tmpdir(), "agentbook-pg-qtest-" + Date.now());
  const neverPath = path.join(pgDir, "never.json");
  let prevDbUrl: string | undefined;

  beforeEach(() => {
    prevDbUrl = process.env.DATABASE_URL;
    // unique per test: the cooldown is keyed per world, so a NEW world object
    // per test needs no state clearing — but set the env before importing the
    // module's behaviour matters, and it is read per call.
    process.env.DATABASE_URL = "postgres://test";
    fakeSql = makeFakeSql(async () => []);
    pgSqlCalls = 0;
  });

  afterEach(() => {
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    try { rmSync(pgDir, { recursive: true, force: true }); } catch {}
  });

  /** A client modelled like the persist.test.ts mock, but whose SELECT returns a row. */
  function rowDb(rowSnapshot: unknown): void {
    // refreshQuestsFromStore reads the NARROWED columns (`jsonb_typeof` guard
    // plus `snapshot->'quests'`) — not the full row. The guard columns are
    // what makes a wrong-shaped row refuse instead of merging as empty.
    const parsed = (rowSnapshot ?? {}) as Record<string, unknown>;
    fakeSql = makeFakeSql(async () =>
      rowSnapshot === null
        ? []
        : [
            {
              kind: typeof parsed === "object" && !Array.isArray(parsed) ? "object" : "other",
              herd_kind: Array.isArray(parsed.herd) ? "array" : "other",
              quests: parsed.quests ?? null,
            },
          ]);
  }

  it("file mode is its own store: the read-through is a no-op", async () => {
    delete process.env.DATABASE_URL;
    const world = { quests: [{ id: "q1" }] } as never;
    const ok = await refreshQuestsFromStore(neverPath, world);
    expect(ok).toBe(false);
    expect(pgSqlCalls).toBe(0);
  });

  it("raises the board to the row: a quest the instance never saw appears, progress only moves forward", async () => {
    rowDb({ herd: [], quests: [
      // exists only on the row — authored by another instance
      { id: "q_remote", status: "available", progress: 0, createdAt: 2_000 },
      // the instance's copy is BEHIND the row
      { id: "q_sync", status: "active", progress: 1, createdAt: 1_000 },
    ] });
    const world = { quests: [{ id: "q_sync", status: "active", progress: 0, createdAt: 1_000 }] } as never;
    const ok = await refreshQuestsFromStore(neverPath, world);
    expect(ok).toBe(true);
    const board = (world as unknown as { quests: Array<{ id: string; progress: number; status: string }> }).quests;
    expect(board.map((q) => q.id)).toEqual(["q_remote", "q_sync"]);
    expect(board.find((q) => q.id === "q_remote")).toBeDefined();
    expect(board.find((q) => q.id === "q_sync")!.progress).toBe(1);
  });

  it("stale memory never rewinds a claim the row already paid", async () => {
    rowDb({ herd: [], quests: [
      { id: "q1", status: "claimed", progress: 3, claimedBy: "r1", claimedAt: 900, createdAt: 1_000 },
    ] });
    const world = { quests: [{ id: "q1", status: "active", progress: 1, createdAt: 1_000 }] } as never;
    await refreshQuestsFromStore(neverPath, world);
    const board = (world as unknown as { quests: Array<{ id: string; status: string }> }).quests;
    expect(board[0]!.status).toBe("claimed");
  });

  it("a storage failure serves memory, the previous behaviour, not a 500", async () => {
    rowDb(null); // empty row → pgLoadQuests returns null → honest "not reloaded"
    const world = { quests: [{ id: "q1" }] } as never;
    const ok = await refreshQuestsFromStore(neverPath, world);
    expect(ok).toBe(false);
    expect((world as unknown as { quests: unknown[] }).quests).toHaveLength(1);
  });
});

describe("hot-save coalescing (act/say)", () => {
  const pgDir = path.join(os.tmpdir(), "agentbook-pg-coalesce-" + Date.now());
  const neverPath = path.join(pgDir, "never.json");
  let prevDbUrl: string | undefined;

  beforeEach(() => {
    prevDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test";
    fakeSql = makeFakeSql(async () => []);
    pgSqlCalls = 0;
  });

  afterEach(() => {
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    try { rmSync(pgDir, { recursive: true, force: true }); } catch {}
  });

  it("N debounced saves inside the window land as ONE pg save of the latest state", async () => {
    // one saveAtomically per debounce window, so the call count IS the save
    // count — three hot writes inside the window must cost the town one round
    // trip, not three
    vi.useFakeTimers();
    try {
      saveDebounced(neverPath, { herd: [{ id: "a" }] }, 50);
      saveDebounced(neverPath, { herd: [{ id: "b" }] }, 50);
      saveDebounced(neverPath, { herd: [{ id: "c" }] }, 50);
      await vi.advanceTimersByTimeAsync(60);
      expect(pgSqlCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a save inside the window is the LATEST data, not the first caller's", async () => {
    let written: unknown = null;
    fakeSql = makeFakeSql(async (strings, ...values) => {
      const text = strings.join("?");
      if (/INSERT INTO town_state/i.test(text)) written = JSON.parse(String(values[1]));
      return [];
    });
    vi.useFakeTimers();
    try {
      saveDebounced(neverPath, { herd: [{ id: "first" }] }, 50);
      saveDebounced(neverPath, { herd: [{ id: "latest" }] }, 50);
      await vi.advanceTimersByTimeAsync(60);
      expect((written as { herd: Array<{ id: string }> }).herd[0]!.id).toBe("latest");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tickSaveDue — the cadence rule", () => {
  it("is due only when dirty, idle, and past the interval", () => {
    const interval = 15_000;
    const now = 100_000;
    // never saved: due the moment the town is dirty
    expect(tickSaveDue(0, now, true, false, interval)).toBe(true);
    // clean town: nothing to write, no ping
    expect(tickSaveDue(0, now, false, false, interval)).toBe(false);
    // inside the interval: wait
    expect(tickSaveDue(now - 1_000, now, true, false, interval)).toBe(false);
    // past the interval: due
    expect(tickSaveDue(now - interval, now, true, false, interval)).toBe(true);
    // a save still in flight: the next tick re-marks dirty instead
    expect(tickSaveDue(now - interval, now, true, true, interval)).toBe(false);
  });
});
