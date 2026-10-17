import { randomBytes } from "node:crypto";
import type { Caller, LedgerEntry, Leash, Trade, Vault } from "@slopagentbook/shared";
import { parseLeash, checkLeash, settle, type LeashCheck } from "./leash.js";

// The BRAWL backend layer, layered onto the town snapshot. Everything here is
// additive: the four snapshot arrays stay optional, a save written before BRAWL
// boots without them, and nothing here removes an existing behavior.

function uid(prefix: string): string {
  return prefix + randomBytes(6).toString("hex");
}

/** Access the optional BRAWL arrays, creating them on first use. */
function vaults(world: { vaults?: Vault[] }): Vault[] {
  world.vaults ??= [];
  return world.vaults;
}
function trades(world: { trades?: Trade[] }): Trade[] {
  world.trades ??= [];
  return world.trades;
}
function ledger(world: { ledger?: LedgerEntry[] }): LedgerEntry[] {
  world.ledger ??= [];
  return world.ledger;
}
function callers(world: { callers?: Caller[] }): Caller[] {
  world.callers ??= [];
  return world.callers;
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export interface CreateVaultInput {
  keeperId: string;
  agentId: string;
  leash: unknown;
}

export class BrawlError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BrawlError";
    this.status = status;
  }
}

export function createVault(world: Parameters<typeof vaults>[0], input: CreateVaultInput): Vault {
  const leash = parseLeash(input.leash);
  if (!input.keeperId) throw new BrawlError("keeperId is required");
  if (!input.agentId) throw new BrawlError("agentId is required");
  const vault: Vault = {
    id: uid("vault_"),
    keeperId: input.keeperId,
    agentId: input.agentId,
    balance: 0,
    leash,
    paused: false,
    createdAt: Date.now(),
  };
  vaults(world).push(vault);
  return vault;
}

export function getVault(world: Parameters<typeof vaults>[0], id: string): Vault | undefined {
  return vaults(world).find((v) => v.id === id);
}

/** Native-symbol amount spent on OPEN trades for this vault since the start of the current UTC day. */
export function spentToday(world: Parameters<typeof trades>[0], vaultId: string, now = Date.now()): number {
  const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  return trades(world)
    .filter((t) => t.vaultId === vaultId && t.status === "open" && t.openedAt >= dayStart)
    .reduce((sum, t) => sum + t.size, 0);
}

export function fundVault(vault: Vault, amount: number): Vault {
  if (!(amount > 0)) throw new BrawlError("fund amount must be > 0");
  vault.balance += amount;
  return vault;
}

export function updateLeash(vault: Vault, next: unknown): Vault {
  vault.leash = parseLeash(next);
  return vault;
}

/** Kill switch. Blocks the agent; the keeper keeps the balance. */
export function haltVault(vault: Vault): Vault {
  vault.paused = true;
  return vault;
}

export function resumeVault(vault: Vault): Vault {
  vault.paused = false;
  return vault;
}

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

export interface OpenTradeInput {
  vaultId: string;
  agentId: string;
  callerId?: string;
  size: number;
  entryPrice: number;
}

export type OpenTradeResult =
  | { ok: true; trade: Trade }
  | { ok: false; reason: string };

export function openTrade(world: Parameters<typeof trades>[0] & Parameters<typeof vaults>[0], input: OpenTradeInput): OpenTradeResult {
  const vault = getVault(world, input.vaultId);
  if (!vault) throw new BrawlError("vault not found", 404);
  const check: LeashCheck = checkLeash({
    leash: vault.leash,
    size: input.size,
    spentToday: spentToday(world, vault.id),
    paused: vault.paused,
  });
  if (!check.ok) {
    // A rejected trade is still recorded, with its reason — the ledger's whole
    // value is that it shows what was refused, not just what succeeded.
    const rejected: Trade = {
      id: uid("trade_"),
      vaultId: vault.id,
      agentId: input.agentId,
      callerId: input.callerId,
      size: input.size,
      entryPrice: input.entryPrice,
      pnl: 0,
      status: "rejected",
      reason: check.reason,
      openedAt: Date.now(),
    };
    trades(world).push(rejected);
    return { ok: false, reason: check.reason };
  }
  if (input.size > vault.balance) {
    const rejected: Trade = { ...mkTrade(input), status: "rejected", reason: "size exceeds the vault balance" };
    trades(world).push(rejected);
    return { ok: false, reason: "size exceeds the vault balance" };
  }
  const trade = mkTrade(input);
  trade.status = "open";
  vault.balance -= input.size;
  trades(world).push(trade);
  return { ok: true, trade };
}

