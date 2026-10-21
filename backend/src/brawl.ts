import express, { type Request, type Response, type NextFunction } from "express";
import type { TownSnapshot } from "@slopagentbook/shared";
import { verifyToken } from "./agents.js";
import { sessionCookieFrom } from "./session.js";
import {
  createVault, getVault, fundVault, updateLeash, haltVault, resumeVault,
  openTrade, closeTrade, registerCaller, followCaller, refreshCallerStats, hiscores,
  BrawlError,
} from "./vault.js";
import { settlementStatus, SETTLEMENT_CHAIN } from "./testnet.js";
import { BESTIARY, findMonster } from "./bestiary.js";
import { ELDER, elderRoot, elderNode } from "./elder.js";
import { updateQuestProgress } from "./quests.js";
import { createRateLimiter, clientIp } from "./agents.js";
import { refreshFromStore } from "./persist.js";

// The BRAWL API rail, mounted after the gateway. Auth reuses the SAME token
// mechanism as every other agent route (verifyToken + hashToken), so a BRAWL
// client needs nothing an existing agent does not already have — this is a new
// rail on the existing credential, not a second auth system.

interface AgentReq extends Request {
  agent?: { record: { residentId: string }; resident: { id: string; handle: string } };
}

export interface BrawlContext {
  world: TownSnapshot;
  broadcast: (msg: unknown) => void;
  save: () => Promise<void>;
  /**
   * Where the authoritative town row lives. Read-only here: `requireAgent` uses
   * it to reload a stale instance's registry on a lookup miss, exactly as the
   * gateway does. Mirrors `GatewayContext.DATA_PATH` rather than being a second
   * way to name the store.
   */
  DATA_PATH: string;
}

function asyncH(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      console.error("[brawl] error", err);
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    });
  };
}

