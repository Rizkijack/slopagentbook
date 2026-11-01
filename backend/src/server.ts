import express from "express";
import cors from "cors";
import type { TownSnapshot, Resident } from "@slopagentbook/shared";
import { Hc, rf, encodeGenes } from "@slopagentbook/shared";
import { defaultConfig, pruneRelationships } from "@slopagentbook/shared";
import { saveAtomically, saveDebounced, flushDebounced, refreshQuestsFromStore } from "./persist.js";
import { normalizeHerd } from "./pgstore.js";
import { createInitialWorld, makeResidentFromFork, generateEdition, generateWeatherEvent } from "./world.js";
import { loadWithRecovery } from "./persist.js";
import { updateQuestProgress, claimQuest, refreshExpiredQuests, generateQuest, createInitialQuests, questRewardInfo } from "./quests.js";
import { LOCATIONS, LOCATION_BY_ID } from "./locations.js";
import { spend } from "./spend.js";
import { createBrain } from "./brain.js";
import { setWorldRef } from "./memory.js";
import { createScheduler } from "./scheduler.js";
import { runTurn } from "./turn.js";
import { createGatewayRouter } from "./gateway.js";
import { createBrawlRouter } from "./brawl.js";
import { ensureHouseResidents, HOUSE_AGENTS } from "./houseagents.js";
import { retireResolved, tickTournament, type TournamentEvent } from "./tournament.js";
// shared helpers — single definitions live in agents.ts (dedup with gateway.ts)
import { CONTROL_CHARS, clientIp, createRateLimiter, pickNextSimId, parseProfileUrl, parseProfileLinks, verifyToken, AgentError } from "./agents.js";
import { sessionCookieFrom } from "./session.js";
import { z } from "zod";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

function resolveDataPath(): string {
  if (process.env.DATA_PATH) return process.env.DATA_PATH;
  // Vercel serverless: only /tmp is writable per instance
  if (process.env.VERCEL) return "/tmp/town.json";
  // Try cwd/data/town.json (when running from project root)
  if (existsSync("data/town.json") || existsSync(path.join(process.cwd(), "data/town.json"))) {
    return path.join(process.cwd(), "data/town.json");
  }
  // Fallback: relative to this file (backend/src -> ../../data)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "../../data/town.json");
}

const DATA_PATH = resolveDataPath();

if (process.env.DATABASE_URL) {
  try {
    const { neon } = await import("@neondatabase/serverless");
    const { ensureSchema } = await import("./pgstore.js");
    await ensureSchema(neon(process.env.DATABASE_URL));
  } catch (e) {
    console.error("[persist] ensureSchema failed, booting ephemeral world:", e);
  }
}

// Load or create world
let world: TownSnapshot;
// A file that exists but will not parse is a DIFFERENT case from no file at all.
// Falling back to createInitialWorld() there started a fresh town and then, 800ms
// later, the autosave wrote that over the real one — silent total loss. Refuse to
// boot on an unreadable save instead; the operator moves it aside and starts again.
if (existsSync(DATA_PATH)) {
  let loaded: TownSnapshot | null = null;
  try {
    loaded = await loadWithRecovery(DATA_PATH) as TownSnapshot;
  } catch (e) {
    console.error(
      `[persist] ${DATA_PATH} exists but could not be read. Refusing to boot so the save is not overwritten.`,
    );
    console.error(e instanceof Error ? e.message : String(e));
    console.error("Move it aside (e.g. rename to .broken) and restart, or delete it to start a new town.");
    process.exit(1);
  }
  if (!loaded || !Array.isArray(loaded.herd) || !loaded.config) {
    console.error(`[persist] ${DATA_PATH} is missing herd or config. Refusing to boot rather than overwriting it.`);
    process.exit(1);
  }
  world = loaded;
} else {
  world = createInitialWorld();
}

// Trim relationship maps already over the cap in a pre-cap save. Writes prune on
// every decision, but a resident who never acts would otherwise stay fat forever,
// and their map is paid for by every client on every snapshot. See shared/relmap.ts.
for (const r of world.herd) pruneRelationships(r.mind);

if (!Array.isArray((world as any).quests)) (world as any).quests = [];
if (world.quests.length === 0) {
  world.quests = createInitialQuests(world);
}

// In production, a fresh boot is a quiet field (8 seeded residents). That
// does not serve a watchable town, so on a non-test boot we move the herd up
// to around fifty, using the distinct names in world.ts. Test fixtures import
// this module directly and assert exact herd sizes, so the padding is gated on
// NODE_ENV !== "test".
const FRESH_BOOT_HERD = 58;
if (process.env.NODE_ENV !== "test" && world.herd.length < FRESH_BOOT_HERD) {
  const grown = createInitialWorld(FRESH_BOOT_HERD).herd;
  const have = new Set(world.herd.map((h) => h.name.toLowerCase()));
  for (const resident of grown) {
    if (!have.has(resident.name.toLowerCase()) && world.herd.length < world.config.maxHerd) {
      world.herd.push(resident);
      have.add(resident.name.toLowerCase());
    }
  }
}
/**
 * Branding keys a rename may carry into an existing town. On-chain fields are
 * NOT here on purpose: the treasury address points at real funds, so a default
 * must never rewrite it.
 */
