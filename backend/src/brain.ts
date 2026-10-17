import { decide as simDecide, type DecideContext } from "./simbrain.js";
import { spend, recordFailure, recordSuccess, resetIfNewDay } from "./spend.js";

/**
 * A brain that is not the rule table.
 *
 * This is a dependency-injection seam, not an integration. Nothing in this
 * repository constructs one: `createBrain()` is called with no arguments
 * (server.ts), so every decision the town makes comes from `simbrain.ts` walking
 * `NPC_SKILLS`. Tests inject one to exercise the async timing around a slow brain
 * (turn.test.ts).
 */
export type LLMBrain = {
  decide(ctx: DecideContext): Promise<{ act: string; place: string; reason: string; speech?: string }>;
};

/**
 * The town's brain. With nothing injected, it is the rule table and only the
 * rule table.
 *
 * There is no provider here, and there never was a live one. What used to sit in
 * this file was a stub whose every branch threw a hardcoded
 * "LLM 429: no credits remaining — add credits at openai.com/…/billing". It made
 * no request, reached no endpoint, and cost nothing, but it produced a status
 * line naming a provider, a failure count climbing against a quota that was
 * never called, and a link to a billing page that would have changed nothing if
 * followed. `OPENAI_API_KEY` was never set on this deployment either, so the
 * first branch — the one with no key — was the only one that ever ran.
 *
 * An operator reading that output was sent to pay for a call that did not
 * happen. That is why the stub is gone rather than merely unused: the claim was
 * the problem, not the absence of the call.
 *
 * `llm` is still injectable so the fallback path stays real and tested. A brain
 * that throws still falls through to the rules, which is the property that
 * matters — the town must never stop because a decision failed.
 */
export function createBrain(opts?: { llm?: LLMBrain; cap?: number }) {
  const llm = opts?.llm;
  if (opts?.cap !== undefined) spend.cap = opts.cap;
  return {
    get mode(): "llm" | "sim" {
      resetIfNewDay();
      // No brain other than the rule table means no ambiguity about the mode.
      if (!llm) return "sim";
      // "llm" requires proof it works: spend.calls only moves on success, so zero
      // calls means nothing has succeeded today. Reporting "llm" at boot — before a
      // single attempt had been made — sends a reader hunting a problem that has
      // not happened yet.
      if (spend.calls === 0) return "sim";
      if (spend.usd >= spend.cap) return "sim";
      return "llm";
    },
    async decide(ctx: DecideContext) {
      // The default path, and the only one in production: straight to the rules,
      // with no failure recorded and no spend counted, because nothing failed.
      if (!llm) return simDecide(ctx);
      resetIfNewDay();
      if (spend.usd >= spend.cap) {
        return simDecide(ctx);
      }
      try {
        const r = await llm.decide(ctx);
        recordSuccess(0, 0, 0.002);
        return r;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        recordFailure(msg);
        return simDecide(ctx);
      }
    },
  };
}

export type Brain = ReturnType<typeof createBrain>;