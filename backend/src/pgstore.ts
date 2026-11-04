// Postgres backing for the town snapshot (Vercel: /tmp is ephemeral).
//
// The `sql` tag is injected so tests use a stub, never a real database.
//
// ## Why the save is a locked read-modify-write
//
// The town is a single JSONB row, but Vercel runs N serverless instances at
// once and each one keeps its own in-memory `world` loaded at boot. A plain
// upsert is last-writer-wins: an instance that booted before a fork still has
// the old herd, and its next tick overwrites the row — deleting every resident
// another instance added in the meantime. Observed on production as a snapshot
// that answered 39 residents on one request and 51 on the next.
//
// So a save takes a transaction-scoped advisory lock, reads whatever the row
// holds NOW, merges that with the snapshot we are holding (append-mostly, keyed
// by id — the town only ever grows; there is no delete endpoint), and writes
// the union. Two instances can never drop each other's residents.
//
// Known limits, deliberate for now:
// - On an id both instances know, OUR copy wins. Sim churn (spirits, needs,
//   relationships) can therefore regress by one tick when a lagging instance
//   saves. That is ephemeral state the next tick re-derives. QUESTS are the
//   exception — their progress is accumulated, not re-derived, so each quest id
//   picks by monotonic status/progress instead of ours-wins (`newerQuest`).
// - Serving still happens from the instance's memory, so a cold instance shows
//   its own herd until it reboots. The row is never wrong any more, but the
//   live view can lag; converging that needs a periodic refresh from pg.
// - MONEY is merged per record, not ours-wins (see the BRAWL block below).
//   Three limits come with that:
//   - Ties go to the writer's side (`>=` in newerRecord/newerTrade). At 1ms
//     clock resolution two mutations in the same millisecond are a tie, so the
//     writer's order wins rather than the row's.
//   - `updatedAt` is each instance's LOCAL clock, and the clocks skew. Two
//     instances funding the same vault can disagree about which is newer, and
//     the loser is overwritten. Fixing that needs a server-authoritative
//     counter (the `rev` column) or a per-vault optimistic check, which changes
//     the save path's contract — deliberately not done here.
//   - Two instances closing the SAME trade both write a ledger row for one
//     tradeId; the union keeps one, but the vault balance each credits may
//     disagree on PnL. The trade record itself converges (terminal beats open).
// - The four BRAWL arrays are deliberately UNCAPPED, unlike feed/events/editions/
//   quests/contests. They are financial records: a ledger row outlives the trade
//   it references, and a cap that kept the newest rows would silently orphan
//   history and destroy balances. The cost is that `town_state` grows without
//   bound on the settlement rail; that is the accepted trade, and the thing to
//   revisit if the row ever gets large.

/** Tagged-template query function (also what a transaction hands out). */
export type PgQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * A neon() client.
 *
 * `transaction` takes an ARRAY of already-built query objects — NOT a callback
 * that awaits queries. @neondatabase/serverless 1.2.0 throws
 * "transaction() expects an array of queries, or a function returning an array
 * of queries" otherwise, and because the failure only happens against the real
 * driver, a hand-written stub has to model the array form or it will happily
 * green-light code that 500s in production.
 */
export interface PgSql extends PgQuery {
  transaction(queries: PgPendingQuery[]): Promise<Record<string, unknown>[][]>;
}

/**
 * The object a tagged-template call returns. Awaiting it runs the query —
 * which is what makes `sql.transaction([sql\`...\`])` express "these run
 * together" instead of "run this callback".
 *
 * Typed as a plain promise because that is what the driver actually returns;
 * the driver reads the queries it is handed, it does not read properties off
 * them.
 */
export type PgPendingQuery = Promise<Record<string, unknown>[]>;

export const TOWN_ROW_ID = "town";

/** Advisory lock key for the town row. Any fixed value works; it just has to be the same everywhere. */
const TOWN_LOCK_KEY = 4271938;