function mkTrade(input: OpenTradeInput): Trade {
  return {
    id: uid("trade_"),
    vaultId: input.vaultId,
    agentId: input.agentId,
    callerId: input.callerId,
    size: input.size,
    entryPrice: input.entryPrice,
    pnl: 0,
    status: "open",
    openedAt: Date.now(),
  };
}

export interface CloseTradeResult {
  trade: Trade;
  entry: LedgerEntry;
  vault: Vault;
}

export function closeTrade(
  world: Parameters<typeof trades>[0] & Parameters<typeof vaults>[0] & Parameters<typeof ledger>[0],
  tradeId: string,
  rawMovePct: number,
): CloseTradeResult {
  const trade = trades(world).find((t) => t.id === tradeId);
  if (!trade) throw new BrawlError("trade not found", 404);
  if (trade.status !== "open") throw new BrawlError("trade is not open");
  const vault = getVault(world, trade.vaultId);
  if (!vault) throw new BrawlError("vault not found", 404);

  const { pnl, callerPaid, keeperPaid } = settle(trade, vault.leash, rawMovePct);
  trade.status = "closed";
  trade.exitPrice = trade.entryPrice * (1 + rawMovePct / 100);
  trade.pnl = pnl;
  trade.closedAt = Date.now();

  vault.balance += trade.size + keeperPaid; // principal + keeper's net share; callerPaid is paid out of pnl

  const entry: LedgerEntry = {
    tradeId: trade.id,
    agentId: trade.agentId,
    callerId: trade.callerId,
    pnl,
    callerPaid,
    keeperPaid,
    t: Date.now(),
  };
  ledger(world).push(entry);
  return { trade, entry, vault };
}

// ---------------------------------------------------------------------------
// Caller registry + hiscores
// ---------------------------------------------------------------------------

export function registerCaller(world: Parameters<typeof callers>[0], residentId: string, handle: string): Caller {
  if (callers(world).some((c) => c.residentId === residentId)) {
    throw new BrawlError("caller already registered");
  }
  const caller: Caller = { id: uid("caller_"), residentId, handle, winRate: 0, totalPnl: 0, followers: [] };
  callers(world).push(caller);
  return caller;
}

export function followCaller(world: Parameters<typeof callers>[0], callerId: string, followerId: string): Caller {
  const caller = callers(world).find((c) => c.id === callerId);
  if (!caller) throw new BrawlError("caller not found", 404);
  if (!caller.followers.includes(followerId)) caller.followers.push(followerId);
  return caller;
}

/**
 * Recompute each caller's stats from the ledger. winRate and totalPnl are
 * derived, never stored independently, so they cannot drift from the rows they
 * summarize.
 */
export function refreshCallerStats(
  world: Parameters<typeof callers>[0] & Parameters<typeof ledger>[0],
): void {
  for (const caller of callers(world)) {
    const rows = ledger(world).filter((e) => e.callerId === caller.id);
    const wins = rows.filter((e) => e.pnl > 0).length;
    caller.winRate = rows.length ? wins / rows.length : 0;
    caller.totalPnl = rows.reduce((s, e) => s + e.pnl, 0);
  }
}

export interface HiscoresRow {
  agentId: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
}

/** The Roll of Honour: per-agent aggregates over closed trades, best PnL first. */
export function hiscores(world: Parameters<typeof ledger>[0]): HiscoresRow[] {
  const byAgent = new Map<string, HiscoresRow>();
  for (const e of ledger(world)) {
    const row = byAgent.get(e.agentId) ?? { agentId: e.agentId, trades: 0, wins: 0, winRate: 0, totalPnl: 0 };
    row.trades += 1;
    if (e.pnl > 0) row.wins += 1;
    row.totalPnl += e.pnl;
    row.winRate = row.wins / row.trades;
    byAgent.set(e.agentId, row);
  }
  return [...byAgent.values()].sort((a, b) => b.totalPnl - a.totalPnl);
}