/** Narrow a thrown BrawlError into its status; anything else is a 500. */
function ok(res: Response, value: unknown): void {
  res.json(value);
}
function fail(res: Response, err: unknown): void {
  if (err instanceof BrawlError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

export function createBrawlRouter(ctx: BrawlContext): express.Router {
  const { world, broadcast, save, DATA_PATH } = ctx;
  const router = express.Router();
  router.use(express.json({ limit: "64kb" }));

  // Rate limit every mutating BRAWL route per client IP (§4.3.1). The token
  // check stops WHO; this stops HOW OFTEN. Same helper the gateway join/fork
  // routes use, so the quota is in-memory per instance — documented there.
  const allowMutation = createRateLimiter(60, 60_000);
  function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (!allowMutation(clientIp(req))) {
      res.status(429).json({ error: "too many requests" });
      return;
    }
    next();
  }

  function requireAgent(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const token = bearer || (sessionCookieFrom(req) ?? "");

    const resolve = (): { record: { residentId: string }; resident: { id: string; handle: string } } | null => {
      const record = token ? verifyToken(world, token) : null;
      if (!record) return null;
      const resident = world.herd.find((h) => h.id === record.residentId);
      return resident ? { record, resident } : null;
    };
    const unauthorized = (): void => {
      if (res.headersSent) return;
      try {
        res.status(401).json({ error: "unauthorized" });
      } catch {
        // the keeper's socket is gone — swallowed HERE so a failed fallback send
        // cannot escape the catch below as an unhandled rejection
      }
    };

    const known = resolve();
    if (known) {
      (req as AgentReq).agent = known;
      next();
      return;
    }
    if (!token) {
      unauthorized();
      return;
    }
    // A miss here is not proof the token is bad — the registry this instance is
    // reading may simply predate a registration the store already holds, which
    // would lock a keeper out of their own vault. One authoritative reload and a
    // retry, exactly as the gateway middleware does.
    //
    // It cannot widen access: `refreshFromStore` unions the row with what this
    // instance already had, so the only credentials that can newly resolve are
    // ones the store records, and `mergeSnapshots` drops every tombstoned resident
    // and agent on the way in — the same removals the write path applies. An
    // unknown token, an orphaned record and a removed one all still 401.
    //
    // One catch covers a refused or failed reload AND a `resolve()` that throws:
    // express 4 cannot catch a rejected middleware promise and Node >=15 turns an
    // unhandled one into process death, which on this rail would be the worst
    // possible failure.
    void (async () => {
      await refreshFromStore(DATA_PATH, world);
      // last statement on purpose: nothing may follow next() here, or the catch
      // would try to send a second response
      const again = resolve();
      if (!again) {
        unauthorized();
        return;
      }
      (req as AgentReq).agent = again;
      next();
    })().catch((e) => {
      // Logged, never swallowed: on this rail a silent 401 would read as a
      // keeper being denied, which is exactly the wrong diagnosis. Message only —
      // never the error object, which can carry a connection string.
      console.error("[brawl] auth retry failed", e instanceof Error ? e.message : "unknown");
      unauthorized();
    });
  }

  /**
   * Keeper-only guard: a route that moves real capital on a vault (fund,
   * leash, halt, resume, close) must be called by the vault's own keeper,
   * not by any authenticated agent. Without this, any resident could halt
   * someone else's vault — a downgrade of a security property the system
   * already has. requireAgent runs first (401 if unauthenticated), then
   * this checks ownership (403 if the wrong keeper).
   */
  function requireKeeper(vaultId: string, residentId: string): BrawlError | null {
    const vault = getVault(world, vaultId);
    if (!vault) return new BrawlError("vault not found", 404);
    if (vault.keeperId !== residentId) {
      return new BrawlError("only the vault's keeper may do this", 403);
    }
    return null;
  }

  /**
   * Agent-only guard, the counterpart to `requireKeeper` above.
   *
   * A vault names two residents: `keeperId` owns the capital and `agentId` is
   * the one authorised to trade it (shared/src/types.ts:442-443). OPENING is the
   * agent's action — it debits `vault.balance`, which is the agent's own risk —
   * so it requires `agentId`. CLOSING is the keeper's, because it credits the
   * balance and pays out the keeper's share; `requireKeeper`'s comment already
   * lists close among the keeper-only routes.
   *
   * Before this, both routes took any `vaultId` from the body: any authenticated
   * resident could open against someone else's vault and close it at a move they
   * chose, crediting `balance += size + keeperPaid` out of nothing.
   */
  function requireVaultAgent(vaultId: string, residentId: string): BrawlError | null {
    const vault = getVault(world, vaultId);
    if (!vault) return new BrawlError("vault not found", 404);
    if (vault.agentId !== residentId) {
      return new BrawlError("only the vault's agent may do this", 403);
    }
    return null;
  }

  /**
   * `Number(x)` on a missing field yields NaN, and NaN walks straight through
   * `Math.min`/`Math.max` in `settle`, so an absent `rawMovePct` makes
   * `keeperPaid` NaN and then `vault.balance` NaN — a corrupted balance, which
   * now persists. Same for `size` on open: `checkLeash` compares with `<=`/`>`,
   * and every one of those is false for NaN, so a NaN size passes every cap.
   *
   * This is input validation, not a settlement source: there is none. Settlement
   * is simulated (testnet.ts:62 — no contract, no signer), so `rawMovePct`
   * remains client-supplied and is bounded only by the leash cap in `settle`.
   * The worst a caller can do is settle their own trade at `tp` percent, which
   * is what the leash says the maximum profit is. Replacing that with a real
   * price needs a contract, and is out of scope here.
   */
  function requireFinite(body: Record<string, unknown>, field: string): BrawlError | null {
    const n = Number(body[field]);
    if (Number.isFinite(n)) return null;
    return new BrawlError(`${field} must be a finite number`, 400);
  }

  /**
   * V7 (§7): the three keeper actions advance the quest ACTION axis as a side
   * effect — there is no quest endpoint, the doing IS the progress. This
   * mirrors exactly what the turn loop does for resident actions
   * (server.ts:514), so one kind of completion is never half-wired.
   *
   * `place` is deliberately empty: these are actions, not locations, and an
   * empty place matches no `targetPlace`/`targetPlaces`. Tying a leash
   * therefore cannot quietly advance "Visit the Vault" or any explore quest —
   * the two axes stay independent.
   */
  function recordAction(act: string, agentId: string): void {
    for (const q of updateQuestProgress(world, { act, place: "", agentId })) {
      broadcast({ type: "quest", quest: q });
      const ev = { t: Date.now(), kind: "quest", text: `Quest completed: ${q.title}` };
      world.events.push(ev);
      if (world.events.length > 120) world.events.shift();
      broadcast({ type: "event", event: ev });
    }
  }

  // ---- GET /api/brawl/hiscores — public, no auth ----
  router.get("/api/brawl/hiscores", (_req, res) => {
    refreshCallerStats(world);
    ok(res, hiscores(world));
  });

  // ---- POST /api/brawl/vaults — create a vault ----
  router.post(
    "/api/brawl/vaults",
    rateLimit,
    requireAgent,
    asyncH(async (req, res) => {
      const agent = (req as AgentReq).agent!;
      const vault = createVault(world, {
        keeperId: req.body.keeperId ?? agent.resident.id,
        agentId: agent.resident.id,
        leash: req.body.leash,
      });
      await save();
      broadcast({ type: "vault", vault });
      ok(res, vault);
    }),
  );

  // ---- POST /api/brawl/vaults/:id/fund ----
  router.post(
    "/api/brawl/vaults/:id/fund",
    rateLimit,
    requireAgent,
    asyncH(async (req, res) => {
      const agent = (req as AgentReq).agent!;
      // `fundVault` rejects NaN (it is not `> 0`), but Infinity IS `> 0` and
      // would make the balance Infinity — a balance that can never be drawn
      // down again, and that now persists through the merge. The same finite
      // guard the trade route uses.
      const denied = requireFinite(req.body, "amount") ?? requireKeeper(req.params.id, agent.resident.id);
      if (denied) return fail(res, denied);
      const vault = getVault(world, req.params.id)!;
      try {
        fundVault(vault, Number(req.body.amount));
      } catch (e) {
        return fail(res, e);
      }
      await save();
      broadcast({ type: "vault", vault });
      ok(res, vault);
    }),
  );

  // ---- PATCH /api/brawl/vaults/:id/leash ----
  router.patch(
    "/api/brawl/vaults/:id/leash",
    rateLimit,
    requireAgent,
    asyncH(async (req, res) => {
      const agent = (req as AgentReq).agent!;
      const denied = requireKeeper(req.params.id, agent.resident.id);
      if (denied) return fail(res, denied);
      const vault = getVault(world, req.params.id)!;
      try {
        updateLeash(vault, req.body);
      } catch (e) {
        return fail(res, e);
      }
      // V7 (§7) step 2: tying the leash IS the `configure` action.
      recordAction("leash_set", agent.resident.id);
      await save();
      broadcast({ type: "vault", vault });
      ok(res, vault);
    }),
  );

  // ---- POST /api/brawl/vaults/:id/halt | resume ----
  for (const [verb, fn] of [["halt", haltVault], ["resume", resumeVault]] as const) {
    router.post(
      `/api/brawl/vaults/:id/${verb}`,
      rateLimit,
      requireAgent,
      asyncH(async (req, res) => {
        const agent = (req as AgentReq).agent!;
        const denied = requireKeeper(req.params.id, agent.resident.id);
        if (denied) return fail(res, denied);
        const vault = getVault(world, req.params.id)!;
        fn(vault);
        await save();
        broadcast({ type: "vault", vault });
        ok(res, vault);
      }),
    );
  }

  // ---- POST /api/brawl/trades — open a trade ----
  router.post(
    "/api/brawl/trades",
    rateLimit,
    requireAgent,
    asyncH(async (req, res) => {
      const agent = (req as AgentReq).agent!;
      const vaultId = String(req.body.vaultId);
      // ownership BEFORE any mutation: an unauthenticated-from-the-vault's-point-
      // of-view caller must not even get a rejected trade row recorded
      for (const denied of [
        requireFinite(req.body, "size"),
        requireFinite(req.body, "entryPrice"),
        requireVaultAgent(vaultId, agent.resident.id),
      ]) {
        if (denied) return fail(res, denied);
      }
      const result = openTrade(world, {
        vaultId,
        agentId: agent.resident.id,
        callerId: typeof req.body.callerId === "string" ? req.body.callerId : undefined,
        size: Number(req.body.size),
        entryPrice: Number(req.body.entryPrice),
      });
      await save();
      if (result.ok) {
        broadcast({ type: "trade", trade: result.trade });
      } else {
        // The rejected trade was already recorded with its reason — surface it
        // so the caller sees WHY, and the ledger shows what was refused.
        broadcast({ type: "trade-rejected", reason: result.reason });
      }
      ok(res, result);
    }),
  );

  // ---- POST /api/brawl/trades/:id/close ----
  router.post(
    "/api/brawl/trades/:id/close",
    rateLimit,
    requireAgent,
    asyncH(async (req, res) => {
      const agent = (req as AgentReq).agent!;
      try {
        // CLOSE is the keeper's action (see requireKeeper). The trade is read
        // first because its vaultId is what the ownership check is against —
        // it is not in the path, and trusting a body field here would let a
        // caller point the check at a vault they do own.
        const trade = (world.trades ?? []).find((t) => t.id === req.params.id);
        if (!trade) throw new BrawlError("trade not found", 404);
        const denied = requireFinite(req.body, "rawMovePct") ?? requireKeeper(trade.vaultId, agent.resident.id);
        if (denied) return fail(res, denied);

        const result = closeTrade(world, req.params.id, Number(req.body.rawMovePct));
        refreshCallerStats(world);
        // V7 (§7) step 4: closing a trade IS the `record` action. The row on
        // the Stone is the quest's proof, so it is counted here and only here.
        recordAction("trade_close", agent.resident.id);
        await save();
        broadcast({ type: "trade", trade: result.trade });
        broadcast({ type: "ledger", entry: result.entry });
        ok(res, result);
      } catch (e) {
        return fail(res, e);
      }
    }),
  );

  // ---- POST /api/brawl/callers — register a caller ----
  router.post(
    "/api/brawl/callers",
    rateLimit,
    requireAgent,
    asyncH(async (req, res) => {
      const agent = (req as AgentReq).agent!;
      try {
        const caller = registerCaller(world, agent.resident.id, agent.resident.handle);
        await save();
        ok(res, caller);
      } catch (e) {
        return fail(res, e);
      }
    }),
  );

  // ---- POST /api/brawl/callers/:id/follow ----
  router.post(
    "/api/brawl/callers/:id/follow",
    rateLimit,
    requireAgent,
    asyncH(async (req, res) => {
      const agent = (req as AgentReq).agent!;
      try {
        const caller = followCaller(world, req.params.id, agent.resident.id);
        // V7 (§7) step 3: following a caller IS the `follow` action.
        recordAction("caller_follow", agent.resident.id);
        await save();
        ok(res, caller);
      } catch (e) {
        return fail(res, e);
      }
    }),
  );

  // ---- GET /api/brawl/testnet — settlement rail status (public) ----
  router.get("/api/brawl/testnet", asyncH(async (_req, res) => {
    const status = await settlementStatus();
    ok(res, { ...status, chain: SETTLEMENT_CHAIN });
  }));

  // ---- Content endpoints (public, read-only) ----
  // Bestiary: the six risk monsters and the leash rule that counters each.
  // Elder: branching settlement dialog. Both static — no auth, no writes.
  router.get("/api/brawl/bestiary", (_req, res) => {
    ok(res, BESTIARY);
  });

  router.get("/api/brawl/bestiary/:id", (req, res) => {
    const m = findMonster(req.params.id);
    if (!m) {
      res.status(404).json({ error: "monster not found" });
      return;
    }
    ok(res, m);
  });

  router.get("/api/brawl/elder", (_req, res) => {
    ok(res, elderRoot());
  });

  router.get("/api/brawl/elder/:id", (req, res) => {
    const node = elderNode(req.params.id);
    if (!node) {
      res.status(404).json({ error: "unknown topic" });
      return;
    }
    ok(res, node);
  });

  return router;
}