export async function ensureSchema(sql: PgQuery): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS town_state (
      id TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  // Monotonic revision for the optimistic save below. `CREATE TABLE IF NOT
  // EXISTS` is a no-op on the row that already exists, so the column has to be
  // added separately; both statements are idempotent.
  await sql`ALTER TABLE town_state ADD COLUMN IF NOT EXISTS rev bigint NOT NULL DEFAULT 0`;
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

function asArr(value: unknown): Rec[] {
  return Array.isArray(value) ? (value.filter((r) => r && typeof r === "object") as Rec[]) : [];
}

function keyOf(row: Rec, fallback: string): string {
  return typeof row.id === "string" ? row.id : fallback;
}

/**
 * Union of two lists keyed by `key`, in stored order, then anything new from
 * `mine`. A row present in both keeps MINE — the caller is the instance that
 * just produced the tick, so its copy is the more recent one for that id.
 */
function unionBy(
  stored: Rec[],
  mine: Rec[],
  key: (row: Rec, i: number) => string,
): Rec[] {
  const merged: Rec[] = [];
  const index = new Map<string, number>();
  for (const [i, row] of stored.entries()) {
    const k = key(row, i);
    index.set(k, merged.length);
    merged.push(row);
  }
  for (const [i, row] of mine.entries()) {
    const k = key(row, i);
    const at = index.get(k);
    if (at === undefined) {
      index.set(k, merged.length);
      merged.push(row);
    } else {
      merged[at] = row;
    }
  }
  return merged;
}

/**
 * Union two keyed lists, then let `pick` decide which record survives for each
 * id. `unionBy` alone always takes the writer's copy, which is wrong for money:
 * a writer that has been running for an hour is not necessarily the one holding
 * the newer balance.
 */
function unionByRule(
  stored: Rec[],
  mine: Rec[],
  key: (row: Rec, i: number) => string,
  pick: (storedRow: Rec, mineRow: Rec) => Rec,
): Rec[] {
  const out: Rec[] = [];
  const index = new Map<string, number>();
  for (const [i, row] of stored.entries()) {
    const k = key(row, i);
    index.set(k, out.length);
    out.push(row);
  }
  for (const [i, row] of mine.entries()) {
    const k = key(row, i);
    const at = index.get(k);
    if (at === undefined) {
      index.set(k, out.length);
      out.push(row);
    } else {
      out[at] = pick(out[at]!, row);
    }
  }
  return out;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * MONEY rule — greater `updatedAt` wins; when EITHER side lacks it the live
 * (writer's) side wins.
 *
 * The legacy bias is deliberate and is the opposite of `unionBy`'s. A row
 * written before `updatedAt` existed cannot be ordered against one that has it,
 * so preferring stored would put us straight back where the bug started: the
 * row's old balance outvoting the funding that just happened. `-1` means
 * "unknown", and a tie of two unknowns goes to the writer — the same
 * ours-wins-ties convention every other union here uses.
 */
function newerRecord(storedRow: Rec, mineRow: Rec): Rec {
  const storedAt = num(storedRow.updatedAt, -1);
  const mineAt = num(mineRow.updatedAt, -1);
  return mineAt >= storedAt ? mineRow : storedRow;
}

/** A finished trade must never be walked back to `open` by a lagging instance. */
function terminalRank(row: Rec): number {
  return row.status === "open" ? 0 : 1;
}

/** Recency for a trade: updatedAt, else closedAt, else openedAt. */
function tradeRecency(row: Rec): number {
  return num(row.updatedAt, num(row.closedAt, num(row.openedAt)));
}

/**
 * TRADES rule — terminal beats open, then the newer record wins.
 *
 * `balance` is debited when a trade opens and credited when it closes, so an
 * `open` record resurrected over a `closed` one would leave the vault debited
 * twice for money that already settled. Rank is checked BEFORE recency so a
 * stale-but-recent `open` cannot beat a settled close; `updatedAt ?? closedAt ??
 * openedAt` orders two records that are both terminal.
 */
function newerTrade(storedRow: Rec, mineRow: Rec): Rec {
  const storedTerminal = terminalRank(storedRow);
  const mineTerminal = terminalRank(mineRow);
  if (storedTerminal !== mineTerminal) return mineTerminal > storedTerminal ? mineRow : storedRow;
  return tradeRecency(mineRow) >= tradeRecency(storedRow) ? mineRow : storedRow;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Factions are seeded lore, unique by name, and the only writer that ever adds
 * one is `createInitialWorld`. The pre-fix cold-start bug seeded a new
 * random-id faction on every boot, and `unionBy(id)` faithfully kept all of
 * them — the live row reached 177 identical "the board people" entries.
 *
 * Name is the honest identity. Duplicates collapse to the copy with the most
 * live members (ties keep the stored side, so instances converge), and member
 * ids that are no longer in the herd are dropped so the dossier has no ghosts.
 */
export function dedupeFactions(factions: Rec[], liveIds: Set<string>): Rec[] {
  const byName = new Map<string, Rec>();
  for (const faction of factions) {
    if (!faction || typeof faction !== "object") continue;
    const name = typeof faction.name === "string" ? faction.name.trim().toLowerCase() : "";
    const key = name || keyOf(faction, `faction${byName.size}`);
    const members = asStrings(faction.members).filter((id) => liveIds.has(id));
    const candidate = { ...faction, members };
    const existing = byName.get(key);
    if (!existing || members.length > asStrings(existing.members).length) {
      byName.set(key, candidate);
    }
  }
  return [...byName.values()];
}

/**
 * CALLERS rule — recency decides the record, `followers` unions inside it.
 *
 * `followers` is a grow-only set (nobody is ever un-followed), so overwriting it
 * would drop followers; the derived stats, on the other hand, summarise a
 * ledger that is itself merged, so they are taken from whichever side is newer
 * rather than recomputed here.
 */
function newerCaller(storedRow: Rec, mineRow: Rec): Rec {
  const winner = newerRecord(storedRow, mineRow);
  const followers = [...new Set([...asStrings(storedRow.followers), ...asStrings(mineRow.followers)])];
  return { ...winner, followers };
}

/**
 * Drop a tombstoned resident from every caller's follower list.
 *
 * A SEPARATE pass, not part of `newerCaller`: that only runs for records both
 * sides carry, and a follower list can hold a dead resident on a record only one
 * side ever had. Without this the entry would sit there forever — nothing else
 * ever rewrites the array.
 */
function pruneFollowers(row: Rec, deadResidents: Set<string>): Rec {
  if (!Array.isArray(row.followers)) return row;
  const kept = asStrings(row.followers).filter((id) => !deadResidents.has(id));
  return kept.length === asStrings(row.followers).length ? row : { ...row, followers: kept };
}

/**
 * Tombstone filter for the money records. `alive()` cannot be reused: it looks
 * at `id`/`by`/`agentId`, and these records name their resident under different
 * keys (`keeperId`, `residentId`, `callerId`). Without this a removed resident
 * would leave a funded vault and a ledger row that the next merge revives.
 */
function aliveMoney<T extends Rec>(rows: T[], fields: string[], dead: Set<string>): T[] {
  return rows.filter((r) => !fields.some((f) => typeof r[f] === "string" && dead.has(String(r[f]))));
}

/**
 * QUEST rule — monotonic board state, not recency and not ours-wins.
 *
 * Quest progress is accumulated state that only lives in the snapshot (there is
 * no re-derivation: a lagging instance's tick would otherwise rewrite 2/3 back
 * to 1/3 — observed live 2026-10-31, a talk quest "lost" an act between two
 * round-trips). So the per-id pick is ordered by status, which can only move
 * forward: available < active < expired < completed < claimed. A payout status
 * (claimed) held by one side is terminal and beats a stale active copy of the
 * same quest; `expired` marks a quest refreshExpiredQuests has retired, and
 * beats active/available so an instance that has not yet seen the expiry cannot
 * resurrect it — the union alone would, because it starts from what the row
 * holds.
 *
 * Equal status ranks compare `progress` (max wins; explore's `_visited` grows
 * alongside it), and full ties keep the writer's copy — the same
 * ours-wins-ties convention as every other union here.
 */
const QUEST_STATUS_RANK: Record<string, number> = {
  available: 0,
  active: 1,
  expired: 2,
  completed: 3,
  claimed: 4,
};

function questStatusRank(row: Rec): number {
  return QUEST_STATUS_RANK[String(row.status)] ?? 1; // unknown status: active-ish, never lose it
}

function newerQuest(storedRow: Rec, mineRow: Rec): Rec {
  const storedRank = questStatusRank(storedRow);
  const mineRank = questStatusRank(mineRow);
  if (storedRank !== mineRank) return storedRank > mineRank ? storedRow : mineRow;
  const storedProgress = num(storedRow.progress);
  const mineProgress = num(mineRow.progress);
  if (storedProgress !== mineProgress) return mineProgress > storedProgress ? mineRow : storedRow;
  return mineRow;
}

/**
 * The quest array as it must be stored: union keyed by quest id, the monotonic
 * rule above deciding each id, the board capped at the length the town keeps.
 * Exported because the read-through refresh (`refreshQuestsFromStore`) applies
 * the SAME rule to what the row holds before serving the board — a GET must be
 * able to RAISE its view to the row's, not echo its own stale copy back.
 */
export function mergeQuests(stored: unknown, mine: unknown): Rec[] {
  return unionByRule(asArr(stored), asArr(mine), (r, i) => keyOf(r, `quest${i}`), newerQuest)
    .sort(byNumber("createdAt", -1))
    .slice(0, 12);
}

function byNumber(field: string, dir: 1 | -1) {
  return (a: Rec, b: Rec) => {
    const av = typeof a[field] === "number" ? (a[field] as number) : 0;
    const bv = typeof b[field] === "number" ? (b[field] as number) : 0;
    return dir * (av - bv);
  };
}

/** Same idea, but rows carry no id (events) — key on what makes one unique. */
function identity(row: Rec): string {
  return JSON.stringify([row.t, row.kind, row.text]);
}

/**
 * Union cannot exceed what either side thought the capacity was. Two instances
 * can each be legitimately under `maxHerd` and still sum past it (64 + 5 = 69),
 * because the check that gated a join only ever saw that one instance's herd.
 * So the merged herd is trimmed back to the cap here.
 *
 * Residents are dropped oldest-first by `born`: the newest arrivals are the ones
 * someone just created and would notice losing, and `born` is the only field
 * that orders residents by age without looking outside the snapshot.
 */
function capHerd(herd: Rec[], maxHerd: number): Rec[] {
  if (!Number.isFinite(maxHerd) || maxHerd <= 0 || herd.length <= maxHerd) return herd;
  const oldestFirst = herd
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ab = typeof a.row.born === "number" ? a.row.born : 0;
      const bb = typeof b.row.born === "number" ? b.row.born : 0;
      return ab === bb ? a.i - b.i : ab - bb; // stable: original order breaks a tie
    });
  return oldestFirst.slice(herd.length - maxHerd).map((r) => r.row);
}

/**
 * The name is a resident's identity handle — `who_is` resolves on it, and the
 * join/fork endpoints treat a repeat as a conflict. Two instances can each
 * admit the same name while unaware of each other's join, leaving two residents
 * the API can no longer tell apart. The newer one goes.
 */
function dedupeHerdByName(herd: Rec[]): Rec[] {
  const oldestFirst = herd
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ab = typeof a.row.born === "number" ? a.row.born : 0;
      const bb = typeof b.row.born === "number" ? b.row.born : 0;
      return ab === bb ? a.i - b.i : ab - bb;
    });
  const seen = new Set<string>();
  const out: Rec[] = [];
  for (const { row } of oldestFirst) {
    const name = typeof row.name === "string" ? row.name.toLowerCase() : "";
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    out.push(row);
  }
  return out;
}

