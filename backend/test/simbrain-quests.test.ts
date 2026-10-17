import { describe, it, expect, afterEach } from "vitest";
import type { Quest, TownSnapshot } from "@slopagentbook/shared";
import { NPC_SKILLS } from "@slopagentbook/shared";
import { decide, setQuestClaimer, questTargetPlace, heldQuest, type DecideContext } from "../src/simbrain.js";
import { runTurn, applyDecision } from "../src/turn.js";
import { createInitialWorld } from "../src/world.js";
import { LOCATION_BY_ID } from "../src/locations.js";

// Quest-seeking in the sim brain.
//
// Before this, a quest was a row on the board that advanced itself: any
// resident who happened to pass the right door moved the counter, no resident
// ever chose the job, and the quest's building was data nobody walked to. These
// pin the two halves of the fix — a resident TAKES a job, then is PULLED toward
// that job's building — and, above everything else, that taking a job never
// costs a resident a meal, a drink or a night of sleep.

const CALM = { hunger: 0.1, thirst: 0.1, tired: 0.1, lonely: 0.1 };

/**
 * The slot quest-seeking occupies — the first rule it is allowed to pre-empt.
 * Derived from the table, never hard-coded, so a rule rename cannot silently
 * make these tests pass against the wrong slot.
 */
const QUEST_SLOT_INDEX = NPC_SKILLS.findIndex((r) => r.id === "busy-graze");
const QUEST_SLOT_RULE = NPC_SKILLS[QUEST_SLOT_INDEX]!.id;
/** rules the quest branch is allowed to displace: its own slot and everything after */
const DISPLACABLE = NPC_SKILLS.slice(QUEST_SLOT_INDEX).map((r) => r.id);
/** the table's unconditional keep-moving rule — where a declined branch lands */
const LAST_RULE = NPC_SKILLS[NPC_SKILLS.length - 1]!.id;
/** every rule ABOVE the quest slot: survival and the wander instinct, none of which may move */
const RULES_ABOVE = NPC_SKILLS.slice(0, QUEST_SLOT_INDEX).map((r) => r.id);

const SELF = {
  id: "r1",
  name: "Vetch",
  traits: [] as string[],
  job: "",
  obsession: "the fence ten paces",
  spirits: 0.2,
  memories: [] as string[],
  relationships: {} as Record<string, number>,
};

function mkQuest(over: Partial<Quest> = {}): Quest {
  return {
    id: "q1",
    title: "Market Errands",
    description: "Visit the market.",
    giver: "r0",
    giverName: "Hux",
    category: "Daily",
    type: "visit",
    targetPlace: "market",
    progress: 0,
    required: 5,
    reward: { text: "+0.15 spirits", spirits: 0.15 },
    status: "available",
    difficulty: "easy",
    createdAt: 0,
    expiresAt: null,
    ...over,
  };
}

function ctxOf(over: Partial<DecideContext> = {}): DecideContext {
  return {
    needs: { ...CALM },
    clock: 0.3, // day: no night-rest rule, whatever the wall clock says
    location: "square",
    nearbyAgents: [],
    rng: () => 0.9,
    self: { ...SELF },
    ...over,
  };
}

/** deterministic rng, the same one decide() is given in production */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A snapshot carrying only the quest board — what a caller with no live world gives us. */
function worldOf(...quests: Quest[]): TownSnapshot {
  return { quests } as unknown as TownSnapshot;
}

afterEach(() => setQuestClaimer(null));

// ---------------------------------------------------------------------------

