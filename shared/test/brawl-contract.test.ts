import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defaultConfig } from "../src/config.js";
import type { Caller, LedgerEntry, Leash, SettlementChain, TownConfig, TownSnapshot, Trade, Vault } from "../src/types.js";

// The BRAWL contract is additive by construction: four new optional arrays on
// TownSnapshot and one optional field on TownConfig. A town.json written before
// BRAWL existed has none of them, and it must still boot — so the compatibility
// gate below is the whole point of this file, not a formality.
//
// Runtime assertions use zod (already a shared dependency, and the repo's own
// boundary-validation pattern — backend/src/gateway.ts, backend/src/server.ts).
// Each schema is pinned to its interface with `satisfies`, so if a field is
// renamed in types.ts the schema stops compiling instead of drifting.

const leashSchema = z.object({
  perTrade: z.number(),
  daily: z.number(),
  sl: z.number(),
  tp: z.number(),
  share: z.number(),
}) satisfies z.ZodType<Leash>;

const vaultSchema = z.object({
  id: z.string(),
  keeperId: z.string(),
  agentId: z.string(),
  balance: z.number(),
  leash: leashSchema,
  paused: z.boolean(),
  createdAt: z.number(),
}) satisfies z.ZodType<Vault>;

const tradeSchema = z.object({
  id: z.string(),
  vaultId: z.string(),
  agentId: z.string(),
  callerId: z.string().optional(),
  size: z.number(),
  entryPrice: z.number(),
  exitPrice: z.number().optional(),
  pnl: z.number(),
  status: z.enum(["open", "closed", "rejected"]),
  reason: z.string().optional(),
  openedAt: z.number(),
  closedAt: z.number().optional(),
}) satisfies z.ZodType<Trade>;

const ledgerEntrySchema = z.object({
  tradeId: z.string(),
  agentId: z.string(),
  callerId: z.string().optional(),
  pnl: z.number(),
  callerPaid: z.number(),
  keeperPaid: z.number(),
  t: z.number(),
  txHash: z.string().optional(),
}) satisfies z.ZodType<LedgerEntry>;

const callerSchema = z.object({
  id: z.string(),
  residentId: z.string(),
  handle: z.string(),
  winRate: z.number(),
  totalPnl: z.number(),
  followers: z.array(z.string()),
}) satisfies z.ZodType<Caller>;

// The rail changed shape twice: on Robinhood Chain Testnet `chainId` and
// `faucetUrl` were required; on Solana there was no chain id and the chain was
// named by its genesis hash; on Elysium (EVM) the chain id is the identity
// again. Every field beyond the first four is optional, which is what lets a
// save written in any earlier era still boot.
const settlementChainSchema = z.object({
  name: z.string(),
  rpcUrl: z.string(),
  explorer: z.string(),
  nativeSymbol: z.string(),
  chainId: z.number().optional(),
  genesisHash: z.string().optional(),
  faucetUrl: z.string().optional(),
}) satisfies z.ZodType<SettlementChain>;

// Only the four BRAWL arrays are modelled; the town this mirrors is a real save,
// and every non-BRAWL field on it is untouched by this change.
const brawlSnapshotSchema = z.object({
  vaults: z.array(vaultSchema).optional(),
  trades: z.array(tradeSchema).optional(),
  ledger: z.array(ledgerEntrySchema).optional(),
  callers: z.array(callerSchema).optional(),
});

/** The four arrays TownSnapshot gained in 04 §4.2. */
const brawlFields = ["vaults", "trades", "ledger", "callers"] as const;

/** The pre-BRAWL save: the required fields and nothing else. */
const legacySnapshot = {
  now: 1_700_000_000_000,
  config: defaultConfig,
  herd: [],
  feed: [],
  events: [],
  editions: [],
  projects: [],
  factions: [],
  quests: [],
} satisfies TownSnapshot;

const leash: Leash = { perTrade: 0.1, daily: 0.5, sl: -20, tp: 40, share: 20 };

const vault: Vault = {
  id: "vault-1",
  keeperId: "resident-keeper",
  agentId: "resident-agent",
  balance: 2.5,
  leash,
  paused: false,
  createdAt: 1_700_000_000_000,
};