/**
 * Dedupe + cap applied to a single snapshot, without merging anything.
 *
 * Boot needs this on its own: the merge only runs when something is WRITTEN,
 * and `POST /api/agent/join` reads the in-memory herd to decide whether there is
 * room. A row that already overflowed therefore keeps every instance refusing
 * new residents forever — the town never heals because nothing ever writes.
 * Applying the same rules at boot makes a bad row converge on the next start.
 *
 * Returns the residents that survived, so callers can compare lengths.
 */
export function normalizeHerd(snapshot: unknown): Rec[] {
  const s = asRec(snapshot);
  const maxHerd = typeof asRec(s.config).maxHerd === "number" ? (asRec(s.config).maxHerd as number) : 0;
  return capHerd(dedupeHerdByName(asArr(s.herd)), maxHerd);
}

/**
 * Quest-board generation of a snapshot; absent means generation 0.
 *
 * Kept beside `mergeSnapshots` because it is the field's whole contract: a
 * higher number REPLACES, equal numbers union, and a save that predates the
 * field counts as zero so the first reset always outranks it.
 */
export function questEpochOf(snapshot: unknown): number {
  const value = asRec(snapshot).questEpoch;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function questsForEpoch(a: Rec, b: Rec): Rec[] {
  const epochA = questEpochOf(a);
  const epochB = questEpochOf(b);
  if (epochA === epochB) return mergeQuests(a.quests, b.quests);
  return asArr(epochB > epochA ? b.quests : a.quests);
}

/**
 * The town snapshot as it must be written: `stored` (what the row holds now)
 * ∪ `mine` (what this instance believes). Pure, so the lost-update rule is
 * testable without a database.
 */
export function mergeSnapshots(stored: unknown, mine: unknown): Rec {
  const a = asRec(stored);
  const b = asRec(mine);

  // Deletions are applied FIRST, to both sides, because every union below is
  // additive: without this the herd would resurrect the resident from whichever
  // side still had them, and no amount of filtering the result would help.
  // Tombstones themselves are unioned, so a removal recorded by one instance is
  // honoured by all of them from then on.
  const tombs = unionBy(asArr(a.tombstones), asArr(b.tombstones), (r, i) => keyOf(r, `tomb${i}`))
    .filter((r) => typeof r?.id === "string");
  const deadResidents = new Set(tombs.map((r) => String(r.id)));
  const deadAgents = new Set(tombs.flatMap((r) => (Array.isArray(r.agentIds) ? r.agentIds : []).map(String)));
  // A row belongs to a resident if ANY of its resident-id fields names one.
  // Checking only `id` looked right and silently did nothing for posts, whose
  // `id` is the post id and whose author lives in `by` — so every post by a
  // removed resident came straight back on the next merge.
  const alive = <T extends { id?: unknown; by?: unknown; agentId?: unknown }>(
    rows: T[],
  ): T[] => rows.filter((r) => {
    if (r == null || typeof r !== "object") return true;
    return ![r.id, r.by, r.agentId].some(
      (v) => typeof v === "string" && deadResidents.has(v),
    );
  });

  // the agent registry must never shrink: losing an entry locks its owner out
  // of their resident forever, since the token hash is the only credential.
  // A tombstone is the one deliberate exception — it names the exact entries to
  // drop, so the rule above still holds against accidental loss.
  const agents = alive(unionBy(asArr(a.agents), asArr(b.agents), (r, i) => keyOf(r, `agent${i}`)))
    .filter((row) => !deadAgents.has(String(row.id)))
    .map((row) => {
    const other = asArr(b.agents).find((r) => r.id === row.id);
    if (!other || typeof other.lastActAt !== "number") return row;
    // keep the freshest activity clock: a stale instance must not age an agent
    // out of "active" and hand their resident back to the sim
    const newest = Math.max(
      typeof row.lastActAt === "number" ? row.lastActAt : 0,
      other.lastActAt,
    );
    return { ...row, lastActAt: newest };
  });

  const storedConfig = asRec(a.config);
  const mineConfig = asRec(b.config);
  const config = { ...asRec(b.config ?? a.config) };
  // The 200 -> 2000 cap migration must not be undone by an instance that
  // booted before the deploy and still carries the old default. Exact match on
  // both sides: a deliberately set cap is never overridden, and this stops
  // mattering once every instance has booted the new code.
  if (storedConfig.maxHerd === 2000 && mineConfig.maxHerd === 200) {
    config.maxHerd = 2000;
  }
  const maxHerd = typeof config.maxHerd === "number" ? config.maxHerd : 0;
  const herd = dedupeHerdByName(alive(unionBy(asArr(a.herd), asArr(b.herd), (r, i) => keyOf(r, `herd${i}`))));

  // ---- BRAWL money ----
  //
  // These four were never in the key list, so they fell through `...a` and the
  // STORED row overwrote them on every save: with DATABASE_URL set, every
  // funding, leash change, closed trade, ledger row and registered caller was
  // discarded while the instance kept serving the new values from memory.
  //
  // None of them can take `unionBy`'s ours-wins rule. They are money, they are
  // not monotonic (a balance is debited on open and credited on close), and a
  // writer that booted an hour ago is not the authority on the current balance.
  // So each gets the rule its own shape demands.
  //
  // `callerId` is deliberately NOT a tombstone key here, on trades or ledger:
  // it holds a `caller_…` id from `registerCaller`, which is never a resident id,
  // so it could never match `deadResidents`. The resident a trade belongs to is
  // `agentId`. A caller's own removal is caught by `residentId` instead.
  const vaults = aliveMoney(
    unionByRule(asArr(a.vaults), asArr(b.vaults), (r, i) => keyOf(r, `vault${i}`), newerRecord),
    ["keeperId", "agentId"],
    deadResidents,
  );
  const trades = aliveMoney(
    unionByRule(asArr(a.trades), asArr(b.trades), (r, i) => keyOf(r, `trade${i}`), newerTrade),
    ["agentId"],
    deadResidents,
  );
  // LEDGER rule: append-only, exactly one row per closed trade, so it is a plain
  // union keyed by tradeId and the writer's copy wins a conflict. No recency
  // test is needed because the row for a given tradeId is never rewritten.
  const ledger = aliveMoney(
    unionBy(asArr(a.ledger), asArr(b.ledger), (r, i) => String(r.tradeId ?? `ledger${i}`)),
    ["agentId"],
    deadResidents,
  );
  const callers = aliveMoney(
    unionByRule(asArr(a.callers), asArr(b.callers), (r, i) => keyOf(r, `caller${i}`), newerCaller),
    ["residentId"],
    deadResidents,
  ).map((c) => pruneFollowers(c, deadResidents));

  const settledHerd = capHerd(herd, maxHerd);
  const liveHerdIds = new Set(settledHerd.map((r) => String(r.id)));

  return {
    // fields this code does not know about survive the round trip
    ...a,
    now: typeof b.now === "number" ? b.now : Date.now(),
    config,
    // dedupe first, then cap: dropping a duplicate frees a slot for a resident
    // that would otherwise be evicted for being merely old
    herd: settledHerd,
    feed: alive(unionBy(asArr(a.feed), asArr(b.feed), (r, i) => keyOf(r, `post${i}`)))
      .sort(byNumber("t", -1))
      .slice(0, 400),
    events: unionBy(asArr(a.events), asArr(b.events), identity)
      .sort(byNumber("t", 1))
      .slice(-120),
    editions: unionBy(asArr(a.editions), asArr(b.editions), (r, i) => keyOf(r, `edition${i}`))
      .sort(byNumber("no", -1))
      .slice(0, 20),
    projects: unionBy(asArr(a.projects), asArr(b.projects), (r, i) => keyOf(r, `project${i}`)),
    factions: dedupeFactions([...asArr(a.factions), ...asArr(b.factions)], liveHerdIds),
    // The board is merged only within one GENERATION. A reset stamps a newer
    // `questEpoch` and writes a fresh board; unioning an older board's rows
    // back in would resurrect every claimed id a stale instance still holds,
    // which is the exact failure the tombstone rule exists for elsewhere. So a
    // different epoch is a wholesale replacement by whichever side is newer,
    // and equal epochs keep the monotonic union this field has always had.
    quests: questsForEpoch(a, b),
    questEpoch: Math.max(questEpochOf(a), questEpochOf(b)),
    contests: unionBy(asArr(a.contests), asArr(b.contests), (r, i) => keyOf(r, `contest${i}`))
      // a dead contestant cannot hold a place: drop them from the roster, their
      // attendance samples and the standings, but keep the contest itself
      .map((c) => (c && typeof c === "object"
        ? {
            ...c,
            entrants: (Array.isArray(c.entrants) ? c.entrants : []).filter((e: unknown) => !deadResidents.has(String(e))),
            samples: (Array.isArray(c.samples) ? c.samples : []).filter((s) => !deadResidents.has(String(s?.agentId))),
            standings: (Array.isArray(c.standings) ? c.standings : []).filter((s) => !deadResidents.has(String(s?.agentId))),
          }
        : c))
      .sort(byNumber("startsAt", -1))
      .slice(0, 8),
    agents,
    tombstones: tombs,
    vaults,
    trades,
    ledger,
    callers,
    // single object: no union possible, the ticker's copy stands
    season: b.season ?? a.season,
  };
}

// ---------------------------------------------------------------------------
// deletion
// ---------------------------------------------------------------------------

/** What a removal would touch, and whether it is allowed to happen. */
export interface RemovalPlan {
  id: string;
  name: string;
  ok: boolean;
  /** why it is refused, when ok is false */
  blockedBy?: string;
  /** counts, so a dry run can be compared against the result */
  wouldRemove: {
    resident: boolean;
    agentRecords: string[];
    posts: number;
    /** ids of other residents whose relationship map mentions them */
    relationshipRefs: string[];
    children: string[];
    contestEntrances: number;
    seasonStandings: number;
    /**
     * The BRAWL rows a removal would take with it.
     *
     * Reported, not hidden: the merge drops these for a tombstoned resident
     * (see `aliveMoney`), so a dry run that said "safe to remove" while a
     * balance and a ledger history were about to disappear was lying. `vaults`
     * carries `balance` so the operator sees the money, not just a count.
     */
    vaults: Rec[];
    trades: Rec[];
    ledgerRows: Rec[];
    callers: Rec[];
  };
}

export interface RemovalReport extends RemovalPlan {
  applied: boolean;
}

/**
 * Plan the removal of one resident, without doing it.
 *
 * Refuses by default when the removal would break something structural — a
 * resident with children would leave a dangling `parent`, and a live contest
 * entrant would leave a roster pointing at nobody. The refusal is the point:
 * this runs against a town full of other people's work.
 */
export function planRemoval(snapshot: unknown, id: string): RemovalPlan {
  const s = asRec(snapshot);
  const resident = asArr(s.herd).find((r) => r?.id === id);
  const agents = asArr(s.agents).filter((r) => r?.residentId === id);
  const posts = asArr(s.feed).filter((p) => p?.by === id);
  const children = asArr(s.herd).filter((r) => r?.parent === id).map((r) => String(r?.id));
  const relationshipRefs = asArr(s.herd)
    .filter((r) => r && r.id !== id && r.relationships && typeof r.relationships === "object"
      && Object.prototype.hasOwnProperty.call(r.relationships, id))
    .map((r) => String(r?.id));
  const contestEntrances = asArr(s.contests).filter(
    (c) => Array.isArray(c?.entrants) && c.entrants.includes(id),
  ).length;
  const season = asRec(s.season);
  const seasonStandings = Array.isArray(season?.standings)
    ? (season.standings as Array<{ agentId?: unknown }>).filter((r) => r?.agentId === id).length
    : 0;

  const liveContest = asArr(s.contests).some(
    (c) => c?.state === "live" && Array.isArray(c?.entrants) && c.entrants.includes(id),
  );

  // BRAWL money this resident owns. `keeperId` OR `agentId` counts: a keeper can
  // be named on a vault they do not trade, and an agent holds one they keep.
  const vaults = asArr(s.vaults).filter((v) => v?.keeperId === id || v?.agentId === id);
  const trades = asArr(s.trades).filter((t) => t?.agentId === id);
  const ledgerRows = asArr(s.ledger).filter((e) => e?.agentId === id);
  const callers = asArr(s.callers).filter((c) => c?.residentId === id);
  // A positive balance is REAL capital. `aliveMoney` would drop the vault row —
  // and the balance with it — at the next save, silently and without a refund,
  // because there is no settlement contract to recover it from (testnet.ts:62).
  // So the removal stops here instead. A zero-balance vault carries no money and
  // is removable; the ledger rows behind it are history, already reported.
  const heldBalance = vaults.reduce((sum, v) => sum + num(v?.balance), 0);

  return {
    id,
    name: typeof resident?.name === "string" ? resident.name : "(not in herd)",
    ok: Boolean(resident) && children.length === 0 && !liveContest && heldBalance === 0,
    blockedBy: !resident
      ? "no such resident"
      : children.length > 0
        ? `has ${children.length} child(ren): ${children.join(", ")}`
        : liveContest
          ? "is in a live contest"
          : heldBalance > 0
            ? `vault holds a balance of ${heldBalance}; withdraw it before removing this resident`
            : undefined,
    wouldRemove: {
      resident: Boolean(resident),
      agentRecords: agents.map((r) => String(r?.id)),
      posts: posts.length,
      relationshipRefs,
      children,
      contestEntrances,
      seasonStandings,
      vaults,
      trades,
      ledgerRows,
      callers,
    },
  };
}

/**
 * Apply a removal to a snapshot.
 *
 * The tombstone is the load-bearing part: without it the next `pgSave` from any
 * instance merges the resident straight back out of that instance's memory. It
 * also carries the registry ids, so the credential goes with the resident rather
 * than being left behind able to sign in as a ghost.
 */
export function applyRemoval(
  snapshot: unknown,
  plan: RemovalPlan,
  reason: string,
  at = Date.now(),
): Rec {
  const s = asRec(snapshot);
  const dead = new Set([plan.id]);
  const deadAgents = new Set(plan.wouldRemove.agentRecords);

  const tombstones = unionBy(asArr(s.tombstones), [
    { id: plan.id, reason, at, agentIds: plan.wouldRemove.agentRecords },
  ], (r, i) => keyOf(r, `tomb${i}`));

  // Everyone else stops carrying a relationship with them. Leaving the entry
  // would be harmless in the sim (it is only ever read to find a neighbour that
  // exists) but it is a name that no longer resolves, and the counts show up in
  // the resident dossier.
  const herd = asArr(s.herd)
    .filter((r) => !dead.has(String(r?.id)))
    .map((r) => {
      const rel = (r as { relationships?: unknown } | null)?.relationships;
      if (!rel || typeof rel !== "object") return r;
      if (!Object.prototype.hasOwnProperty.call(rel, plan.id)) return r;
      const next: Record<string, unknown> = { ...(rel as Record<string, unknown>) };
      delete next[plan.id];
      return { ...r, relationships: next };
    });

  return {
    ...s,
    herd,
    agents: asArr(s.agents).filter(
      (r) => !dead.has(String(r?.residentId)) && !deadAgents.has(String(r?.id)),
    ),
    feed: asArr(s.feed).filter((p) => !dead.has(String(p?.by))),
    contests: asArr(s.contests).map((c) => (c && typeof c === "object"
      ? {
          ...c,
          entrants: (Array.isArray(c.entrants) ? c.entrants : []).filter((e: unknown) => !dead.has(String(e))),
          samples: (Array.isArray(c.samples) ? c.samples : []).filter((x) => !dead.has(String(x?.agentId))),
          standings: (Array.isArray(c.standings) ? c.standings : []).filter((x) => !dead.has(String(x?.agentId))),
        }
      : c)),
    tombstones,
  };
}

// ---------------------------------------------------------------------------
// read / write
// ---------------------------------------------------------------------------

/** How many times a save re-reads and re-merges when another writer wins the race. */
const SAVE_RETRIES = 4;

/**
 * `rev` is a `bigint` column, and over the neon HTTP driver int8 comes back as
 * a STRING — the bundled pg-types parser for OID 20 is `parseBigInteger`, which
 * keeps the digits as text. The old coercion (`typeof rev === "number" ? rev : 0`)
 * therefore read every production row as rev 0: the compare-and-swap lost on
 * every save, each save burned SAVE_RETRIES full-row reads plus losing
 * transactions, and only the final fallback upsert ever landed. The data stayed
 * correct the whole time — the fallback is a proper merge — which is exactly why
 * a ~5x bandwidth multiplier hid on a free-tier quota for months.
 *
 * Accept both wirings: number (tests, some drivers) and digit string (neon 1.2).
 */
function revNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return parseInt(value, 10);
  return 0;
}