describe("survival keeps precedence over questing", () => {
  /**
   * The strongest form of the claim: for every seed, a decision that changed
   * only where questing could have changed it — its own slot and the rules at or
   * below it — is the ONLY kind of difference permitted. Any survival rule or
   * the wander instinct that fired first must produce a byte-identical decision
   * with a board in context.
   */
  it("only ever displaces its own slot and below, never a rule above it", () => {
    const profiles = [
      { label: "calm", needs: { ...CALM }, clock: 0.3, spirits: 0.2 },
      { label: "thirsty", needs: { ...CALM, thirst: 0.9 }, clock: 0.3, spirits: 0.2 },
      { label: "hungry", needs: { ...CALM, hunger: 0.95 }, clock: 0.3, spirits: 0.2 },
      { label: "lonely", needs: { ...CALM, lonely: 0.95 }, clock: 0.3, spirits: 0.2 },
      { label: "night", needs: { ...CALM, tired: 0.8 }, clock: 0.85, spirits: 0.2 },
      { label: "despair", needs: { hunger: 0.9, thirst: 0.9, tired: 0.1, lonely: 0.9 }, clock: 0.3, spirits: -0.95 },
    ];
    const jobs = ["", "courier", "baker", "smith"];
    const held = mkQuest({ status: "active", claimedBy: "r1" });

    let questTurns = 0;
    for (const p of profiles) {
      for (const job of jobs) {
        for (let seed = 1; seed <= 60; seed++) {
          const base: Partial<DecideContext> = {
            needs: p.needs,
            clock: p.clock,
            self: { ...SELF, job, spirits: p.spirits },
          };
          const off = decide(ctxOf({ ...base, rng: mulberry32(seed) }));
          const on = decide(ctxOf({ ...base, rng: mulberry32(seed), quests: [held] }));

          if (RULES_ABOVE.includes(off.skill ?? "")) {
            expect(on, `seed ${seed} (${p.label}/${job || "jobless"}): ${off.skill} sits above the quest slot and changed when a quest board was in context`)
              .toEqual(off);
          } else {
            expect(DISPLACABLE, `seed ${seed}: ${off.skill} is neither above the quest slot nor at/below it`).toContain(off.skill);
            if (on.questId) questTurns++;
          }
        }
      }
    }
    // and the branch really does fire — otherwise the loop above proves nothing
    expect(questTurns, "the quest branch never fired in 1440 seeded turns").toBeGreaterThan(50);
  });

  it("a thirsty resident drinks; a hungry one grazes; neither takes a quest", () => {
    const quests = [mkQuest({ status: "available" })];
    const thirsty = decide(ctxOf({ needs: { ...CALM, thirst: 0.9 }, rng: mulberry32(7), quests }));
    expect(thirsty.skill).toBe("drink-water");
    expect(thirsty.questId).toBeUndefined();

    const hungry = decide(ctxOf({ needs: { ...CALM, hunger: 0.95 }, rng: mulberry32(7), quests }));
    expect(hungry.skill).toBe("eat-food");
    expect(hungry.questId).toBeUndefined();

    // and neither one touched the board
    expect(quests[0]!.status).toBe("available");
    expect(quests[0]!.claimedBy).toBeUndefined();
  });

  it("a hungry resident still goes to eat while holding a claimed quest", () => {
    const q = mkQuest({ status: "active", claimedBy: "r1", targetPlace: "market" });
    const d = decide(ctxOf({ needs: { ...CALM, hunger: 0.95 }, quests: [q], rng: mulberry32(3) }));
    expect(d.skill).toBe("eat-food");
    expect(d.act).toBe("graze");
    expect(d.place).not.toBe("market");
  });
});

// ---------------------------------------------------------------------------

