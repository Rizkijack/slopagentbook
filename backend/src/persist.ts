import { writeFile, rename, copyFile, mkdir } from "fs/promises";
import { open } from "fs/promises";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { neon } from "@neondatabase/serverless";
import type { TownSnapshot } from "@slopagentbook/shared";
import { pgLoad, pgSave, mergeSnapshots, type PgSql } from "./pgstore.js";

/**
 * A Neon client for the current DATABASE_URL.
 *
 * Exported so tooling and tests reach the database through the same driver and
 * the same connection settings the server uses. A script that opened its own
 * client would be a second, untested write path — and the write path is exactly
 * where this project has shipped a production outage before (a stub that modelled
 * `transaction()` more permissively than the real driver does).
 */
export function pgSql(): PgSql {
  // Lazy + per-call: serverless instances must not hold idle connections.
  // @neondatabase/serverless is fetch-based, so this is cheap.
  return neon(process.env.DATABASE_URL!) as unknown as PgSql;
}

/**
 * Serialises every local save.
 *
 * Two overlapping calls used to race. They shared one temp path, because it was
 * keyed on process.pid alone and nothing else, so the first rename consumed the
 * temp file and the second one found nothing to rename — an ENOENT (or EPERM on
 * Windows) thrown from an `await` inside a setTimeout callback, where there is
 * no caller to catch it. That is an unhandled rejection, and an unhandled
 * rejection takes the whole town server down with it.
 *
 * The visible symptom during development was the backend exiting with
 * `ENOENT: rename 'town.tmp.16248' -> 'town.json'`, after which the file on disk
 * still held the *first* write rather than the last. Two saves racing is not
 * exotic here: the sim ticks on a timer and an acting agent can flush at the
 * same moment.
 *
 * Chaining on one promise fixes both halves. Each call still gets its own temp
 * name, so a stale temp can never be renamed by the wrong writer, and the
 * renames cannot overlap, which matters because Windows refuses a rename onto a
 * file another handle is holding open.
 */
let saveChain: Promise<void> = Promise.resolve();
let saveSeq = 0;

export async function saveAtomically(path: string, data: unknown): Promise<void> {
  if (process.env.DATABASE_URL) {
    await pgSave(pgSql(), data);
    return;
  }
  const run = saveChain.then(
    () => writeAtomically(path, data),
    () => writeAtomically(path, data),
  );
  // Keep the chain alive even if this write fails, so one bad save does not
  // poison every save that follows it.
  saveChain = run.catch(() => {});
  await run;
}

async function writeAtomically(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path.replace(/\.json$/, `.tmp.${process.pid}.${saveSeq++}`);
  const backup = path.replace(/\.json$/, ".backup.json");
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    const fh = await open(tmp, "r");
    try { await fh.sync(); } catch {}
    await fh.close();
  } catch {}
  try {
    await copyFile(path, backup);
  } catch {
    // first write, no backup yet
  }
  await rename(tmp, path);
}

export async function loadWithRecovery(path: string): Promise<unknown> {
  if (process.env.DATABASE_URL) {
    const snap = await pgLoad(pgSql());
    if (snap) return snap;
    throw new Error(`no data at ${path} or backup`);
  }
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    const backup = path.replace(/\.json$/, ".backup.json");
    if (existsSync(backup)) {
      const raw = await readFile(backup, "utf8");
      return JSON.parse(raw);
    }
    throw new Error(`no data at ${path} or backup`);
  }
}

// Debounced batching for routine ticks, immediate flush for forks
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingData: unknown = null;
let pendingPath: string | null = null;

export function saveDebounced(path: string, data: unknown, delayMs = 800): void {
  pendingData = data;
  pendingPath = path;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (pendingPath && pendingData) {
      await saveAtomically(pendingPath, pendingData);
    }
    debounceTimer = null;
  }, delayMs);
}

export function flushDebounced(): Promise<void> | null {
  if (debounceTimer && pendingPath && pendingData) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    return saveAtomically(pendingPath, pendingData);
  }
  return null;
}

