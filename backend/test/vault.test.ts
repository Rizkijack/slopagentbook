import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createVault, getVault, fundVault, haltVault, resumeVault, openTrade, closeTrade,
  spentToday, registerCaller, followCaller, refreshCallerStats, hiscores, updateLeash, BrawlError,
} from "../src/vault.js";

// The vault layer, tested against a minimal in-memory world. These are the
// end-to-end money rules: caps hold, halt holds, and the ledger records what
// was refused — not only what succeeded.

function world() {
  return {} as Parameters<typeof createVault>[0] & Parameters<typeof openTrade>[0] & Parameters<typeof ledgerAccess>[0];
}

// helper kept tiny on purpose: the vault module writes the optional arrays itself
function ledgerAccess(_w: unknown) {}

describe("vault lifecycle", () => {
  it("creates a vault with a validated leash", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: {} });
    expect(v.balance).toBe(0);
    expect(v.paused).toBe(false);
    expect(getVault(w, v.id)).toBe(v);
  });

  it("refuses a leash that would enforce nothing", () => {
    const w = world();
    expect(() => createVault(w, { keeperId: "k", agentId: "a", leash: { perTrade: 0 } })).toThrow();
  });

  it("funds and spends from the balance", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: {} });
    fundVault(v, 1);
    expect(v.balance).toBe(1);
    const r = openTrade(w, { vaultId: v.id, agentId: "a", size: 0.25, entryPrice: 100 });
    expect(r.ok).toBe(true);
    expect(v.balance).toBeCloseTo(0.75);
  });

  it("rejects a fund that is not positive", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: {} });
    expect(() => fundVault(v, 0)).toThrow(BrawlError);
  });

  it("halts and resumes", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: {} });
    fundVault(v, 1);
    haltVault(v);
    expect(openTrade(w, { vaultId: v.id, agentId: "a", size: 0.1, entryPrice: 1 }).ok).toBe(false);
    resumeVault(v);
    expect(openTrade(w, { vaultId: v.id, agentId: "a", size: 0.1, entryPrice: 1 }).ok).toBe(true);
  });
});

describe("trading", () => {
  it("records a rejected trade with its reason", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: { perTrade: 0.25, daily: 1 } });
    fundVault(v, 1);
    const r = openTrade(w, { vaultId: v.id, agentId: "a", size: 2, entryPrice: 1 });
    expect(r.ok).toBe(false);
    // the refusal is on the ledger, not just in the response
    expect((w as { trades?: { status: string; reason?: string }[] }).trades?.[0]?.status).toBe("rejected");
    expect((w as { trades?: { status: string; reason?: string }[] }).trades?.[0]?.reason).toMatch(/per-trade/);
  });

  it("refuses a trade larger than the vault balance", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: {} });
    fundVault(v, 0.1);
    expect(openTrade(w, { vaultId: v.id, agentId: "a", size: 1, entryPrice: 1 }).ok).toBe(false);
  });

  it("closes a profitable trade, pays the caller, and returns principal + keeper share to the vault", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: { perTrade: 1, daily: 5, sl: -20, tp: 40, share: 20 } });
    fundVault(v, 1);
    const opened = openTrade(w, { vaultId: v.id, agentId: "a", size: 1, entryPrice: 100 });
    expect(opened.ok).toBe(true);
    const result = closeTrade(w, opened.ok ? opened.trade.id : "", 40);
    expect(result.trade.status).toBe("closed");
    expect(result.trade.pnl).toBeCloseTo(0.4);
    // ledger keeps the whole pnl split so the caller's entitlement is on the record
    expect(result.entry.callerPaid).toBeCloseTo(0.08);
    expect(result.entry.keeperPaid).toBeCloseTo(0.32);
    // fund 1 - open 1 = 0, then principal 1 + keeper share 0.32 = 1.32. Crediting
    // the full 0.4 would double-count callerPaid, which the ledger already owes.
    expect(v.balance).toBeCloseTo(1.32);
  });

  it("refuses to close a trade twice", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: { perTrade: 1, daily: 1 } });
    fundVault(v, 1);
    const opened = openTrade(w, { vaultId: v.id, agentId: "a", size: 0.5, entryPrice: 1 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    closeTrade(w, opened.trade.id, 10);
    expect(() => closeTrade(w, opened.trade.id, 10)).toThrow(BrawlError);
  });

  it("counts only open trades against the daily cap", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: { perTrade: 0.25, daily: 0.5 } });
    fundVault(w === null ? v : v, 2);
    const a = openTrade(w, { vaultId: v.id, agentId: "a", size: 0.25, entryPrice: 1 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(spentToday(w, v.id)).toBeCloseTo(0.25);
    closeTrade(w, a.trade.id, 10);
    expect(spentToday(w, v.id)).toBe(0);
  });
});