describe("taking a quest", () => {
  it("claims one available quest for itself and walks to that quest's building", () => {
    const quests = [mkQuest({ id: "q-market", targetPlace: "market" })];
    const d = decide(ctxOf({ quests }));

    expect(d.questId).toBe("q-market");
    expect(d.place).toBe("market");
    expect(d.reason).toContain("Market Errands");
    expect(quests[0]!.status).toBe("active");
    expect(quests[0]!.claimedBy).toBe("r1");
  });

  it("each quest pulls its resident to its OWN building", () => {
    // the point of the feature: two residents, two quests, two doors
    const quests = [
      mkQuest({ id: "q1", targetPlace: "tavern", status: "active", claimedBy: "r1" }),
      mkQuest({ id: "q2", targetPlace: "vault", status: "active", claimedBy: "r2" }),
    ];
    const a = decide(ctxOf({ quests, self: { ...SELF, id: "r1" } }));
    const b = decide(ctxOf({ quests, self: { ...SELF, id: "r2" } }));
    expect([a.place, b.place]).toEqual(["tavern", "vault"]);
  });

  it("never takes a quest another resident already took", () => {
    // the brain must not even ASK: quests.ts refuses a claimed quest, but a
    // claim call is a mutation attempt, and the filter is what keeps the brain
    // from making one. Asserted against a recording claimer, not the outcome.
    const asked: string[] = [];
    setQuestClaimer((_w, questId) => {
      asked.push(questId);
      return { ok: false, error: "quest already claimed" };
    });
    const quests = [mkQuest({ claimedBy: "r-other" })];
    const d = decide(ctxOf({ quests }));
    expect(d.questId).toBeUndefined();
    expect(DISPLACABLE).toContain(d.skill);
    expect(asked, "the brain asked for a quest that already had a claimant").toEqual([]);
    expect(quests[0]!.status).toBe("available");
  });

  it("does not take a second quest while already working one", () => {
    const quests = [
      mkQuest({ id: "q-held", targetPlace: "tavern", status: "active", claimedBy: "r1" }),
      mkQuest({ id: "q-free", targetPlace: "vault" }),
    ];
    const d = decide(ctxOf({ quests }));
    expect(d.questId).toBe("q-held");
    expect(d.place).toBe("tavern");
    // the free one is left exactly as it was
    expect(quests[1]!.status).toBe("available");
    expect(quests[1]!.claimedBy).toBeUndefined();
  });

  it("picks from the board by roll, and the roll is the only thing it uses", () => {
    // a fresh board per roll: the first claim would otherwise leave the resident
    // holding q-a, and the second roll would (correctly) steer to the quest it
    // already has rather than take another
    const board = () => [
      mkQuest({ id: "q-a", targetPlace: "tavern" }),
      mkQuest({ id: "q-b", targetPlace: "vault" }),
    ];
    // both rolls clear the wander threshold (which sits above the quest slot),
    // so the same turn reaches the board and the roll alone decides which job
    const low = decide(ctxOf({ quests: board(), rng: () => 0.45 }));
    const high = decide(ctxOf({ quests: board(), rng: () => 0.9 }));
    expect(low.questId).toBe("q-a");
    expect(high.questId).toBe("q-b");
  });

  it("a refused claim degrades to the walk below the slot and never throws", () => {
    // the race: another resident takes the quest between the filter and the call
    setQuestClaimer(() => ({ ok: false, error: "quest already claimed" }));
    const quests = [mkQuest()];
    const d = decide(ctxOf({ quests }));
    expect(d.questId).toBeUndefined();
    // busy-graze's own roll (0.9 >= 0.18) declines too, so the walk lands on the
    // table's unconditional keep-moving rule — exactly as it did before quests
    expect(d.skill).toBe(LAST_RULE);
    expect(d.act).toBe("stroll");
    expect(quests[0]!.status).toBe("available");
  });

  it("a claimer that throws does not take the turn down with it", () => {
    setQuestClaimer(() => {
      throw new Error("quests.ts exploded");
    });
    const d = decide(ctxOf({ quests: [mkQuest()] }));
    expect(d.skill).toBe(LAST_RULE);
    expect(LOCATION_BY_ID.has(d.place)).toBe(true);
  });

  it("claims into the live snapshot the caller supplied", () => {
    const quests = [mkQuest()];
    const world = createInitialWorld();
    world.quests = quests;
    const d = decide(ctxOf({ quests: world.quests, worldSnapshot: world }));
    expect(d.questId).toBe("q1");
    expect(world.quests[0]!.claimedBy).toBe("r1");
  });

  it("a resident with no id never claims anything", () => {
    const quests = [mkQuest()];
    const d = decide(ctxOf({ quests, self: undefined }));
    expect(d.questId).toBeUndefined();
    expect(quests[0]!.status).toBe("available");
  });
});

// ---------------------------------------------------------------------------