const BRAND_KEYS = ["name", "ticker", "xUrl"] as const;

/**
 * Every brand a saved town may still be carrying, oldest first.
 *
 * The project has been renamed more than once, and a town only ever sees
 * whatever was current when it last wrote. Listing the whole history means a
 * town that skipped a rename is still carried forward, and listing it as a set
 * rather than a single value means the rebrand is not something that silently
 * stops working after the next rename.
 */
const PREVIOUS_BRANDS: Record<string, string[]> = {
  name: ["Hermesbook", "Agentbook"],
  ticker: ["HERMES", "AGBK"],
  xUrl: ["https://x.com/hermesbook", "https://x.com/agentbook"],
};

/**
 * Apply the rename to a town that still carries the old brand.
 *
 * A rename that only edits `defaultConfig` never reaches a town with a save —
 * the loaded row's own config wins, which is exactly what keeps the treasury
 * address safe. Pure branding needs the opposite, so it is reconciled here at
 * boot. Matching the previous brand explicitly means this can only ever fire on
 * a town that predates the rename, never on one someone has retitled by hand.
 *
 * Returns the keys it changed so the caller can log and persist.
 */
export function applyRebrand(config: Record<string, unknown>): string[] {
  const changed: string[] = [];
  for (const key of BRAND_KEYS) {
    const previous = PREVIOUS_BRANDS[key] ?? [];
    const current = config[key];
    if (typeof current !== "string") continue;
    if (defaultConfig[key] === current) continue; // already on the new brand
    if (!previous.includes(current)) continue; // someone renamed it by hand
    config[key] = defaultConfig[key];
    changed.push(key);
  }
  return changed;
}

const rebranded = applyRebrand(world.config as unknown as Record<string, unknown>);
if (rebranded.length > 0) {
  console.log(`[boot] rebranded ${rebranded.join(", ")} -> ${world.config.name} (${world.config.ticker})`);
  saveDebounced(DATA_PATH, world, 0);
}

/**
 * Chain fields whose Base-era value identifies the chain BY ITSELF, so they can
 * be matched on their own. `tokenAddress` is NOT here, for the same reason it
 * is not in BRAND_KEYS: it points at real funds, so a default must never
 * rewrite it.
 *
 * `network` is deliberately NOT here either. "mainnet" is not a Base value — it
 * is the ordinary word for every production EVM chain, and Ethereum, Polygon and
 * Arbitrum all carry it. Matching it on its own would let this drag a town
 * someone pointed at Ethereum onto "mainnet-beta" while its `chainName` still
 * said Ethereum, producing exactly the mixed config this function exists to
 * prevent. It is retargeted only once another field has identified the town.
 */
const CHAIN_KEYS = ["chainName", "rpcUrl", "explorer", "dexUrl"] as const;

/**
 * Every Base-era value a saved town may still be carrying.
 *
 * The token moved to Solana Mainnet, and changing `defaultConfig` alone is not
 * enough for a town that has a save: the loaded row's own config wins, so the
 * running town keeps rendering "Base", `mainnet.base.org` and basescan.org
 * indefinitely. Boot is the only point every instance passes through, so the
 * chain is reconciled here — under the same explicit-match rule that makes
 * `applyRebrand` safe.
 *
 * `explorer` carries two entries because the field's exact Base-era form is not
 * something this repo can prove: the live save holds the full
 * `https://basescan.org/token/<mint>` string, but a save written before the mint
 * was appended would hold the bare `https://basescan.org`. Neither form has ever
 * been confirmed in this repository's history, so both are carried forward —
 * carrying one the town does not have costs nothing, because a match with no
 * counterpart just means that field is already correct. Anything else — a
 * hand-set proxy, a basescan URL for some other address — is deliberately not
 * matched, and now refuses the whole town rather than half-migrating it.
 */
const PREVIOUS_CHAIN: Record<string, string[]> = {
  chainName: ["Base"],
  network: ["mainnet"],
  rpcUrl: ["https://mainnet.base.org"],
  explorer: [
    "https://basescan.org/token/TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj",
    "https://basescan.org",
  ],
  dexUrl: ["https://dexscreener.com/base/"],
};

/**
 * Apply the chain retarget to a town still carrying the Base-era chain.
 *
 * Same discipline as `applyRebrand`, for the same reason. A blanket copy of
 * `defaultConfig` would fix the chain but would also rewrite `tokenAddress` on
 * every operator who ever set a real address by hand — the treasury surface.
 * Instead each field is retargeted only when it equals a value this migration
 * is known to have produced, so this fires on a town that predates the move and
 * on nothing else. A town pointed at another chain by hand is left alone.
 *
 * `network` and `nativeSymbol` are carried only once some other field has
 * recognized this town as ours — see CHAIN_KEYS for why neither can identify a
 * chain by itself. That covers the town this migration actually produced, and a
 * town somebody half-migrated by hand, while leaving a town pointed at another
 * chain untouched down to these two fields.
 *
 * Returns the keys it changed so the caller can log and persist.
 */