describe("callers and hiscores", () => {
  it("registers a caller once", () => {
    const w = world();
    registerCaller(w, "r1", "@r1");
    expect(() => registerCaller(w, "r1", "@r1")).toThrow(BrawlError);
  });

  it("tracks followers without duplicates", () => {
    const w = world();
    const c = registerCaller(w, "r1", "@r1");
    followCaller(w, c.id, "r2");
    followCaller(w, c.id, "r2");
    expect(c.followers).toEqual(["r2"]);
  });

  it("derives winRate and totalPnl from the ledger, so they cannot drift", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: { perTrade: 1, daily: 10, sl: -20, tp: 40, share: 20 } });
    const c = registerCaller(w, "r1", "@r1");
    fundVault(v, 5);
    // one win, one loss
    const win = openTrade(w, { vaultId: v.id, agentId: "a", callerId: c.id, size: 1, entryPrice: 100 });
    if (win.ok) closeTrade(w, win.trade.id, 40);
    const loss = openTrade(w, { vaultId: v.id, agentId: "a", callerId: c.id, size: 1, entryPrice: 100 });
    if (loss.ok) closeTrade(w, loss.trade.id, -80);
    refreshCallerStats(w);
    expect(c.trades_or_stats).toBeUndefined();
    expect(c.winRate).toBeCloseTo(0.5);
    expect(c.totalPnl).toBeCloseTo(0.2); // +0.4 capped, -0.2 floored
    const board = hiscores(w);
    expect(board[0]?.agentId).toBe("a");
    expect(board[0]?.trades).toBe(2);
    expect(board[0]?.wins).toBe(1);
  });
});

// The merge in pgstore.ts orders two versions of one money record by updatedAt.
// Without these stamps the whole rule is inert — a vault with no updatedAt on
// either side always loses to the writer, which is the bug that lost production
// funding. Every mutation therefore has to move the stamp, or be a deliberate
// exception. `vi.setSystemTime` keeps them exactly ordered instead of racing the
// 1ms clock resolution.
describe("updatedAt — the merge key for money", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const step = (ms: number) => vi.setSystemTime(ms);

  it("stamps a vault on create, then on fund, open and close — monotonically", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: {} });
    expect(v.updatedAt).toBe(1_000);

    step(2_000);
    fundVault(v, 1);
    expect(v.updatedAt).toBe(2_000);

    step(3_000);
    const opened = openTrade(w, { vaultId: v.id, agentId: "a", size: 0.25, entryPrice: 100 });
    expect(opened.ok).toBe(true);
    expect(v.updatedAt).toBe(3_000); // the debit is a money mutation
    if (opened.ok) expect(opened.trade.updatedAt).toBe(3_000);

    step(4_000);
    if (opened.ok) closeTrade(w, opened.trade.id, 40);
    expect(v.updatedAt).toBe(4_000); // the credit is too
    if (opened.ok) expect(opened.trade.updatedAt).toBe(4_000);
  });

  it("stamps on a leash change, a halt and a resume", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: {} });

    step(2_000);
    updateLeash(v, { perTrade: 0.5 });
    expect(v.updatedAt).toBe(2_000);

    step(3_000);
    haltVault(v);
    expect(v.updatedAt).toBe(3_000);

    step(4_000);
    resumeVault(v);
    expect(v.updatedAt).toBe(4_000);
  });

  it("stamps a trade rejected by the leash", () => {
    const w = world();
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: {} });
    step(2_000);

    // too large for the per-trade cap, so it never debits the vault
    const rejected = openTrade(w, { vaultId: v.id, agentId: "a", size: 99, entryPrice: 100 });
    expect(rejected.ok).toBe(false);
    expect((w.trades as Array<{ updatedAt?: number }>)[0]!.updatedAt).toBe(2_000);
    expect(v.updatedAt).toBe(1_000); // no money moved, so the vault is untouched
  });

  it("stamps a caller on register and on follow, but not on a repeat follow", () => {
    const w = world() as Parameters<typeof registerCaller>[0];
    step(2_000);
    const c = registerCaller(w, "r1", "@r1");
    expect(c.updatedAt).toBe(2_000);

    step(3_000);
    followCaller(w, c.id, "r2");
    expect(c.updatedAt).toBe(3_000);

    // already a follower: nothing changed, so nothing should claim recency
    step(4_000);
    followCaller(w, c.id, "r2");
    expect(c.updatedAt).toBe(3_000);
  });

  it("does NOT stamp refreshCallerStats when no stat moved", () => {
    const w = world() as Parameters<typeof registerCaller>[0];
    step(2_000);
    const c = registerCaller(w, "r1", "@r1");
    step(5_000);

    refreshCallerStats(w);

    // this runs on a PUBLIC GET. Stamping unconditionally would let a stale
    // instance claim recency just by recomputing.
    expect(c.updatedAt).toBe(2_000);
  });

  it("stamps refreshCallerStats when a stat actually moves", () => {
    // typed once here rather than cast per call: this test touches every array,
    // and the file's `world()` helper only declares vaults + trades
    const w = world() as unknown as Parameters<typeof createVault>[0]
      & Parameters<typeof openTrade>[0]
      & Parameters<typeof registerCaller>[0]
      & Parameters<typeof refreshCallerStats>[0];
    const v = createVault(w, { keeperId: "k", agentId: "a", leash: {} });
    const c = registerCaller(w, "r1", "@r1");
    fundVault(v, 1);
    // 0.2, not 0.5: the default leash caps a trade at 0.25 and a rejected open
    // never reaches closeTrade, so it would produce no ledger row to summarise
    const opened = openTrade(w, { vaultId: v.id, agentId: "a", callerId: c.id, size: 0.2, entryPrice: 100 });
    expect(opened.ok).toBe(true);
    if (opened.ok) closeTrade(w, opened.trade.id, 40);
    step(6_000);

    refreshCallerStats(w);

    expect(c.totalPnl).not.toBe(0);
    expect(c.updatedAt).toBe(6_000);
  });
});