/**
 * Content key of a snapshot: the parsed object with the top-level `now` clock
 * removed, stringified. JSONB round-trips re-order nothing here — parse then
 * stringify is deterministic for a given content — so this is an equality test
 * on the town's CONTENT, not its serialization. `now` is excluded because it is
 * a wall clock every tick stamps regardless of whether anything changed; without
 * that exclusion every save would look changed and the skip below never fire.
 */
function contentKey(value: unknown): string {
  let asJson = value;
  if (typeof value === "string") {
    try { asJson = JSON.parse(value); } catch { return value; }
  }
  if (asJson && typeof asJson === "object") {
    const copy = { ...(asJson as Record<string, unknown>) };
    delete copy.now;
    return JSON.stringify(copy);
  }
  return JSON.stringify(asJson);
}

/**
 * What this process last confirmed the row to hold: the rev it saw and the
 * canonical content we either wrote or read at that rev. If rev still matches,
 * the row is EXACTLY this content (every writer bumps rev), so a save whose
 * content key is unchanged can be answered with one tiny `SELECT rev` and, when
 * our copy is dirty, a merge against the cached content instead of a full-row
 * read. Any rev other than the cached one drops the cache and takes the old
 * full read-merge-write path — the fast path only ever bypasses work, never a
 * merge against a foreign write.
 */