export function applyChainRetarget(config: Record<string, unknown>): string[] {
  const changed: string[] = [];

  // A key naming neither the old chain nor the new one was set by hand. Retargeting
  // the rest would leave the town claiming Solana while still pointing at another
  // chain's RPC and explorer — the mixed config this function exists to prevent,
  // and one nothing downstream can detect. So refuse the whole town. A consistent
  // stale config is visible on the page and fixable; a mixed one is neither.
  //
  // Concretely: an operator on their own Base node holds chainName "Base" but a
  // hand-set rpcUrl and explorer. Retargeting only the keys that match would give
  // them Solana with a Base RPC behind it and no signal that anything is wrong.
  const foreign = CHAIN_KEYS.some((key) => {
    const current = config[key];
    if (typeof current !== "string") return false;
    return current !== defaultConfig[key] && !(PREVIOUS_CHAIN[key] ?? []).includes(current);
  });
  if (foreign) return [];

  // Is this town one of ours? A field carrying either a Base-era value or the
  // current Solana value is enough — several may already have been migrated by
  // hand, and any one of them settles the question. Computed BEFORE anything is
  // rewritten, so it answers "what was this town?", not "what is it now?".
  const isOurs = CHAIN_KEYS.some((key) => {
    const current = config[key];
    if (typeof current !== "string") return false;
    return current === defaultConfig[key] || (PREVIOUS_CHAIN[key] ?? []).includes(current);
  });

  for (const key of CHAIN_KEYS) {
    const previous = PREVIOUS_CHAIN[key] ?? [];
    const current = config[key];
    if (typeof current !== "string") continue;
    if (defaultConfig[key] === current) continue; // already on the new chain
    if (!previous.includes(current)) continue; // pointed somewhere by hand
    config[key] = defaultConfig[key];
    changed.push(key);
  }

  if (!isOurs) return changed;

  const network = config.network;
  if (
    typeof network === "string" &&
    PREVIOUS_CHAIN.network.includes(network) &&
    defaultConfig.network !== network
  ) {
    config.network = defaultConfig.network;
    changed.push("network");
  }
  if (!config.nativeSymbol && typeof defaultConfig.nativeSymbol === "string") {
    config.nativeSymbol = defaultConfig.nativeSymbol;
    changed.push("nativeSymbol");
  }
  return changed;
}

const retargeted = applyChainRetarget(world.config as unknown as Record<string, unknown>);
if (retargeted.length > 0) {
  console.log(
    `[boot] chain retargeted ${retargeted.join(", ")} -> ${world.config.chainName} ${world.config.network}`,
  );
  // A lagging instance booted before this deploy still holds the Base config in
  // memory and writes it straight back over the retargeted row on its next
  // autosave, because `mergeSnapshots` takes `config` whole and last-writer-wins.
  // It self-heals on that instance's next boot, so the end state converges — but
  // on a rolling deploy the town can flap. Seeing this line on one instance and
  // "Base" on another is this, not a failed retarget. `applyRebrand` has had the
  // same exposure since it was written.
  saveDebounced(DATA_PATH, world, 0);
}

/**
 * `config.brain` is the one config field the runtime never reads: `createBrain()`
 * takes no arguments, so a town running purely its rule table still carried
 * `"llm"` from an older default, and `/api/status` reported `brain: sim` sitting
 * right next to `configBrain: llm`. That pairing reads as a model being wired and
 * quietly failing, which is the opposite of true.
 *
 * Reconciled at boot under the same explicit-previous-value rule the brand and
 * chain reconciliations use: only a town still carrying the exact value this
 * change replaced is rewritten, so a config someone set to "llm" on purpose is
 * left alone.
 */
export function applyBrainDefault(config: Record<string, unknown>): string[] {
  const changed: string[] = [];
  if (config.brain === "llm" && defaultConfig.brain !== "llm") {
    config.brain = defaultConfig.brain;
    changed.push("brain");
  }
  return changed;
}

/**
 * Fill a treasury address a save has never carried, and retarget a town still
 * carrying the value this default replaced.
 *
 * Two rules in one reconciler, each narrower than it looks:
 *
 *  - Absence fills. This field once did not exist at all, so absence is treated
 *    as "a save that predates the field", never as "an operator blanked it on
 *    purpose" — an operator who blanks it leaves the key present and empty,
 *    which this leaves alone. A config that already carries a non-empty address
 *    that is not the retired default is never touched, for the same reason the
 *    brand reconciliation is not: a default must not rewrite a real value.
 *  - Every exact retired default is rewritten. Since this default exists, it has
 *    moved twice: `5wwS…` -> `EnS8…` (2026-10-30), then `EnS8…` ->
 *    `Ercx6e…` (2026-11-01). Saves that still carry any retired one would keep
 *    it forever under the absence rule, so retired values join the same pattern
 *    `applyBrainDefault` uses: only a town still carrying one of them exactly is
 *    touched; an operator-set address of any other shape is left alone.
 *
 * Returns the keys it changed so the caller can log and persist.
 */
