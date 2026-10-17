export interface Resident {
  id: string;
  name: string;
  handle: string;
  genes: string;
  job: string;
  bio: string;
  traits: string[];
  /**
   * Profile presentation, owned by the resident's token holder. Both are
   * optional so a snapshot written before they existed still loads and still
   * typechecks — and so `avatar` reads as "absent -> render a generated one"
   * rather than as an empty string. Validated at the boundary
   * (`backend/src/agents.ts`): the server stores the string and never fetches it.
   */
  /** Absolute `http(s)` URL of a custom avatar. Absent → render a generated one. */
  avatar?: string;
  /** External links, in the owner's order. Max 5 enforced at the boundary. */
  links?: { label: string; url: string }[];
  gen: number;
  parent?: string;
  forks: number;
  born: number;
  needs: {
    hunger: number;
    thirst: number;
    tired: number;
    lonely: number;
  };
  mind: {
    doing: {
      act: string;
      place: string;
      placeName: string;
      since: number;
      why: string;
      /**
       * Id of the npc-agent skill rule that produced this decision
       * (skills/npc-agent, machine-readable source: shared/src/skills.ts).
       * Optional so snapshots written before the skill existed still load.
       */
      skill?: string;
    };
    spirits: number;
    obsession: string;
    memories: string[];
    relationships: Record<string, number>;
    /** who drives this resident: internal sim scheduler (default/absent) or an external agent gateway */
    control?: "sim" | "external";
  };
}

/** Registry entry for an external agent joined via the gateway. Only the sha256 hash of the token is stored. */
export interface AgentRecord {
  id: string;
  residentId: string;
  tokenHash: string;
  /**
   * The human account that registered/operates this agent (registration page,
   * `#/register`). Optional: records written before the page existed have none,
   * and `GET /api/snapshot` redacts the whole registry anyway.
   */
  owner?: {
    name: string;
    handle: string;
  };
  origin: string;
  joinedAt: number;
  lastActAt: number;
}

export interface Post {
  id: string;
  t: number;
  by: string;
  name: string;
  handle: string;
  text: string;
  kind: "post" | "reply" | "spit";
  replyTo: string | null;
}

export interface TownEvent {
  t: number;
  kind: string;
  text: string;
}

export interface Edition {
  no: number;
  t: number;
  headline: string;
  standfirst: string;
  stories: { head: string; text: string }[];
  weather: string;
  quote: { who: string; text: string };
}

export interface Project {
  id: string;
  name: string;
  purpose: string;
  progress: number;
  sponsors: string[];
}

export interface Faction {
  id: string;
  name: string;
  cause: string;
  members: string[];
  influence: number;
}

export type QuestType =
  | "visit"
  | "talk"
  | "fetch"
  | "work"
  | "explore"
  | "social"
  // V7 (§7): the ACTION axis — a second axis beside the location one. These
  // advance by what the keeper DID, not by where a resident stands.
  | "configure"
  | "follow"
  | "record";

/**
 * Runtime mirror of the `QuestType` union above — the union and this array are
 * one table (AGENTS.md: "one table, read from its source"), which is why the
 * array lives here next to the type instead of being re-listed in whatever
 * validator needs it. `satisfies readonly QuestType[]` makes a member that is
 * in the array but not the union a compile error; a member missing from the
 * array still type-checks, so keep them in step by hand when adding a type.
 */
export const QUEST_TYPES = [
  "visit",
  "talk",
  "fetch",
  "work",
  "explore",
  "social",
  "configure",
  "follow",
  "record",
] as const satisfies readonly QuestType[];

export type QuestStatus = "available" | "active" | "completed" | "claimed";
export type QuestDifficulty = "easy" | "medium" | "hard";

