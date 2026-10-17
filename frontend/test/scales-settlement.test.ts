import { describe, it, expect } from "vitest";
import { settleScale } from "../src/components/ScalesCalculator.js";
import type { Leash } from "@slopagentbook/shared";

// Blueprint §8, pinned from the UI side. backend/src/leash.ts computes the same
// four numbers for the real rail, so if either side changes the rule alone the
// calculator on the page starts promising something the server will not do.
// The worked example is quoted from the blueprint itself.

const LEASH: Leash = { perTrade: 0.25, daily: 1, sl: -20, tp: 40, share: 20 };

describe("settleScale — blueprint §8", () => {
  it("matches the blueprint's worked example exactly", () => {
    // size 0.25, token +60%, tp +40% -> capped at 40 -> PnL 0.10,
    // share 20% -> caller 0.02, keeper 0.08.
    const r = settleScale(LEASH, 0.25, 60);
    expect(r.capped).toBe(40);
    expect(r.pnl).toBeCloseTo(0.1, 10);
    expect(r.callerPaid).toBeCloseTo(0.02, 10);
    expect(r.keeperPaid).toBeCloseTo(0.08, 10);
  });

  it("clamps the move up to the stop loss instead of running deeper", () => {
    const r = settleScale(LEASH, 0.25, -80);
    expect(r.capped).toBe(-20);
    expect(r.pnl).toBeCloseTo(-0.05, 10);
  });

  it("pays the caller nothing on a loss — the keeper carries the whole thing", () => {
    const r = settleScale(LEASH, 0.5, -10);
    expect(r.pnl).toBeLessThan(0);
    expect(r.callerPaid).toBe(0);
    expect(r.keeperPaid).toBe(r.pnl);
  });

  it("pays the caller nothing when the move lands exactly on the floor", () => {
    const r = settleScale(LEASH, 0.5, -200);
    expect(r.capped).toBe(-20);
    expect(r.callerPaid).toBe(0);
  });

  it("never splits more than the pnl it was split from", () => {
    for (const move of [-50, -20, -1, 0, 1, 20, 40, 60, 200]) {
      const r = settleScale(LEASH, 0.3, move);
      expect(r.callerPaid + r.keeperPaid).toBeCloseTo(r.pnl, 12);
    }
  });

  it("gives the caller nothing on a flat move", () => {
    const r = settleScale(LEASH, 0.3, 0);
    expect(r.pnl).toBe(0);
    expect(r.callerPaid).toBe(0);
    expect(r.keeperPaid).toBe(0);
  });
});