const RETIRED_TREASURIES: ReadonlySet<string> = new Set([
  "5wwSxR2Yttu3RieEEmKHmRq34EudDbMY42j9RLJfjMKs", // the placeholder this field's first default replaced
  "EnS8fknZdYHkJZtGN2HcS3vExJ3fyGqubNeg5Kpr5yBx", // the 2026-10-30 default, retired 2026-11-01
]);

export function applyTreasuryAddress(config: Record<string, unknown>): string[] {
  const changed: string[] = [];
  const current = config.treasuryAddress;
  if (typeof current === "string" && current !== "" && current !== defaultConfig.treasuryAddress) {
    // An address the save actually carries. Fill-with-default only applies when
    // the save has nothing; a real value is retargeted only when it is a retired
    // default this current one replaced — never an operator's own address.
    if (RETIRED_TREASURIES.has(current) && defaultConfig.treasuryAddress) {
      config.treasuryAddress = defaultConfig.treasuryAddress;
      changed.push("treasuryAddress");
    }
    return changed;
  }
  const isAbsent = !("treasuryAddress" in config) || current === undefined || current === null;
  if (isAbsent && defaultConfig.treasuryAddress) {
    config.treasuryAddress = defaultConfig.treasuryAddress;
    changed.push("treasuryAddress");
  }
  return changed;
}

const brained = applyBrainDefault(world.config as unknown as Record<string, unknown>);
if (brained.length > 0) {
  console.log(`[boot] brain reconciled ${brained.join(", ")} -> ${world.config.brain} (rules only, no provider)`);
  saveDebounced(DATA_PATH, world, 0);
}

const treasuried = applyTreasuryAddress(world.config as unknown as Record<string, unknown>);
if (treasuried.length > 0) {
  console.log(
    `[boot] treasury address reconciled ${treasuried.join(", ")} -> ${world.config.treasuryAddress}`,
  );
  saveDebounced(DATA_PATH, world, 0);
}

// Capacity is operator-controlled and stays at the default (`maxHerd` 200).
// What the operator asked for on 2026-10-30 is a reduction of the herd the
// row currently holds (61 probe-era residents) down to 20 — a one-shot change
// of the town's contents, not of the cap, so new joins still have pasture.
//
// One-shot means a marker, not an exact-previous value: there is no old value
// to match on, the herd is dynamic state. Without a stamp the trim would fire
// on every boot and silently shave any town that later legitimately grows past
// 20. `herdReduced20261030` is stamped into config the first time this runs;
// boots after that skip it entirely.
const HERD_REDUCTION_KEY = "herdReduced20261030";
const HERD_REDUCTION_TARGET = 20;

// The oldest-first survivor rule the merge uses would sweep the three house
// bots out first (the bots were born days before the probe residents), and a
// trimmed-without-bots town cannot take them back — `ensureHouseResidents`
// honours the cap and refuses, leaving the arena without its house entrants,
// which is the default degradation houseagents.ts names. So the reduction
// pins the bots into the surviving pool and fills the rest with the NEWEST
// non-bots, the mirror image of capHerd's drop order.
export function trimToTargetKeepingBots(world: TownSnapshot, target: number): boolean {
  if (world.herd.length <= target) return false;
  // string[] deliberately: `includes(h.id)` must accept any resident id, and
  // HouseAgentId's literal union would make `includes` a type error.
  const HOUSE_IDS: string[] = HOUSE_AGENTS.map((p) => p.id);
  const bots = world.herd.filter((h) => HOUSE_IDS.includes(h.id));
  const nonBots = world.herd.filter((h) => !HOUSE_IDS.includes(h.id));
  const botSlots = Math.min(bots.length, target);
  const room = Math.max(0, target - botSlots);
  // newest non-bots survive (born desc, herd order breaks ties)
  const survivors = nonBots
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (b.h.born ?? 0) - (a.h.born ?? 0) || b.i - a.i)
    .slice(0, room)
    .map((x) => x.h);
  world.herd = [...survivors, ...bots.slice(0, botSlots)] as unknown as typeof world.herd;
  return true;
}

/**
 * One-shot boots are versioned so a stale stamp re-runs exactly once and then
 * rests: the first live pass proved the row the bots vanished from earlier
 * (they got re-seeded after the trim, leaving 23 = 20 + 3), so the rule became
 * ensure-then-trim (bot presence guaranteed by `ensureHouseResidents`, which
 * runs first now) and the stamp moved to v2. `true` — the v1 stamp — is a
 * stale mark on any save that already hit it, and re-runs; the v2 stamp is the
 * resting state.
 */
export const HERD_REDUCTION_STAMP = "v2";