export interface Quest {
  id: string;
  title: string;
  description: string;
  giver: string; // resident id or "board"
  giverName: string;
  type: QuestType;
  category: string; // Daily, Work, Social, Exploration
  targetPlace?: string;
  targetPlaces?: string[];
  progress: number;
  required: number;
  reward: { spirits?: number; text: string; progressBonus?: number };
  status: QuestStatus;
  /**
   * The resident working this quest — not the quest's giver, who only posted it.
   *
   * Set in two places, and they mean different stages. `claimQuestFor` sets it
   * when a worker takes an `available` quest to work on; from then on only that
   * worker's actions advance it (the gate at the top of `updateQuestProgress`).
   * `claimQuest` sets it at payout, when the resident who actually finished is
   * known. Before this field existed it was written only at payout, which is why
   * the doc used to read "who took the reward".
   *
   * Optional on purpose: saves written before quests were claimable, and quests
   * finished through the unauthenticated public route with no session, have
   * none. An unclaimed quest still auto-activates on first progress exactly as
   * it always did, so a legacy save with no `claimedBy` keeps playing.
   *
   * Setting it early does not inflate the leaderboard. `questPointsBy`
   * (frontend/src/views/leaderboard.ts) counts a quest only when its status is
   * `claimed`, and a quest still being worked is `active` — so an in-progress
   * `claimedBy` is excluded, and only becomes countable once the same quest id
   * is paid out through `claimQuest`.
   */
  claimedBy?: string;
  /**
   * When the quest was taken on, in `Date.now()` epoch ms — written by
   * `claimQuestFor`, alongside `claimedBy`. Optional for the same reason:
   * saves predating either field must still parse.
   */
  claimedAt?: number;
  difficulty: QuestDifficulty;
  createdAt: number;
  expiresAt: number | null;
  completedAt?: number;
}

/**
 * Hermes Trials — one contest objective (08 §4.2).
 *
 * Every kind resolves from data the sim already produces; none of them
 * require the outcome layer that `win_argument` would need (08 §3).
 */
export type ContestKind = "gather_at" | "hold_ground" | "tend_project" | "endure";

/** Lifecycle: announced → live → resolved (08 §10.1). */
export type ContestState = "announced" | "live" | "resolved";

/**
 * One row per contestant per live tick — the evidence trail (08 §4.1).
 *
 * `place` is `mind.doing.place`, so a contestant that stopped being simulated
 * simply stops producing samples and is judged on what it did show up for.
 * A contestant with no samples at all does not count as standing.
 */
export interface ContestSample {
  /** wall-clock ms of the tick that produced this row */
  t: number;
  agentId: string;
  place: string;
  spirits: number;
  /** this contestant was hit by a spit during this tick (drives `endure`) */
  wasSpit: boolean;
}

export interface ContestStanding {
  /** resident id of the contestant */
  agentId: string;
  /** rank points: 1st 10, 2nd 5, 3rd 1, rest 0 (08 §4.3). 0 when void. */
  score: number;
  /** 1-based; kept even when the result is void, because that is what the win
   * is narrated from ("won by forfeit") — only the points are zeroed. */
  rank: number;
  /** objective-specific metric, higher is better */
  metric: number;
  /** human-readable evidence, rendered by the HUD and the Daily Spit */
  detail: string;
}

export interface ContestResult {
  standings: ContestStanding[];
  /**
   * True when a single contestant (or none) was still standing at the end —
   * the win is narrated but awards no season points (D7, 08 §4.3).
   */
  voidResult: boolean;
  resolvedAt: number;
}

export interface Contest {
  id: string;
  kind: ContestKind;
  /** headline; always "THE HALL ARGUMENT" in v1 — see 08 §3 */
  title: string;
  /** target location id for `gather_at` / `hold_ground` / `tend_project` */
  place: string;
  startsAt: number;
  endsAt: number;
  state: ContestState;
  /** contestant resident ids — external agents only (D1); never residents. */
  entrants: string[];
  /** the single house agent in this contest, if any (D8: at most one) */
  houseEntrant?: string;
  /** capped evidence trail (08 §11: trimmed on persist) */
  samples: ContestSample[];
  result?: ContestResult;
  /** matchup framing derived from relationships (08 §7.1). Cosmetic only. */
  narration: string;
}

export interface SeasonStanding {
  agentId: string;
  points: number;
  wins: number;
  losses: number;
}

export interface Season {
  id: string;
  /** 1-based season number; the unit of the return cadence (08 §6) */
  no: number;
  startedAt: number;
  /** trials (10 days) → semifinals (top 4) → final → champion (08 §5) */
  state: "trials" | "semifinals" | "final" | "closed";
  standings: SeasonStanding[];
  champion?: string;
  /**
   * Contest ids already folded into `standings`.
   *
   * Optional because older saves predate it, but it MUST live on the object
   * rather than in a module-level cache: the case idempotency exists for is a
   * restart, and that is exactly when an in-process cache is empty. The save
   * is written wholesale, so a property on the season survives the round trip.
   */
  appliedContests?: string[];
}

