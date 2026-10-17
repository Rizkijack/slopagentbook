import { describe, it, expect } from "vitest";
import { defaultConfig } from "@slopagentbook/shared";
import { createBrain } from "../src/brain.js";
import { spend } from "../src/spend.js";
import type { DecideContext } from "../src/simbrain.js";
import { applyBrainDefault } from "../src/server.js";

/**
 * The town runs its rule table and nothing else.
 *
 * `backend/src/brain.ts` used to hold a stub whose every branch threw a hardcoded
 * "LLM 429: no credits remaining — add credits at openai.com/…/billing". It made no
 * request and cost nothing, but every turn produced a failure line naming a
 * provider and a quota that was never called, and pointed an operator at a
 * billing page that would have changed nothing. There was never a live provider
 * wired, and there is not one now.
 *
 * What is kept is the seam and, more importantly, the fallback: a brain that
 * throws must still hand the town back to the rules, because the town must never
 * stop because a decision failed.
 */

function ctx(over: Partial<DecideContext> = {}): DecideContext {
  return {
    needs: { hunger: 0.2, thirst: 0.2, tired: 0.2, lonely: 0.2 },
    clock: 500,
    location: "square",
    nearbyAgents: [],
    rng: () => 0.5,
    ...over,
  } as DecideContext;
}

describe("the brain with nothing wired", () => {
  it("reports sim, without touching spend or recording a failure", async () => {
    const before = { calls: spend.calls, failures: spend.failures, usd: spend.usd };
    const brain = createBrain();

    expect(brain.mode).toBe("sim");
    const decision = await brain.decide(ctx());

    // a real rule decision, with a real reason drawn from NPC_SKILLS
    expect(typeof decision.act).toBe("string");
    expect(decision.act.length).toBeGreaterThan(0);
    // and nothing was charged or failed, because nothing was attempted
    expect(spend.calls).toBe(before.calls);
    expect(spend.failures).toBe(before.failures);
    expect(spend.usd).toBe(before.usd);
  });

  it("is deterministic under a seeded rng, like every other rule", async () => {
    const a = await createBrain().decide(ctx({ rng: () => 0.42 }));
    const b = await createBrain().decide(ctx({ rng: () => 0.42 }));
    expect(a).toEqual(b);
  });

  it("survival still wins over anything else the brain could pick", async () => {
    // The rule table's first concern, and the one that must not be traded away.
    const thirsty = await createBrain().decide(ctx({ needs: { hunger: 0.1, thirst: 0.95, tired: 0.1, lonely: 0.1 } }));
    const hungry = await createBrain().decide(ctx({ needs: { hunger: 0.95, thirst: 0.1, tired: 0.1, lonely: 0.1 } }));
    expect(thirsty.act).toBe("drink");
    expect(hungry.act).toBe("graze");
  });
});

describe("the injection seam", () => {
  it("still accepts an injected brain, so the fallback stays testable", async () => {
    const brain = createBrain({ llm: { async decide() { return { act: "think", place: "square", reason: "injected" }; } } });
    const decision = await brain.decide(ctx());
    expect(decision.act).toBe("think");
  });

  it("an injected brain that throws hands the town back to the rules", async () => {
    // "The world never stops because a model call failed." This is the property
    // that must survive no matter what is ever wired in later.
    const brain = createBrain({
      llm: { async decide() { throw new Error("provider unreachable"); } },
      cap: 99,
    });
    const decision = await brain.decide(ctx());
    expect(typeof decision.act).toBe("string");
    expect(decision.act.length).toBeGreaterThan(0);
    expect(decision.reason).not.toMatch(/provider unreachable/);
  });

  it("reports sim until an injected brain has actually succeeded once", () => {
    // `spend` is module-global and a sibling test above recorded a success, so
    // this pins the counter itself rather than trusting execution order. Left to
    // run after that test, this one read "llm" while asserting "sim" — which is
    // what a shared-state assertion looks like when nobody resets it.
    const calls = spend.calls;
    try {
      spend.calls = 0;
      expect(createBrain({ llm: { async decide() { throw new Error("x"); } }, cap: 99 }).mode).toBe("sim");
      spend.calls = 5;
      expect(createBrain({ llm: { async decide() { return { act: "think", place: "square", reason: "r" }; } }, cap: 99 }).mode).toBe("llm");
    } finally {
      spend.calls = calls;
    }
  });
});

describe("applyBrainDefault", () => {
  it("carries a town still configured for an LLM onto the rules", () => {
    // The live save carried "llm" from the old default. Nothing read it, but it
    // was reported beside the real mode and read as a model wired and failing.
    const config = { ...defaultConfig, brain: "llm" };
    expect(applyBrainDefault(config)).toEqual(["brain"]);
    expect(config.brain).toBe("sim");
  });

  it("leaves an already-correct town alone", () => {
    const config = { ...defaultConfig };
    expect(applyBrainDefault(config)).toEqual([]);
    expect(config.brain).toBe("sim");
  });

  it("is idempotent, so a second boot has nothing to do", () => {
    // There is no "set by hand" case to preserve here the way there is for the
    // brand and chain fields: the union is exactly "llm" | "sim", so "llm" is
    // always the stale value and "sim" always the current one. What matters
    // instead is that a second pass changes nothing — a reconciler that fires
    // every boot would rewrite the save on every boot.
    const config = { ...defaultConfig, brain: "llm" };
    expect(applyBrainDefault(config)).toEqual(["brain"]);
    expect(applyBrainDefault(config)).toEqual([]);
    expect(config.brain).toBe("sim");
  });

  it("touches nothing else on the config", () => {
    const config = { ...defaultConfig, brain: "llm", name: "SlopAgentbook", tokenAddress: "So111" };
    const before = { ...config };
    applyBrainDefault(config);
    for (const key of Object.keys(before)) {
      if (key === "brain") continue;
      expect(config[key], `${key} must not change`).toBe(before[key]);
    }
  });
});