export function reduceActiveHerd(world: TownSnapshot): boolean {
  const cfg = world.config as unknown as Record<string, unknown>;
  if (cfg[HERD_REDUCTION_KEY] === HERD_REDUCTION_STAMP) return false;
  cfg[HERD_REDUCTION_KEY] = HERD_REDUCTION_STAMP;
  const before = world.herd.length;
  // The bots are guaranteed present before the trim: `ensureHouseResidents`
  // runs just before this call at boot, so pinning always catches all three.
  trimToTargetKeepingBots(world, HERD_REDUCTION_TARGET);
  // Name duplicates still normalize in the surviving pool; at/below the
  // reduction's own target the born-based cap rule inside normalize is inert,
  // so it cannot throw the pinned bots out.
  const normalized = normalizeHerd(world);
  if (normalized.length !== world.herd.length) {
    world.herd = normalized as unknown as typeof world.herd;
  }
  console.log(
    before !== world.herd.length
      ? `[boot] active herd reduced ${before} -> ${world.herd.length} (target ${HERD_REDUCTION_TARGET}, house bots pinned; herd cap stays ${world.config.maxHerd})`
      : `[boot] herd already at/below the active reduction target ${HERD_REDUCTION_TARGET} — reduction marked done (cap stays ${world.config.maxHerd})`,
  );
  saveDebounced(DATA_PATH, world, 0);
  return true;
}

// The bots must exist BEFORE the reduction so the pins can catch them: see
// reduceActiveHerd. Seeding here also predates the scheduler build below, so
// the bots join the rotation and are driven by the sim like every other
// resident.
ensureHouseResidents(world);

reduceActiveHerd(world);

// The memory sink reads mind.memories off this ref. Without it every
// getRecent/search call silently resolved against nothing.
setWorldRef(world);

const brain = createBrain();
const scheduler = createScheduler(world.herd.map((h) => h.id));
const app: import("express").Express = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));

// Rate limit in-memory for fork per IP per hour (shared bounded limiter —
// see the caveat in agents.ts: per-instance memory, so N × limit behind a
// multi-instance deployment such as Vercel)
const rateLimitFork = createRateLimiter(6, 60 * 60 * 1000);

// A public route that MUTATES the town must be metered, exactly like fork is.
// /api/quests/refresh used to be reachable by anyone, unlimited: one caller
// could fill the board, force a quest generation and a full-row write per
// request. /api/quests/:id/claim is unauthenticated by design (anyone may
// claim a completed quest) but it still writes the row, so it needs a ceiling
// too. Same shared-limiter caveat as fork: per-instance memory, so N x limit
// behind a multi-instance deployment.
const rateLimitQuestRefresh = createRateLimiter(10, 60 * 1000);
const rateLimitQuestClaim = createRateLimiter(30, 60 * 1000);

// SSE clients
const clients = new Set<import("express").Response>();

/**
 * How many concurrent SSE clients one instance serves.
 *
 * Every stream holds a socket and a 25 s ping interval, so an unbounded set is
 * an availability hole reachable without a credential. Read at request time so
 * a test can set a low ceiling.
 */
const MAX_SSE_CLIENTS = () => Number(process.env.MAX_SSE_CLIENTS ?? 200);

function broadcast(msg: unknown): void {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {}
  }
}

// GET /api/snapshot
app.get("/api/snapshot", (_req, res) => {
  // the agent registry holds token hashes — credentials never leave the server
  const { agents: _agents, ...publicWorld } = world;
  res.json({ ...publicWorld, now: Date.now() });
});

// GET /api/stream SSE
app.get("/api/stream", (req, res) => {
  if (clients.size >= MAX_SSE_CLIENTS()) {
    res.status(503).json({ error: "too many stream clients" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": open\n\n");
  clients.add(res);
  // ping every 25s
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, 25000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
    try { res.end(); } catch {}
  });
});