export interface TownSnapshot {
  now: number;
  config: TownConfig;
  herd: Resident[];
  feed: Post[];
  events: TownEvent[];
  editions: Edition[];
  projects: Project[];
  factions: Faction[];
  quests: Quest[];
  /** external agent registry (optional — older saves without it stay valid) */
  agents?: AgentRecord[];
  /**
   * Residents deliberately removed from the town. Optional: saves written
   * before deletion existed have none.
   *
   * The town otherwise only ever grows. `mergeSnapshots` unions the herd so two
   * Vercel instances saving at once cannot lose each other's residents, and the
   * agent registry explicitly never shrinks because the token hash is the only
   * credential an owner holds. A deletion therefore has nowhere to live: drop
   * the resident from the stored row and the next save from an instance still
   * holding it in memory merges it straight back.
   *
   * A tombstone is the removal's own durable, mergeable record. Tombstones are
   * unioned like every other list and each union filters them out, so a deletion
   * survives concurrent writers instead of racing them.
   */
  tombstones?: ResidentTombstone[];
  /**
   * Hermes Trials contests (08 §11). Optional — older saves have none and
   * the contest HUD must stay unmounted rather than guess at an empty state.
   */
  contests?: Contest[];
  /** current tournament season standings (08 §5) */
  season?: Season;
  /**
   * Keeper vaults (04 §4.2). Optional — a save written before the leash existed
   * carries none, and the field stays optional so that save still boots.
   */
  vaults?: Vault[];
  /** Trade lifecycle rows (04 §4.2). Optional — same reason as `vaults`. */
  trades?: Trade[];
  /** Append-only ledger, one row per closed trade (04 §4.2). Optional. */
  ledger?: LedgerEntry[];
  /** Caller registry (04 §4.2). Optional — the payout rail is optional too. */
  callers?: Caller[];
}

/**
 * A record that a resident was removed from the town on purpose.
 *
 * `id` is the resident id. `agentIds` lists the registry entries to drop too —
 * kept alongside so a merge can retire the credential even when the registry row
 * it refers to is not in the snapshot being merged.
 */
export interface ResidentTombstone {
  id: string;
  /** why it was removed, for the audit trail — never shown to players */
  reason: string;
  /** ms epoch */
  at: number;
  /** agent registry ids that belonged to this resident */
  agentIds?: string[];
}

export interface TownConfig {
  name: string;
  ticker: string;
  /**
   * The `$ticker` mint address. NOT the treasury.
   *
   * This field is about the token, and only the token: whether a mint exists and
   * where. Empty while none is deployed, gated on `tokenDeployed` in the UI, and
   * never rewritten by any boot reconciliation because whatever an operator puts
   * here points at whatever it points at.
   */
  tokenAddress: string;
  /**
   * The address the town's own funds sit in, on `settlementChain` /
   * `nativeSymbol`. A distinct field from `tokenAddress` because it is a
   * different claim: the treasury address may be a real, funded account while
   * no mint exists at all.
   *
   * Optional and additive, per the snapshot rule in AGENTS.md — a save written
   * before it existed loads without it and simply shows the honest "not stated"
   * rather than guessing an address. Reconciled at boot from `defaultConfig`
   * only when the key is absent entirely, which is the signature of a save that
   * predates the field rather than of an operator who blanked it on purpose.
   */
  treasuryAddress?: string;
  chainName: string;
  network: string;
  rpcUrl: string;
  explorer: string;
  dexUrl: string;
  xUrl: string;
  /**
   * The chain's own gas/settlement symbol, "SOL".
   *
   * This existed as a `chainName === "Base" ? "ETH" : "SOL"` ternary in
   * CoinView, which is the copy-of-a-value mistake in its smallest form: the
   * answer lives in the config beside everything else that describes the chain.
   * Optional, so a save without it still loads.
   */
  nativeSymbol?: string;
  brain: "llm" | "sim";
  forkCost: string;
  maxHerd: number;
  /**
   * Whether `tokenAddress` is a real deployed mint.
   *
   * The address this project shipped with was well-formed base58 but pointed at
   * no account on either chain — it was a placeholder. `defaultConfig` is "a
   * default, never a migration", so a running town keeps whatever its save
   * carries and no config change can retroactively blank it. The flag is what
   * stops the UI showing an address that resolves to nothing: CoinView renders
   * the status, and only renders the address when this is true.
   *
   * Optional, defaulting to absent, which reads as false.
   */
  tokenDeployed?: boolean;
  /**
   * The BRAWL settlement rail (04 §4.2), living ALONGSIDE the token chain above
   * rather than replacing it. Optional: a town saved before it existed has none,
   * and `defaultConfig` deliberately does not set one, so `chainName`,
   * `network`, `rpcUrl` and `tokenAddress` keep describing the token chain.
   */
  settlementChain?: SettlementChain;
}