describe("steering toward the quest's building", () => {
  const heldIn = (q: Partial<Quest>) => mkQuest({ ...q, status: "active", claimedBy: "r1" });

  it("goes to the named building of the quest it holds", () => {
    const d = decide(ctxOf({ quests: [heldIn({ targetPlace: "post" })] }));
    expect(d.place).toBe("post");
    expect(d.questId).toBe("q1");
  });

  it("keeps going back to it, turn after turn", () => {
    const quests = [heldIn({ targetPlace: "clinic" })];
    for (const start of ["square", "barn", "market", "inn", "watchtower"]) {
      expect(decide(ctxOf({ quests, location: start })).place).toBe("clinic");
    }
  });

  it("a multi-place quest walks to the next stop it has not visited", () => {
    const q = heldIn({ type: "explore", targetPlace: undefined, targetPlaces: ["station", "post", "market"] });
    (q as unknown as { _visited: string[] })._visited = ["station"];
    expect(questTargetPlace(q)).toBe("post");
    expect(decide(ctxOf({ quests: [q] })).place).toBe("post");
  });

  it("reads _visited whatever shape an old save left it in", () => {
    const asSet = heldIn({ targetPlaces: ["station", "post"] }) as unknown as { _visited: unknown };
    asSet._visited = new Set(["station"]);
    expect(questTargetPlace(asSet as unknown as Quest)).toBe("post");

    // the shape JSON.stringify(new Set()) actually leaves behind
    const asObject = heldIn({ targetPlaces: ["station", "post"] }) as unknown as { _visited: unknown };
    asObject._visited = {};
    expect(questTargetPlace(asObject as unknown as Quest)).toBe("station");
  });

  it("with every stop visited it holds the named building, else the head of the list", () => {
    const named = heldIn({ targetPlace: "hall", targetPlaces: ["station", "post"] });
    (named as unknown as { _visited: string[] })._visited = ["station", "post"];
    expect(questTargetPlace(named)).toBe("hall");

    const listOnly = heldIn({ targetPlace: undefined, targetPlaces: ["station", "post"] });
    (listOnly as unknown as { _visited: string[] })._visited = ["station", "post"];
    expect(questTargetPlace(listOnly)).toBe("station");
  });

  it("uses the verb that actually advances the quest", () => {
    // read off updateQuestProgress: talk needs a talk, fetch a graze, work a work
    const cases: Array<[Quest["type"], string]> = [
      ["visit", "explore"],
      ["explore", "explore"],
      ["talk", "talk"],
      ["fetch", "graze"],
      ["work", "work"],
      ["social", "talk"],
      ["configure", "wander"],
      ["follow", "wander"],
      ["record", "wander"],
    ];
    for (const [type, act] of cases) {
      const d = decide(ctxOf({ quests: [heldIn({ type, targetPlace: "hall" })] }));
      expect(d.act, `quest type ${type}`).toBe(act);
      expect(d.place).toBe("hall");
    }
  });

  it("still walks to the building while already standing on it", () => {
    // being there is the errand; leaving would waste the turn
    const d = decide(ctxOf({ quests: [heldIn({ targetPlace: "market" })], location: "market" }));
    expect(d.place).toBe("market");
    expect(d.questId).toBe("q1");
  });
});

// ---------------------------------------------------------------------------

describe("old saves and corrupt rows", () => {
  const fallsThrough = (d: ReturnType<typeof decide>) => {
    expect(d.questId, `expected no quest decision, got ${d.questId} → ${d.place}`).toBeUndefined();
    expect(DISPLACABLE, `expected the walk to continue, got ${d.skill}`).toContain(d.skill);
  };

  it("a quest naming no building at all is skipped, never walked to", () => {
    const quests = [mkQuest({ targetPlace: undefined })];
    const d = decide(ctxOf({ quests }));
    fallsThrough(d);
    expect(d.place).not.toBe("undefined");
    expect(LOCATION_BY_ID.has(d.place), `walked to a place the town does not have: ${d.place}`).toBe(true);
    // and it was never claimed — a claim is exclusive, so parking it would be worse
    expect(quests[0]!.status).toBe("available");
    expect(quests[0]!.claimedBy).toBeUndefined();
  });

  it("a quest naming a building this town does not have is skipped", () => {
    const quests = [mkQuest({ targetPlace: "atlantis" })];
    fallsThrough(decide(ctxOf({ quests })));
    expect(quests[0]!.claimedBy).toBeUndefined();
  });

  it("a targetPlaces list that is not a list does not throw", () => {
    const corrupt = mkQuest({ targetPlace: undefined, targetPlaces: {} as unknown as string[] });
    expect(questTargetPlace(corrupt)).toBeUndefined();
    fallsThrough(decide(ctxOf({ quests: [corrupt] })));
  });

  it("a quest row missing entirely from the board is not a crash", () => {
    fallsThrough(decide(ctxOf({ quests: [null as unknown as Quest] })));
    fallsThrough(decide(ctxOf({ quests: [] })));
  });

  it("a quest with a corrupt _visited is skipped, not mis-routed", () => {
    const q = mkQuest({ status: "active", claimedBy: "r1", targetPlaces: ["station", "post"] }) as unknown as { _visited: unknown };
    q._visited = "station";
    expect(questTargetPlace(q as unknown as Quest)).toBe("station"); // unreadable set ⇒ nothing visited yet
  });
});

// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("the same seed produces the same decision, run after run", () => {
    const held = mkQuest({ status: "active", claimedBy: "r1", targetPlace: "tavern" });
    const first = decide(ctxOf({ quests: [held], rng: mulberry32(99) }));
    for (let i = 0; i < 50; i++) {
      expect(decide(ctxOf({ quests: [held], rng: mulberry32(99) }))).toEqual(first);
    }
  });

  it("the destination is the quest's, not the roll's", () => {
    const held = mkQuest({ status: "active", claimedBy: "r1", targetPlace: "vault" });
    // every roll that clears the wander threshold (which sits ABOVE the quest
    // slot) lands on the same door — the roll picks the quest, never the place
    for (let roll = 0.5; roll <= 1; roll += 0.05) {
      expect(decide(ctxOf({ quests: [held], rng: () => roll })).place).toBe("vault");
    }
    // and below it the wander instinct still wins: moving about is not a need,
    // so it keeps its place above questing
    const wanderer = decide(ctxOf({ quests: [held], rng: () => 0.1 }));
    expect(wanderer.skill).toBe("wander-town");
    expect(wanderer.questId).toBeUndefined();
  });

  it("a ctx with no quest board decides exactly as it always did", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const d = decide(ctxOf({ rng: mulberry32(seed) }));
      expect(d.questId).toBeUndefined();
      expect(NPC_SKILLS.map((r) => r.id)).toContain(d.skill);
    }
  });
});

// ---------------------------------------------------------------------------

describe("questTargetPlace / heldQuest read the board, not a copy of it", () => {
  it("heldQuest matches active + claimedBy this resident, and nothing looser", () => {
    const ctx = ctxOf({
      quests: [
        mkQuest({ id: "a", status: "active", claimedBy: "someone-else" }),
        mkQuest({ id: "b", status: "available", claimedBy: "r1" }),
        mkQuest({ id: "c", status: "active", claimedBy: "r1" }),
      ],
    });
    expect(heldQuest(ctx)?.id).toBe("c");
  });

  it("heldQuest is undefined with no board and no self — never a throw", () => {
    expect(heldQuest(ctxOf())).toBeUndefined();
    expect(heldQuest(ctxOf({ quests: [], self: undefined }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

/**
 * The wiring runTurn still needs: decide() is a pure function, so the caller
 * hands it the board. This drives the real runTurn → decide → applyDecision path
 * with exactly that hand-off, which is the shape the two-line change to
 * runTurn's ctx has to have.
 */
describe("runTurn — a resident takes a quest and walks to its door", () => {
  it("the order the town broadcasts names the quest's building", async () => {
    const world = createInitialWorld();
    world.quests = [mkQuest({ id: "q-market", targetPlace: "market" })];
    const agent = world.herd[0]!;
    agent.needs = { ...CALM };
    agent.mind.doing = { ...agent.mind.doing, place: "square", act: "wander" };

    const brain = {
      mode: "sim" as const,
      decide: async (ctx: DecideContext) =>
        decide({ ...ctx, rng: () => 0.9, quests: world.quests, worldSnapshot: world }),
    };

    const { order } = await runTurn(world, agent.id, brain as never);

    expect(order!.place).toBe("market");
    expect(agent.mind.doing.place).toBe("market");
    expect(world.quests[0]!.status).toBe("active");
    expect(world.quests[0]!.claimedBy).toBe(agent.id);
    expect(order!.why).toContain("Market Errands");
  });

  it("the decision it produces survives the applyDecision choke point", () => {
    // place is gated on LOCATION_BY_ID and act on isResidentAct; a quest
    // decision that failed either would be silently rewritten to the old spot.
    const world = createInitialWorld();
    world.quests = [mkQuest({ id: "q-post", targetPlace: "post", type: "talk" })];
    const agent = world.herd[0]!;
    const d = decide(ctxOf({ quests: world.quests, worldSnapshot: world }));

    const res = applyDecision(world, agent, { ...d, reason: d.reason }, { rng: () => 0.9 });
    expect(res.order.place).toBe("post");
    expect(res.order.act).toBe("talk");
    expect(agent.mind.doing.place).toBe("post");
    // the rule table is dual-source and the quest branch is not in it, so the
    // skill is honestly blank rather than a rule id that never fired
    expect(res.order.skill).toBe("");
  });
});