// POST /api/fork
const forkSchema = z.object({
  parent: z.string().min(1),
  name: z.string().min(1).max(32),
  bio: z.string().max(180).optional().default(""),
  traits: z.array(z.string()).max(3).optional().default([]),
  job: z.string().optional().default("herder"),
  // profile presentation, optional at registration. Shape only: the scheme
  // allowlist and every other rule live in parseProfileUrl/parseProfileLinks
  // (agents.ts), the same validators PATCH /api/agent/profile uses, so there is
  // one answer to "is this url acceptable" and not two that can drift.
  avatar: z.string().optional(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
});

app.post("/api/fork", async (req, res) => {
  if (!rateLimitFork(clientIp(req))) {
    res.status(429).json({ error: "rate limited, try again later" });
    return;
  }

  const parsed = forkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid payload", details: parsed.error.flatten() });
    return;
  }
  const { parent, name, bio, traits, job, avatar, links } = parsed.data;

  // Validated before ANY mutation, in the same spirit as the parent/name checks
  // below: a bad avatar must not be able to create a resident first and fail
  // afterwards. These throw AgentError (400) naming the field.
  let profile: { avatar?: string; links?: { label: string; url: string }[] } = {};
  try {
    if (avatar !== undefined) profile.avatar = parseProfileUrl("avatar", avatar);
    if (links !== undefined) profile.links = parseProfileLinks(links);
  } catch (e) {
    if (e instanceof AgentError) {
      res.status(e.status).json({ error: e.message, field: e.field ?? null });
      return;
    }
    throw e;
  }

  // Input validation runs BEFORE the capacity check so a bad payload always
  // reports why it is bad — a full pasture must not mask a missing parent or
  // a taken name (test: "POST /api/fork validates input before capacity").
  const parentResident = world.herd.find((h) => h.id === parent);
  if (!parentResident) {
    res.status(400).json({ error: "parent not found" });
    return;
  }

  const nameExists = world.herd.some((h) => h.name.toLowerCase() === name.toLowerCase());
  if (nameExists) {
    res.status(400).json({ error: "name already taken" });
    return;
  }

  // moderate: no control chars
  if (CONTROL_CHARS.test(name + bio)) {
    res.status(400).json({ error: "invalid characters" });
    return;
  }

  // capacity last — right before the mutation: a valid payload on a full
  // pasture still gets the 400, but only after the input itself is checked.
  if (world.herd.length >= world.config.maxHerd) {
    res.status(400).json({ error: "the pasture is full" });
    return;
  }

  // genetics
  const parentGenes = Hc(parentResident.genes);
  const childGenes = rf(parentGenes, name);
  const childGenesStr = encodeGenes(childGenes);

  const child: Resident = makeResidentFromFork(parentResident, name, bio, traits, job, childGenesStr);
  // profile presentation rides along on the child. NOT copied from the parent:
  // an avatar is a person's, not a bloodline's, and inheriting one would let a
  // fork impersonate the resident it forked from.
  if (profile.avatar !== undefined) child.avatar = profile.avatar;
  if (profile.links !== undefined && profile.links.length > 0) child.links = profile.links;
  world.herd.push(child);
  parentResident.forks = (parentResident.forks ?? 0) + 1;
  world.now = Date.now();

  // atomic flush immediate per 01:142
  try {
    await saveAtomically(DATA_PATH, world);
  } catch (e) {
    console.error("save failed", e);
    // rollback in-memory
    world.herd = world.herd.filter((h) => h.id !== child.id);
    parentResident.forks--;
    res.status(500).json({ error: "persist failed" });
    return;
  }

  scheduler.add(child.id);

  // broadcast via SSE
  broadcast({ type: "llama", llama: child });
  broadcast({ type: "herd", herd: world.herd });

  res.json(child);
});

// GET /api/treasury — illustrative balance, NOT a chain reading.
//
// The comment here used to say "cache 60s" and the UI said "refreshed every 60s
// from RPC cache". Neither was true: this returns fixed numbers and the cache
// only ever re-serves them. No RPC is called, because there is nothing to read —
// no $SLB mint is deployed. The values are kept so the treasury card still
// renders a shape, and the page copy now says exactly that.
let treasuryCache: { data: unknown; at: number } | null = null;
app.get("/api/treasury", (_req, res) => {
  const now = Date.now();
  if (treasuryCache && now - treasuryCache.at < 60_000) {
    res.json(treasuryCache.data);
    return;
  }
  const data = {
    // The treasury wallet, which is a different field from the token mint and a
    // different claim. `tokenAddress` was being served here because it was the
    // only address on the config, and that made the endpoint answer the token
    // question whenever it was asked the treasury one. Both are returned now;
    // only `treasuryAddress` describes money.
    address: world.config.treasuryAddress ?? "",
    treasuryAddress: world.config.treasuryAddress ?? "",
    tokenAddress: world.config.tokenAddress,
    chainName: world.config.chainName,
    network: world.config.network,
    nativeSymbol: world.config.nativeSymbol ?? "SOL",
    tokenDeployed: world.config.tokenDeployed === true,
    illustrative: true,
    sol: 6.00473291,
    solUsd: 119.2,
    usd: 715.764162872,
    updated: now,
  };
  treasuryCache = { data, at: now };
  res.json(data);
});

// GET /api/status
app.get("/api/status", (_req, res) => {
  res.json({
    // The mode actually in use, not the configured one. Reporting world.config.brain
    // said "llm" while calls were 0 and failures 252, which sends a reader hunting an
    // API key that is not there. configBrain stays for when the two differ.
    brain: brain.mode,
    configBrain: world.config.brain,
    herd: world.herd.length,
    feed: world.feed.length,
    spend: { dayKey: spend.dayKey, usd: spend.usd, calls: spend.calls, cap: spend.cap },
    llm: { calls: spend.calls, failures: spend.failures, promptTokens: spend.promptTokens, completionTokens: spend.completionTokens, lastError: spend.lastError },
  });
});

// Quests
app.get("/api/quests", async (_req, res) => {
  // refresh expired before returning
  refreshExpiredQuests(world);
  // read-through: the board must not echo this instance's stale memory when the
  // row carries new/progressed/expired quests (multi-instance, see
  // refreshQuestsFromStore). Cooldowned; no-op in file mode.
  await refreshQuestsFromStore(DATA_PATH, world);
  // Each quest carries the claim contract: what pays now (spirits) and the
  // treasury-funded token side that activates when a mint is deployed. Pure
  // additive metadata on top of the board — the UI reads it, saves never write
  // it back into a quest.
  const rewardToken = questRewardInfo(world.config);
  res.json(world.quests.map((q) => ({ ...q, rewardToken })));
});

