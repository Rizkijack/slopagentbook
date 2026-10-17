import { describe, it, expect } from "vitest";
import { parseLeash, checkLeash, settle } from "../src/leash.js";

// The leash is the promise BRAWL makes: a vault cannot leak past a cap, a
// profit is split, a loss costs the caller nothing. These are pure rules, so
// they are tested directly, with no server or world in the way.

describe("parseLeash", () => {
  it("applies defaults when the config is partial", () => {
    const leash = parseLeash({});
    expect(leash).toEqual({ perTrade: 0.25, daily: 1, sl: -20, tp: 40, share: 20 });
  });

  it("rejects a non-positive per-trade cap", () => {
    expect(() => parseLeash({ perTrade: 0 })).toThrow();
    expect(() => parseLeash({ perTrade: -1 })).toThrow();
  });

  it("rejects a daily cap below the per-trade cap", () => {
    // A daily cap below one allowed trade means every trade is rejected — the
    // vault would be permanently unusable, so refuse to create it.
    expect(() => parseLeash({ perTrade: 2, daily: 1 })).toThrow();
  });

  it("rejects a non-negative stop-loss and a non-positive take-profit", () => {
    expect(() => parseLeash({ sl: 0 })).toThrow();
    expect(() => parseLeash({ sl: 5 })).toThrow();
    expect(() => parseLeash({ tp: 0 })).toThrow();
  });

  it("rejects a share outside 0-100", () => {
    expect(() => parseLeash({ share: -1 })).toThrow();
    expect(() => parseLeash({ share: 101 })).toThrow();
  });
});

describe("checkLeash", () => {
  const leash = parseLeash({ perTrade: 0.25, daily: 1, sl: -20, tp: 40, share: 20 });

  it("allows a trade within every cap", () => {
    expect(checkLeash({ leash, size: 0.25, spentToday: 0, paused: false })).toEqual({ ok: true });
  });

  it("rejects a trade above the per-trade cap", () => {
    const r = checkLeash({ leash, size: 0.5, spentToday: 0, paused: false });
    expect(r.ok).toBe(false);
  });

  it("rejects a trade that would exceed the daily cap", () => {
    const r = checkLeash({ leash, size: 0.25, spentToday: 0.9, paused: false });
    expect(r.ok).toBe(false);
  });

  it("rejects everything while the vault is halted", () => {
    expect(checkLeash({ leash, size: 0.01, spentToday: 0, paused: true }).ok).toBe(false);
  });

  it("rejects a non-positive size", () => {
    expect(checkLeash({ leash, size: 0, spentToday: 0, paused: false }).ok).toBe(false);
  });
});

describe("settle", () => {
  const leash = parseLeash({ perTrade: 1, daily: 2, sl: -20, tp: 40, share: 20 });
  const trade = { id: "t1", vaultId: "v1", agentId: "a1", size: 1, entryPrice: 100, pnl: 0, status: "open" as const, openedAt: 0 };

  it("caps the move at take-profit and pays the caller their share", () => {
    // `size` is denominated in whatever unit the settlement rail calls native —
    // settle() is percentage math and is never told the chain, so naming a symbol
    // here would assert something the function never received. `perTrade: 1` is
    // one unit of it, whatever that is.
    // +60% raw would be +0.6 of that unit, but tp is 40 — the caller gets 20% of 0.4.
    const r = settle(trade, leash, 60);
    expect(r.cappedMovePct).toBe(40);
    expect(r.pnl).toBeCloseTo(0.4);
    expect(r.callerPaid).toBeCloseTo(0.08);
    expect(r.keeperPaid).toBeCloseTo(0.32);
  });

  it("floors the move at stop-loss and pays the caller nothing", () => {
    const r = settle(trade, leash, -80);
    expect(r.cappedMovePct).toBe(-20);
    expect(r.pnl).toBeCloseTo(-0.2);
    expect(r.callerPaid).toBe(0);
    expect(r.keeperPaid).toBeCloseTo(-0.2);
  });

  it("passes a move inside the band through unchanged", () => {
    const r = settle(trade, leash, 25);
    expect(r.cappedMovePct).toBe(25);
    expect(r.pnl).toBeCloseTo(0.25);
    expect(r.callerPaid).toBeCloseTo(0.05);
  });
});