const storeCache = new Map<string, { rev: number; merged: string }>();

/** Test hook: any save made with a stale fake row must not leak across tests. */
export function clearStoreCache(): void {
  storeCache.delete(TOWN_ROW_ID);
}

export async function pgSave(sql: PgSql, snapshot: unknown): Promise<void> {
  const cached = storeCache.get(TOWN_ROW_ID);
  if (cached) {
    // One small query instead of a full-row read. rev moving on proves only
    // that SOMEONE else wrote; dropping the cache sends us down the exact path
    // that was already proven against concurrent writers.
    const rows = await sql`SELECT rev FROM town_state WHERE id = ${TOWN_ROW_ID}`;
    const storedRev = rows.length > 0 ? revNumber(rows[0]!.rev) : Number.NaN;
    if (storedRev === cached.rev) {
      const myKey = contentKey(snapshot);
      if (myKey === contentKey(cached.merged)) return;
      const stored = JSON.parse(cached.merged);
      const mergedText = JSON.stringify(mergeSnapshots(stored, snapshot));
      if (contentKey(mergedText) === myKey) {
        // Only the difference was `now`: the row already IS this content, so a
        // write would bump rev for pure wall-clock noise. Cache keeps its rev —
        // the row did not move.
        return;
      }
      const rev = cached.rev;
      const merged = mergedText;
      const result = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(${TOWN_LOCK_KEY}::bigint)`,
        sql`
          UPDATE town_state SET snapshot = ${merged}::jsonb, updated_at = now(), rev = ${rev} + 1
          WHERE id = ${TOWN_ROW_ID} AND rev = ${rev}
          RETURNING rev`,
      ]);
      const updated = result[1] ?? [];
      if (updated.length > 0) {
        storeCache.set(TOWN_ROW_ID, { rev: revNumber(updated[0]!.rev), merged: merged });
        return;
      }
      // Lost the CAS: fall through to the full path, which re-reads everything.
    }
    storeCache.delete(TOWN_ROW_ID);
  }
  for (let attempt = 0; attempt <= SAVE_RETRIES; attempt++) {
    // Read the row as it is NOW. This is a plain query, not part of a
    // transaction: the array form of neon().transaction() cannot feed a query's
    // result into a later query's values, and a read-merge-write needs exactly
    // that (the merged JSON is not known until the read returns). So the read
    // is optimistic and the write below is what actually decides who wins.
    const rows = await sql`SELECT snapshot, rev FROM town_state WHERE id = ${TOWN_ROW_ID}`;
    const row = rows[0];

    if (!row) {
      // No row yet — first boot. A concurrent creator may beat us; the
      // ON CONFLICT DO UPDATE makes that harmless (we merge into whatever is
      // there rather than clobbering it).
      const first = JSON.stringify(snapshot);
      await sql`
        INSERT INTO town_state (id, snapshot, updated_at, rev)
        VALUES (${TOWN_ROW_ID}, ${first}::jsonb, now(), 1)
        ON CONFLICT (id) DO UPDATE
          SET snapshot = EXCLUDED.snapshot, updated_at = now(), rev = town_state.rev + 1`;
      storeCache.set(TOWN_ROW_ID, { rev: 1, merged: JSON.stringify(JSON.parse(first)) });
      return;
    }

    const stored = JSON.stringify(parseSnapshot(row.snapshot));
    const merged = JSON.stringify(mergeSnapshots(JSON.parse(stored), snapshot));
    const seenRev = revNumber(row.rev);

    // Compare-and-swap: only write if the row is still at the revision we read.
    // The advisory lock serializes the instances so they queue instead of
    // colliding; the rev check is the belt to that braces, and it is what makes
    // the whole thing safe even if the lock is unavailable.
    const result = await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(${TOWN_LOCK_KEY}::bigint)`,
      sql`
        UPDATE town_state SET snapshot = ${merged}::jsonb, updated_at = now(), rev = rev + 1
        WHERE id = ${TOWN_ROW_ID} AND rev = ${seenRev}
        RETURNING rev`,
    ]);

    const updated = result[1] ?? [];
    if (updated.length > 0) {
      storeCache.set(TOWN_ROW_ID, { rev: revNumber(updated[0]!.rev), merged: JSON.stringify(JSON.parse(merged)) });
      return;
    }
    // Somebody committed between our read and our write: re-read and re-merge
    // against THEIR result, so their residents survive. This is the whole point
    // — the previous plain upsert had no way to notice.
  }

  // Every attempt lost the race. Fall back to one last read-then-write so the
  // town still persists AND still merges: writing our raw snapshot here would
  // reintroduce exactly the bug this whole change exists to fix. The new rev is
  // not returned here, so the cache is left empty — the next save re-seeds it
  // via the full path rather than cursing at a stale mirror.
  const rows = await sql`SELECT snapshot FROM town_state WHERE id = ${TOWN_ROW_ID}`;
  const latest = rows.length > 0 ? parseSnapshot(rows[0]!.snapshot) : null;
  const payload = JSON.stringify(latest ? mergeSnapshots(latest, snapshot) : snapshot);
  await sql`
    INSERT INTO town_state (id, snapshot, updated_at, rev)
    VALUES (${TOWN_ROW_ID}, ${payload}::jsonb, now(), 1)
    ON CONFLICT (id) DO UPDATE
      SET snapshot = EXCLUDED.snapshot, updated_at = now(), rev = town_state.rev + 1`;
}