const trade: Trade = {
  id: "trade-1",
  vaultId: "vault-1",
  agentId: "resident-agent",
  callerId: "caller-1",
  size: 0.1,
  entryPrice: 1800,
  exitPrice: 2100,
  pnl: 0.0167,
  status: "closed",
  openedAt: 1_700_000_000_000,
  closedAt: 1_700_000_060_000,
};

const ledgerEntry: LedgerEntry = {
  tradeId: "trade-1",
  agentId: "resident-agent",
  callerId: "caller-1",
  pnl: 0.0167,
  callerPaid: 0.0033,
  keeperPaid: 0.0134,
  t: 1_700_000_060_000,
  txHash: "0xabc",
};

const caller: Caller = {
  id: "caller-1",
  residentId: "resident-caller",
  handle: "hawker",
  winRate: 0.62,
  totalPnl: 1.4,
  followers: ["resident-agent"],
};

const settlementChain: SettlementChain = {
  name: "Elysium Mainnet",
  rpcUrl: "https://rpc-live.boxa.club",
  explorer: "https://boxa.club/explorer",
  nativeSymbol: "HYPE",
};

/** A save written while the rail was still Robinhood Chain Testnet 46630. */
const legacyRobinhoodChain = {
  name: "Robinhood Chain Testnet",
  chainId: 46630,
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  faucetUrl: "https://faucet.testnet.chain.robinhood.com",
  nativeSymbol: "ETH",
} satisfies SettlementChain;

describe("legacy snapshots stay valid (compatibility gate)", () => {
  it("accepts a save written before any BRAWL field existed", () => {
    expect(brawlSnapshotSchema.safeParse(legacySnapshot).success).toBe(true);
  });

  it("carries none of the four new fields, and none of them are required", () => {
    expect(brawlSnapshotSchema.safeParse(legacySnapshot).data).not.toHaveProperty("vaults");
    // Absent, not empty: a save that never knew about vaults must not grow a
    // `vaults: []` out of a parse, or an old town would read as "zero vaults".
    for (const field of brawlFields) {
      expect(brawlSnapshotSchema.shape[field].isOptional()).toBe(true);
    }
    // and the direct statement of the same thing: an empty object parses.
    expect(brawlSnapshotSchema.safeParse({}).success).toBe(true);
  });

  it("still boots after JSON round-trip, which is how town.json is actually read", () => {
    const fromDisk = JSON.parse(JSON.stringify(legacySnapshot)) as unknown;
    expect(brawlSnapshotSchema.safeParse(fromDisk).success).toBe(true);
  });
});

describe("a snapshot carrying all four BRAWL arrays", () => {
  const full = {
    ...legacySnapshot,
    vaults: [vault],
    trades: [trade],
    ledger: [ledgerEntry],
    callers: [caller],
  } satisfies TownSnapshot;

  it("is valid", () => {
    expect(brawlSnapshotSchema.safeParse(full).success).toBe(true);
  });

  it("keeps the four arrays independently optional", () => {
    for (const field of brawlFields) {
      const partial = { ...legacySnapshot, [field]: [] };
      expect(brawlSnapshotSchema.safeParse(partial).success).toBe(true);
    }
  });

  it("preserves optional fields on the nested rows (callerId, txHash, exitPrice)", () => {
    const withoutOptionals = {
      ...legacySnapshot,
      trades: [{ ...trade, callerId: undefined, exitPrice: undefined, closedAt: undefined, reason: undefined }],
      ledger: [{ ...ledgerEntry, callerId: undefined, txHash: undefined }],
    };
    expect(brawlSnapshotSchema.safeParse(withoutOptionals).success).toBe(true);
  });
});