// ---------------------------------------------------------------------------
// read-side merge
// ---------------------------------------------------------------------------

/**
 * How long after one reload ATTEMPT the next one is refused.
 *
 * The auth path is reachable without a credential, so "this lookup missed" is
 * something anyone can produce on demand — `GET /api/agent/me` with a random
 * `Bearer` token, or a junk `sabk_session` cookie. Without a floor, each such
 * request costs a full-row read plus a merge of the entire town, and the
 * limiters that do exist run AFTER auth and key on `hashToken(token)`, so every
 * random token gets its own empty bucket and they bound nothing here.
 *
 * shortcut: 1000ms, lower if the store is small enough that a read per second
 * still bites; raise only if a legitimately fresh credential 401s inside the
 * window, which costs that one request and nothing else.
 *
 * Stated plainly because a test pins it: inside the window the ORIGINAL bug is
 * still reachable — a credential registered on another instance during an active
 * cooldown 401s until the window closes, and the request after it resolves. That
 * is the deliberate price of bounding what an anonymous caller can make this
 * instance read.
 */
export const RELOAD_COOLDOWN_MS = 1000;

/** Reload bookkeeping for one world, per the one-world-per-process invariant. */
interface ReloadState {
  /** The read in flight, if any. Callers join it rather than start a second. */
  inFlight: Promise<boolean> | null;
  /** When a reload was last ATTEMPTED — stamped when it starts, not when it lands. */
  lastAttemptAt: number;
}

/**
 * Keyed on the world rather than held in one module-level slot, because
 * `refreshFromStore` takes the world as an argument and a module-level slot
 * would make two worlds share one another's cooldown and one another's in-flight
 * read. server.ts holds exactly one (`let world`, server.ts:56) so this is a
 * single entry in production; the WeakMap keeps it correct if that ever changes,
 * and lets the entry die with the world instead of pinning it.
 *
 * `path` is deliberately NOT part of the key. Every caller passes the same
 * DATA_PATH (the gateway and brawl both get it from server.ts's one module
 * constant), so keying on it would only add a way for two spellings of the same
 * store to stop sharing a cooldown. If a second store were ever introduced, the
 * honest fix is a second argument here — not a key that silently partitions.
 */
const reloadStates = new WeakMap<TownSnapshot, ReloadState>();

/**
 * Re-read the authoritative store and merge it into the live `world`, in place.
 *
 * `pgSave` merges the row with whatever the writer holds, but it only runs when
 * something is WRITTEN — no read path merges. So a warm instance keeps serving
 * from a `world` that predates whatever another instance registered, and a token
 * the store already holds answers 401 there while the next request, landing on a
 * colder instance, answers 200. This is the read side of the same merge: the
 * same loader, the same `mergeSnapshots`, applied onto the SAME object every
 * module holds — `Object.assign`, the pattern `DELETE /api/admin/resident/:id`
 * uses in gateway.ts.
 *
 * What it grants, stated exactly, because an unauthenticated caller can trigger
 * it:
 *
 *  - The merged `agents` list is the union of the store's rows and the rows this
 *    instance already had, minus every id a tombstone names. So the only
 *    credentials that can newly resolve are ones the store records, and an
 *    admin's removal still removes — the registry cannot grow a token nobody
 *    issued, and a tombstoned one stays dead.
 *
 *  - It does MORE than that to the world, and should not pretend otherwise: the
 *    `herd` it applies has already been through `capHerd` and
 *    `dedupeHerdByName`, so an unauthenticated request can still SHRINK this
 *    instance's live residents — a row over `config.maxHerd` drops the oldest
 *    here, and the newer of two same-named residents loses. That is convergence
 *    rather than data loss (the row is authoritative and the next `pgSave`
 *    writes the same union), but it is a real mutation driven by an anonymous
 *    caller, which is why the reload is floored. Nothing else on the world is
 *    touched at all — see `reloadFromStore`.
 *
 * Returns true when the world was actually reloaded. Never rejects, and a caller
 * it refuses (no shared store, a wrong-shaped row, or inside the cooldown) gets
 * `false` — the honest "nothing was reloaded", after which the caller's own
 * retry decides the answer. That is what keeps a genuinely bad token a 401
 * rather than a 500, and keeps a caller that was merely early from being told it
 * succeeded.
 *
 * Skipped without `DATABASE_URL`: there this process IS the store (town.json is
 * written from this same memory), so a reload would be pure overhead.
 */