app.post("/api/quests/:id/claim", async (req, res) => {
  if (!rateLimitQuestClaim(clientIp(req))) {
    res.status(429).json({ error: "rate limited, try again later" });
    return;
  }
  const id = req.params.id;
  // This route is unauthenticated — anyone may claim a completed quest — so the
  // claimant is resolved best-effort from the session cookie the chat board
  // already issues. Signed in means the claim is attributed; anonymous means it
  // is not, which is recorded rather than guessed at from the quest's giver.
  const sessionToken = sessionCookieFrom(req);
  const sessionRecord = sessionToken ? verifyToken(world, sessionToken) : null;
  const claimant = sessionRecord ? world.herd.find((h) => h.id === sessionRecord.residentId)?.id : undefined;
  let result = claimQuest(world, id, claimant);
  const retriable = (err: typeof result.error): boolean =>
    /(not found|not completed|not available)/.test(err ?? "");
  if (!result.ok && retriable(result.error)) {
    // Multi-instance skew: the row may already status this quest complete from
    // another instance's claim path. One refresh + one retry, then the honest
    // failure stands. See refreshQuestsFromStore.
    if (await refreshQuestsFromStore(DATA_PATH, world)) {
      result = claimQuest(world, id, claimant);
    }
  }
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  broadcast({ type: "quest", quest: result.quest });
  broadcast({ type: "herd", herd: world.herd });
  // persist
  try { await saveAtomically(DATA_PATH, world); } catch {}
  res.json({ ...result.quest, rewardToken: questRewardInfo(world.config) });
});

app.post("/api/quests/refresh", async (req, res) => {
  if (!rateLimitQuestRefresh(clientIp(req))) {
    res.status(429).json({ error: "rate limited, try again later" });
    return;
  }
  const before = world.quests.length;
  refreshExpiredQuests(world);
  await refreshQuestsFromStore(DATA_PATH, world);
  // also generate one fresh if under 12 — the manual top-up on a board that
  // refreshExpiredQuests already refills to 6, so 12 is this route's own floor
  if (world.quests.length < 12) {
    const nq = generateQuest(world);
    world.quests.push(nq);
    broadcast({ type: "quest", quest: nq });
  }
  res.json({ before, after: world.quests.length, quests: world.quests });
});

// External agent gateway (join/resume/me/perceive/act/say/quests/boards)
app.use(createGatewayRouter({ world, broadcast, DATA_PATH, scheduler }));

// BRAWL rail (leash/vault/ledger/trade). Mounted after the gateway so its
// /api/brawl/* routes never shadow the existing /api/agent/* ones; auth is the
// same token, and the save hook is the same atomic writer.
app.use(
  createBrawlRouter({
    world,
    broadcast,
    save: () => saveAtomically(DATA_PATH, world),
    // read-only: `requireAgent` reloads a stale instance's registry from the same
    // path the gateway uses, so a keeper is not locked out by a cold read
    DATA_PATH,
  }),
);

// Gateway the mounted MCP handler calls back on. An explicit SLOPAGENTBOOK_URL
// wins (the documented override); otherwise it is THIS server — never a
// hard-coded 3000, or a custom PORT would send MCP reads and writes to another
// town (mcp/src/client.ts falls back to localhost:3000).
export function mcpGatewayUrl(): string {
  const explicit = process.env.SLOPAGENTBOOK_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = Number(process.env.PORT ?? 3000);
  return `http://localhost:${Number.isFinite(port) && port > 0 ? port : 3000}`;
}

// MCP Streamable HTTP transport — opt-in via MCP_HTTP=1 so the default bundle
// never pays for the MCP SDK. Dynamic import keeps the dependency lazy.
if (process.env.MCP_HTTP === "1") {
  void import("@slopagentbook/mcp/http")
    .then(({ createMcpHttpHandler }) => {
      // The handler's default client reads SLOPAGENTBOOK_URL, so pin it to this
      // server before the handler is built.
      process.env.SLOPAGENTBOOK_URL = mcpGatewayUrl();
      const handler = createMcpHttpHandler();
      // app.all, not app.post: Express would answer GET /mcp with its own 404
      // page, and the handler's 405 contract (mcp/src/http.ts) would never be
      // reachable through the mount.
      app.all("/mcp", (req, res) => void handler(req, res));
      console.log(`[mcp] Streamable HTTP mounted at POST /mcp (gateway ${process.env.SLOPAGENTBOOK_URL})`);
    })
    .catch((e) => console.error("[mcp] failed to mount /mcp:", e));
}

// health
app.get("/api/health", (_req, res) => res.json({ ok: true, now: Date.now() }));