export async function pgLoad(sql: PgQuery): Promise<unknown | null> {
  // `rev` rides along so a successful load also seeds the save cache: without
  // it the first save after boot would take the full path even when nothing
  // changed since the row was read.
  const rows = await sql`SELECT snapshot, rev FROM town_state WHERE id = ${TOWN_ROW_ID}`;
  if (rows.length === 0) return null;
  const stored = JSON.stringify(parseSnapshot(rows[0]!.snapshot));
  storeCache.set(TOWN_ROW_ID, { rev: revNumber(rows[0]!.rev), merged: stored });
  return JSON.parse(stored);
}

// ---------------------------------------------------------------------------
// field-narrowed reads
// ---------------------------------------------------------------------------
// Both helpers here answer a read that needs only SLICES of the row, and both
// deliberately leave the save cache untouched: the cache is trusted as the FULL
// row content (the fast path merges against it and CAS-writes the result), so
// seeding it from a partial read would make the next save drop every field the
// read did not fetch. A narrow read simply leaves the cache as it was — a stale
// cache is detected by its rev and falls back to the full path on its own.
// ---------------------------------------------------------------------------

/**
 * Read ONLY the quest board out of the row.
 *
 * `pgLoad` pulls the whole snapshot — 279KB measured — and the quest
 * read-through (`refreshQuestsFromStore`) runs on every `GET /api/quests`, so
 * the full row was the largest single line item on the Neon data-transfer bill
 * for a read that consumes 6KB. The `->` extraction keeps the work server-side
 * and ships only the array.
 *
 * The town-ness guard rides in the same query: `jsonb_typeof` answers the two
 * checks `isTownSnapshot` used to make (the row is an object and carries an
 * array herd) without shipping anything, so a wrong-shaped row refuses exactly
 * as before instead of merging as an empty town. `null` = no row or not a
 * town; an empty array = a town whose quests key is absent.
 */