export async function refreshFromStore(path: string, world: TownSnapshot): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const state = reloadStates.get(world) ?? { inFlight: null, lastAttemptAt: 0 };
  reloadStates.set(world, state);

  // Join an in-flight read rather than refusing: that read is already going to
  // answer with what this caller needs, so refusing here could only ever be
  // wrong. Both paths end at the same answer — the caller's own retry runs
  // either way — but only the join can actually find the token.
  if (state.inFlight) return state.inFlight;
  if (Date.now() - state.lastAttemptAt < RELOAD_COOLDOWN_MS) return false;

  // Stamped BEFORE the read, so the read's own callers (the join above) and any
  // caller arriving after it settles both see a recent attempt.
  state.lastAttemptAt = Date.now();
  state.inFlight = reloadFromStore(path, world).finally(() => {
    state.inFlight = null;
  });
  return state.inFlight;
}

/**
 * Whether a stored row is a town at all.
 *
 * Deliberately LOOSER than the boot guard in server.ts, which requires both an
 * array `herd` and a `config`. `herd` is the one field the merge cannot invent:
 * without it there is no town to merge, and `Object.assign`ing a merged object
 * built from `{}` would leave this instance with an empty half-town. `config` is
 * deliberately not required here because this reload never applies `config` (see
 * `reloadFromStore`), so a row missing it costs nothing — whereas requiring it
 * would refuse to refresh a row this path could have used safely.
 *
 * `{}`, `0`, `[]`, `null` and a JSON string are all refused, so a wrong-shaped
 * row leaves the live world alone.
 */
function isTownSnapshot(value: unknown): value is TownSnapshot {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { herd?: unknown }).herd)
  );
}

async function reloadFromStore(path: string, world: TownSnapshot): Promise<boolean> {
  try {
    const stored = await loadWithRecovery(path);
    if (!isTownSnapshot(stored)) return false;
    const merged = mergeSnapshots(stored, world);
    // Only the three fields AUTH actually reads. This narrowing stays narrow even
    // though the reason it was written has since been fixed: `mergeSnapshots`
    // now merges `vaults`/`trades`/`ledger`/`callers` too, and applying them here
    // would still be wrong, for two reasons that have nothing to do with money
    // being lost.
    //
    // 1. This reload runs because a CREDENTIAL LOOKUP MISSED — an unauthenticated
    //    caller with a random token reaches it. Merging four financial arrays on
    //    that trigger means anonymous traffic drives record reconciliation.
    // 2. A merge result is a union, so applying it would MOVE this instance's
    //    money to the row's view. Refunding and closing are deliberate keeper
    //    actions with their own routes; a credential miss must never quietly
    //    undo one.
    //
    // What auth needs is the registry (`agents`), the residents it resolves
    // against (`herd`), and the tombstones that keep those two honest. Widening
    // this `Object.assign` to "let the merge handle money too" would reopen that
    // hole on every auth miss — keep it at these three.
    Object.assign(world, {
      agents: merged.agents,
      herd: merged.herd,
      tombstones: merged.tombstones,
    });
    return true;
  } catch (e) {
    // message only, never the error object: a raw driver error can carry the
    // connection URL in `cause`, and this runs on a path an anonymous caller can
    // reach. Same rule as the four auth-retry logs.
    console.error("[persist] refresh from store failed", e instanceof Error ? e.message : "unknown");
    return false;
  }
}