// Turn scheduler interval (18s per doc demo; prod faster for testing 4s)
const TURN_MS = Number(process.env.TURN_MS ?? 1800);
// 5s on pg avoids rewriting the full snapshot every 1.8s tick.
const TICK_SAVE_MS = Number(process.env.PG_SAVE_DEBOUNCE_MS ?? (process.env.DATABASE_URL ? 5000 : 800));
let turnTimer: ReturnType<typeof setInterval> | null = null;
let turnCount = 0;
function startScheduler(): void {
  if (turnTimer) clearInterval(turnTimer);
  turnTimer = setInterval(async () => {
    const now = Date.now();
    // pick the next resident eligible for sim control: skip external agents that
    // are actively driven by their gateway (AFK externals still get sim turns).
    // pickNextSimId (agents.ts) owns that skip logic and is unit-tested there.
    const id = pickNextSimId(world, scheduler, now);
    const result = id ? await runTurn(world, id, brain) : null;
    const drove = Boolean(result?.order);
    const order = result?.order;
    if (order) {
      turnCount++;
      broadcast(order);
      if (result?.spit) broadcast(result.spit);
      if (result!.post && Date.now() - result!.post.t < 3000) {
        broadcast({ type: "post", post: result!.post });
        // Also push bubble via post SSE will trigger frontend; order already moves agent
      } else if (world.feed.length > 0) {
        const latest = world.feed[0]!;
        if (Date.now() - latest.t < 2500 && latest.id === result!.post?.id) {
          // already broadcast
        } else if (Date.now() - latest.t < 2500) {
          broadcast({ type: "post", post: latest });
        }
      }

      // Weather events: 2% per turn (~one per ~50 turns), or ~30 per day
      if (Math.random() < 0.02) {
        const ev = generateWeatherEvent();
        world.events.push(ev);
        if (world.events.length > 120) world.events.shift();
        broadcast({ type: "event", event: ev });
      }

      // Quest progress — every move counts for town
      const updatedQuests = updateQuestProgress(world, { act: order.act, place: order.place, agentId: order.id, postKind: result!.post?.kind });
      for (const q of updatedQuests) {
        broadcast({ type: "quest", quest: q });
        // also push quest complete as town event
        const ev = { t: Date.now(), kind: "quest", text: `Quest completed: ${q.title}` };
        world.events.push(ev);
        if (world.events.length > 120) world.events.shift();
        broadcast({ type: "event", event: ev });
      }
      // periodic quest housekeeping
      if (turnCount % 30 === 0) {
        const beforeLen = world.quests.length;
        refreshExpiredQuests(world);
        if (world.quests.length !== beforeLen) {
          for (const q of world.quests) broadcast({ type: "quest", quest: q });
        }
      }

      // Daily Spit edition: every 60 turns (~108s at 1.8s tick) ~ 8-9 editions per dayLength 900s if tick 1.8s: 500 turns per day, but we publish every 60 for demo
      // Also publish when day wraps for realism
      if (turnCount % 60 === 0) {
        const edition = generateEdition(world);
        world.editions.unshift(edition);
        if (world.editions.length > 20) world.editions.length = 20;
        broadcast({ type: "edition", edition });
      }
    }

    // Hermes Trials (08 §4.1): one scheduler step per tick. The lifecycle
    // (announce → live/skip → resolve → retire) must advance on EVERY tick, not
    // only on a turn that produced an order: on a quiet town — everyone
    // externally driven, or runTurn returning no order — the old two early
    // returns above left an announced contest sitting at "starts in 0s" on the
    // HUD indefinitely (seen in a live recording: the banner never flipped to
    // LIVE for the whole video). Sampling stays tied to real turns: `drove`
    // (spits can only originate inside a turn), so a skipped tick cannot
    // swallow one, and no sample is taken from an instant the sim did not walk.
    const tournament = tickTournament(world, now, result?.spit ? [result.spit.to] : [], drove);
    if (tournament) broadcast(tournament);
    for (const dropped of retireResolved(world, now)) {
      const retired: TournamentEvent = { type: "contest", reason: "retired", contestId: dropped };
      broadcast(retired);
    }

    // debounced save for routine ticks
    saveDebounced(DATA_PATH, world, TICK_SAVE_MS);
  }, TURN_MS);
  // allow process to exit in tests
  if (turnTimer && typeof (turnTimer as NodeJS.Timeout).unref === "function") (turnTimer as NodeJS.Timeout).unref();
}

function stopScheduler(): void {
  if (turnTimer) clearInterval(turnTimer);
  turnTimer = null;
}

// Do not auto-start in test env (vitest sets NODE_ENV=test)
if (process.env.NODE_ENV !== "test") startScheduler();

// Flush the debounced save on shutdown: without this a crash/SIGINT right after an
// agent action would drop it (the write already happened for act/say/join/claim —
// this covers the remaining debounced paths such as resume).
async function shutdown(): Promise<void> {
  try {
    await flushDebounced();
  } catch {
    // best effort — never block exit on a failed flush
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

export { app, world, broadcast, scheduler, brain, startScheduler, stopScheduler, DATA_PATH };