describe("a Vault missing required fields does not validate", () => {
  it("rejects a vault with no leash", () => {
    const { leash: _leash, ...withoutLeash } = vault;
    expect(vaultSchema.safeParse(withoutLeash).success).toBe(false);
  });

  it("rejects a vault with no keeperId", () => {
    const { keeperId: _keeperId, ...withoutKeeper } = vault;
    expect(vaultSchema.safeParse(withoutKeeper).success).toBe(false);
  });

  it("rejects a vault whose balance is a string", () => {
    expect(vaultSchema.safeParse({ ...vault, balance: "2.5" }).success).toBe(false);
  });

  it("rejects a vault whose leash is missing its stop loss", () => {
    const { sl: _sl, ...leashWithoutSl } = leash;
    expect(vaultSchema.safeParse({ ...vault, leash: leashWithoutSl }).success).toBe(false);
  });

  it("rejects the same hole one level up, on the snapshot", () => {
    const { leash: _leash, ...withoutLeash } = vault;
    const { vaults: _vaults, ...snapshotWithoutVaults } = {
      ...legacySnapshot,
      vaults: [vault],
    };
    expect(brawlSnapshotSchema.safeParse({ ...snapshotWithoutVaults, vaults: [withoutLeash] }).success).toBe(false);
  });

  it("rejects a trade whose status is outside the lifecycle", () => {
    expect(tradeSchema.safeParse({ ...trade, status: "settled" }).success).toBe(false);
  });

  it("accepts the valid vault, so the rejection above is about the hole and not the schema", () => {
    expect(vaultSchema.safeParse(vault).success).toBe(true);
  });
});

describe("SettlementChain", () => {
  it("validates the Solana mainnet values", () => {
    expect(settlementChainSchema.safeParse(settlementChain).success).toBe(true);
  });

  it("still validates a save written on the old Robinhood testnet rail", () => {
    // The whole point of making chainId and faucetUrl optional rather than
    // dropping them: a town that saved a settlement rail under 46630 has to
    // boot unchanged. This is the compatibility gate, in the one place where
    // the old shape is the thing under test.
    expect(settlementChainSchema.safeParse(legacyRobinhoodChain).success).toBe(true);
  });

  it("is a settlement rail beside the token chain, not a replacement for it", () => {
    // The settlement rail lives on config.settlementChain; the token chain keeps
    // its own chainName/network/rpcUrl/tokenAddress and defaultConfig sets neither.
    const withRail = { ...defaultConfig, settlementChain } satisfies TownConfig;
    expect(withRail.chainName).toBe(defaultConfig.chainName);
    expect(withRail.network).toBe(defaultConfig.network);
    expect(withRail.rpcUrl).toBe(defaultConfig.rpcUrl);
    expect(withRail.tokenAddress).toBe(defaultConfig.tokenAddress);
  });

  it("still type-checks chainId when an old save carries one", () => {
    // The number is meaningless on Solana, but a save may carry it, so it must
    // still be a number and not a string.
    expect(settlementChainSchema.safeParse({ ...settlementChain, chainId: 1 }).success).toBe(true);
    expect(settlementChainSchema.safeParse({ ...settlementChain, chainId: "46630" }).success).toBe(false);
  });

  it("needs no faucet on mainnet", () => {
    expect(settlementChainSchema.safeParse({ ...settlementChain, faucetUrl: undefined }).success).toBe(true);
  });
});

describe("TownConfig", () => {
  it("is valid without settlementChain", () => {
    expect("settlementChain" in defaultConfig).toBe(false);
  });

  it("is valid with settlementChain", () => {
    const withRail: TownConfig = { ...defaultConfig, settlementChain };
    expect(settlementChainSchema.safeParse(withRail.settlementChain).success).toBe(true);
  });

  it("still reports the same token chain with the rail attached", () => {
    const withRail: TownConfig = { ...defaultConfig, settlementChain };
    expect(withRail.chainName).toBe(defaultConfig.chainName);
    expect(withRail.tokenAddress).toBe(defaultConfig.tokenAddress);
  });

  it("still reports Elysium as the token chain (the §13 acceptance check)", () => {
    // Moved from Solana with the rail. The check itself did not change — it
    // still asserts that the token chain is on the expected chain, which is the
    // thing worth failing loudly if a rebrand or a default moves it.
    expect(defaultConfig.chainName).toBe("Elysium");
    expect(defaultConfig.network).toBe("mainnet");
    expect(defaultConfig.nativeSymbol).toBe("HYPE");
  });

  it("publishes no token address until a mint is really deployed", () => {
    // The address this used to carry was well-formed base58 that resolved to no
    // account on either chain. `tokenDeployed` is what stops the UI rendering
    // it again; the empty string means a new town never has one to show.
    expect(defaultConfig.tokenDeployed).toBe(false);
    expect(defaultConfig.tokenAddress).toBe("");
  });
});