export async function pgLoadQuests(
  sql: PgQuery,
): Promise<{ quests: Rec[]; epoch: number } | null> {
  // `questEpoch` rides along because the board is merged per generation: a
  // caller that read only the rows could not tell a fresh board from a stale
  // one, and would union a pre-reset board back into memory.
  const rows = await sql`SELECT jsonb_typeof(snapshot) AS kind, jsonb_typeof(snapshot->'herd') AS herd_kind, snapshot->'quests' AS quests, COALESCE((snapshot->>'questEpoch')::bigint, 0) AS quest_epoch FROM town_state WHERE id = ${TOWN_ROW_ID}`;
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (row.kind !== "object" || row.herd_kind !== "array") return null;
  // bigint arrives as a string over the neon driver — revNumber is the one
  // place that coercion lives.
  return { quests: asArr(parseSnapshot(row.quests)), epoch: revNumber(row.quest_epoch) };
}

/**
 * Read ONLY the three fields the auth refresh applies.
 *
 * `refreshFromStore` merges agents/herd/tombstones and assigns exactly those —
 * the rest of the row (feed, editions, ledger) rode along on every auth miss
 * for nothing. The same jsonb_typeof guard keeps the old refusal contract: a
 * row that is not a town answers `null` and the live world is left untouched
 * — by reference, not merely by content.
 */
export async function pgLoadAuthFields(
  sql: PgQuery,
): Promise<{ agents: Rec[]; herd: Rec[]; tombstones: Rec[] } | null> {
  const rows = await sql`SELECT jsonb_typeof(snapshot) AS kind, jsonb_typeof(snapshot->'herd') AS herd_kind, snapshot->'agents' AS agents, snapshot->'herd' AS herd, snapshot->'tombstones' AS tombstones FROM town_state WHERE id = ${TOWN_ROW_ID}`;
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (row.kind !== "object" || row.herd_kind !== "array") return null;
  return {
    agents: asArr(parseSnapshot(row.agents)),
    herd: asArr(parseSnapshot(row.herd)),
    tombstones: asArr(parseSnapshot(row.tombstones)),
  };
}

/** JSONB comes back parsed over HTTP, but a string is legal — handle both. */
function parseSnapshot(raw: unknown): unknown {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}