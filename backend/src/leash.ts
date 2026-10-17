import type { Leash, Trade } from "@slopagentbook/shared";

// The leash is the validation engine BRAWL's promise rests on: a vault enforces
// a per-trade cap, a daily cap, and (on close) stop-loss/take-profit. It is a
// pure module — no clock, no world, no I/O — so the rules are unit-testable in
// isolation and the same check runs for a manual trade and a gateway trade.

export interface LeashCheckInput {
  leash: Leash;
  /** Requested trade size, in the rail's native symbol. */
  size: number;
  /** Native symbol already spent on OPEN trades by this vault today. */
  spentToday: number;
  /** True when the caller's token is paused (halt). */
  paused: boolean;
}

export interface LeashReject {
  ok: false;
  reason: string;
}

export interface LeashAllow {
  ok: true;
}

export type LeashCheck = LeashAllow | LeashReject;

/**
 * Guard rails on a leash config itself. A vault created with a nonsense leash
 * (negative caps, share above 100, SL that is positive) would enforce nothing,
 * so the config is validated at the boundary before it is ever stored.
 */
export function parseLeash(input: unknown): Leash {
  const src = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const leash: Leash = {
    perTrade: num(src.perTrade, 0.25),
    daily: num(src.daily, 1),
    sl: num(src.sl, -20),
    tp: num(src.tp, 40),
    share: num(src.share, 20),
  };
  if (leash.perTrade <= 0) throw new Error("perTrade must be > 0");
  if (leash.daily < leash.perTrade) throw new Error("daily cap must be >= perTrade");
  if (leash.sl >= 0) throw new Error("sl must be negative (a loss threshold)");
  if (leash.tp <= 0) throw new Error("tp must be positive (a profit target)");
  if (leash.share < 0 || leash.share > 100) throw new Error("share must be 0-100");
  return leash;
}

/** Evaluate whether a trade of `size` may open against this vault's leash. */
export function checkLeash(input: LeashCheckInput): LeashCheck {
  const { leash, size, spentToday, paused } = input;
  if (paused) return { ok: false, reason: "the vault is halted" };
  if (size <= 0) return { ok: false, reason: "size must be > 0" };
  if (size > leash.perTrade) {
    return { ok: false, reason: `size ${size} exceeds the per-trade cap ${leash.perTrade}` };
  }
  if (spentToday + size > leash.daily) {
    return { ok: false, reason: `would exceed the daily cap ${leash.daily} (spent ${spentToday})` };
  }
  return { ok: true };
}

export interface PnlResult {
  /** Signed PnL, in the rail's native symbol, after SL/TP cap. */
  pnl: number;
  /** The effective move %, after SL/TP cap (never beyond tp, never below sl). */
  cappedMovePct: number;
  /** Caller's share of a profit; always 0 on a loss. */
  callerPaid: number;
  /** Keeper's remainder. */
  keeperPaid: number;
}

/**
 * Close a trade: cap the raw move to [sl, tp], then split a profit between
 * caller and keeper by the leash share. A loss pays the caller nothing — that
 * is the whole point of pay-on-profit.
 *
 * `rawMovePct` is the token's actual move in percent (e.g. 60 for +60%).
 */
export function settle(trade: Trade, leash: Leash, rawMovePct: number): PnlResult {
  const capped = Math.max(leash.sl, Math.min(leash.tp, rawMovePct));
  const pnl = (capped / 100) * trade.size;
  const profitable = pnl > 0;
  const callerPaid = profitable ? (pnl * leash.share) / 100 : 0;
  const keeperPaid = pnl - callerPaid;
  return { pnl, cappedMovePct: capped, callerPaid, keeperPaid };
}