// === BRAWL: Leash ===
export interface Leash {
  perTrade: number;   // max SOL per trade
  daily: number;      // daily cap SOL
  sl: number;         // stop loss % (negatif, e.g. -20)
  tp: number;         // take profit % (positif, e.g. 40)
  share: number;      // caller profit share % (e.g. 20)
}

// === BRAWL: Vault ===
export interface Vault {
  id: string;
  keeperId: string;   // resident id pemilik modal
  agentId: string;    // resident id agen terotorisasi
  balance: number;    // SOL
  leash: Leash;
  paused: boolean;    // halt state
  createdAt: number;
}

// === BRAWL: Trade ===
export interface Trade {
  id: string;
  vaultId: string;
  agentId: string;
  callerId?: string;  // jika follow caller
  size: number;       // SOL size
  entryPrice: number;
  exitPrice?: number;
  pnl: number;        // dihitung saat close
  status: "open" | "closed" | "rejected";
  reason?: string;    // reject reason dari leash
  openedAt: number;
  closedAt?: number;
}

// === BRAWL: Ledger Entry ===
export interface LedgerEntry {
  tradeId: string;
  agentId: string;
  callerId?: string;
  pnl: number;
  callerPaid: number;  // 0 jika loss
  keeperPaid: number;
  t: number;
  txHash?: string;     // anchor on-chain; absent until a contract exists
}

// === BRAWL: Caller ===
export interface Caller {
  id: string;
  residentId: string;
  handle: string;
  winRate: number;     // dari ledger
  totalPnl: number;    // dari ledger
  followers: string[]; // resident ids
}

// === BRAWL: settlement chain — field optional BARU ===
// The settlement rail lives ALONGSIDE the token chain rather than replacing it:
// defaultConfig (config.ts) describes the token chain, and the two now agree on
// Solana Mainnet without either of them being written by this interface.
//
// Solana is not EVM, which is what shapes every field below. There is no chain
// id in the eth_chainId sense — the chain is named by its genesis hash — so
// `chainId` is optional and `genesisHash` carries the identity instead. There is
// no faucet on mainnet, so `faucetUrl` is optional and omitted rather than left
// pointing at a testnet that no longer applies.
//
// Every new field is optional so a save written before this change still loads;
// the only field that was required and no longer is `chainId`.
export interface SettlementChain {
  name: string;      // "Solana Mainnet"
  rpcUrl: string;    // https://api.mainnet-beta.solana.com
  explorer: string;  // https://explorer.solana.com
  nativeSymbol: string; // "SOL"
  /** The genesis hash, in base58. Solana's equivalent of a chain id. */
  genesisHash?: string;
  /**
   * EVM chain id, for the era when this rail was Robinhood Chain Testnet 46630.
   * Kept so an older save still validates and still reads correctly; never set
   * on a new one, because the number means nothing on Solana.
   */
  chainId?: number;
  /** Testnet-only. There is no faucet on mainnet, so this is simply absent. */
  faucetUrl?: string;
}

// === BRAWL: Bestiary — six risk monsters (blueprint §4.1) ===
export interface Monster {
  id: string;
  name: string;
  danger: string;     // the risk, stated plainly
  dcol: string;       // palette hex for the card accent
  px: string;         // a pixel-art inline SVG (mono, currentColor)
  text: string;       // what it does to you
  weak: string;       // the mitigation — the leash rule that counters it
}

// === BRAWL: Elder — branching settlement dialog (blueprint §4.1) ===
export interface ElderNode {
  id: string;
  topic: string;       // the label the reader picks
  text: string;        // the Elder's answer
  next?: string[];     // follow-up topic ids offered after this node
}

// Utility: clamp
export function clamp(min: number, max: number, v: number) {
  return Math.max(min, Math.min(max, v));
}
