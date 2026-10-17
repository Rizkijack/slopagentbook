import { describe, it, expect } from "vitest";
import type { Quest, TownSnapshot } from "@slopagentbook/shared";
import { claimQuestFor, updateQuestProgress } from "../src/quests.js";

// Per-participant quests.
//
// A quest used to carry ONE counter that any resident's action advanced. That
// is fine for a chore ("visit the Market 5 times") and wrong for a job: if a
// worker takes a quest, a stranger walking past the right door finished their
// work. The fix is a single gate — a quest with a `claimedBy` advances for that
// resident and nobody else.
//
// The half of this that is easy to break is the other half. The gate MUST be
// `q.claimedBy && ...`, not `if (q.claimedBy) return` on every quest: an
// unclaimed quest has no claimant and still auto-activates on first progress,
// exactly as it always has. Every save written before this feature exists is a
// wall of unclaimed quests, and if they stopped activating, every one of those
// towns would boot with a board that can never be completed.

function worldWith(...quests: Quest[]): TownSnapshot {
  return { quests } as unknown as TownSnapshot;
}

function available(over: Partial<Quest> = {}): Quest {
  return {
    id: "q" + Math.random().toString(36).slice(2, 9),
    title: "test quest",
    description: "test quest",
    giver: "npc-giver",
    giverName: "Vetch",
    category: "Daily",
    type: "visit",
    targetPlace: "market",
    progress: 0,
    required: 3,
    reward: { text: "x" },
    status: "available",
    difficulty: "easy",
    createdAt: 0,
    expiresAt: null,
    ...over,
  } as Quest;
}

/** One resident's action. Returns the quests that completed on it. */
function act(q: Quest, agentId: string, act = "move", place = "market"): Quest[] {
  return updateQuestProgress(worldWith(q), { act, place, agentId });
}

describe("claimQuestFor — taking a quest on", () => {
  it("activates the quest, stamps the worker, and returns that same quest", () => {
    const q = available();
    const world = worldWith(q);
    const res = claimQuestFor(world, q.id, "agent-7");

    expect(res.ok).toBe(true);
    expect(res.quest).toBe(q);
    expect(q.status).toBe("active");
    expect(q.claimedBy).toBe("agent-7");
    expect(q.claimedAt).toBeGreaterThan(0);
  });

  it("refuses an unknown quest and writes nothing", () => {
    const world = worldWith(available());
    const before = world.quests[0]!.status;
    expect(claimQuestFor(world, "nope", "agent-7").ok).toBe(false);
    expect(world.quests[0]!.status).toBe(before);
    expect(world.quests[0]!.claimedBy).toBeUndefined();
  });

  it("refuses a quest that is not available, whatever the reason", () => {
    // available is the only status a worker may take on. An active quest is
    // somebody's already, a completed one is waiting on payout, a claimed one
    // has been paid — none of them are up for grabs.
    for (const status of ["active", "completed", "claimed"] as const) {
      const world = worldWith(available({ status }));
      const res = claimQuestFor(world, world.quests[0]!.id, "agent-7");
      expect(res.ok, `status ${status} should be refused`).toBe(false);
      expect(res.error).toBeTruthy();
      expect(world.quests[0]!.status).toBe(status);
      expect(world.quests[0]!.claimedBy).toBeUndefined();
    }
  });

  it("will not hand a taken quest to a second worker", () => {
    const q = available();
    const world = worldWith(q);
    expect(claimQuestFor(world, q.id, "first").ok).toBe(true);

    const second = claimQuestFor(world, q.id, "second");
    expect(second.ok).toBe(false);
    // not merely refused — not re-attributed either
    expect(q.claimedBy).toBe("first");
    expect(q.claimedAt).toBe(world.quests[0]!.claimedAt);
  });

  it("survives a save written before the fields existed", () => {
    // An old quest carries no claimedBy and no claimedAt. Claiming must add them
    // rather than assume either was already there.
    const legacy = available();
    delete (legacy as Partial<Quest>).claimedBy;
    delete (legacy as Partial<Quest>).claimedAt;

    const res = claimQuestFor(worldWith(legacy), legacy.id, "fresh");
    expect(res.quest!.claimedBy).toBe("fresh");
    expect(res.quest!.claimedAt).toBeGreaterThan(0);
  });

  it("does not touch progress — taking a quest on is not doing it", () => {
    const q = available({ progress: 0 });
    claimQuestFor(worldWith(q), q.id, "agent-7");
    expect(q.progress).toBe(0);
  });
});

describe("the participant gate — a claimed quest is one resident's", () => {
  it("advances for the claimant", () => {
    const q = available();
    claimQuestFor(worldWith(q), q.id, "agent-7");

    act(q, "agent-7");
    expect(q.progress).toBe(1);
    act(q, "agent-7");
    expect(q.progress).toBe(2);
  });

  it("does NOT advance for anyone else — the whole point", () => {
    const q = available();
    claimQuestFor(worldWith(q), q.id, "agent-7");

    act(q, "agent-7"); // claimant makes 1 of 3
    const others = ["agent-8", "agent-9", "agent-10", "lm1", ""];
    for (const who of others) {
      act(q, who);
    }

    expect(q.progress).toBe(1);
    expect(q.status).toBe("active");
  });

  it("does not let a stranger complete it either", () => {
    // The near-miss: progress staying put is not enough, it must also stay
    // incomplete. A stranger ten actions deep should still be zero completions.
    const q = available({ required: 2 });
    claimQuestFor(worldWith(q), q.id, "agent-7");

    for (let i = 0; i < 10; i++) expect(act(q, "agent-8")).toHaveLength(0);
    expect(q.progress).toBe(0);
    expect(q.status).toBe("active");
    expect(q.completedAt).toBeUndefined();
  });

  it("a stranger does not even auto-activate a claimed quest", () => {
    // claimedBy + available is not a state claimQuestFor produces, but a hand-
    // edited or merged save can hold it. The gate sits above the auto-activate
    // line precisely so "activate it" is the claimant's move, not a bystander's.
    const q = available({ claimedBy: "agent-7" });
    expect(q.status).toBe("available");

    act(q, "agent-8");
    expect(q.status).toBe("available");
    expect(q.progress).toBe(0);

    act(q, "agent-7"); // the owner still activates it
    expect(q.status).toBe("active");
    expect(q.progress).toBe(1);
  });

  it("gates the action axis too, not just the location axis", () => {
    // The gate sits above both axes in the loop, so a BRAWL quest someone else
    // took on is equally closed to a stranger's leash_set.
    const q = available({ type: "configure", targetPlace: undefined, required: 1 });
    claimQuestFor(worldWith(q), q.id, "agent-7");

    const updates = updateQuestProgress(worldWith(q), { act: "leash_set", place: "", agentId: "agent-8" });
    expect(updates).toHaveLength(0);
    expect(q.progress).toBe(0);
    expect(q.status).toBe("active");

    expect(updateQuestProgress(worldWith(q), { act: "leash_set", place: "", agentId: "agent-7" })).toHaveLength(1);
    expect(q.status).toBe("completed");
  });

  it("does not let a stranger claim one by stealing progress through explore", () => {
    // explore writes the hidden _visited set and derives progress from it, so it
    // is the one type whose progress does not come from the shared counter. The
    // gate is above it, but the failure mode is different enough to pin.
    const q = available({ type: "explore", targetPlace: undefined, targetPlaces: ["garden", "square"], required: 2 });
    claimQuestFor(worldWith(q), q.id, "agent-7");

    updateQuestProgress(worldWith(q), { act: "move", place: "garden", agentId: "agent-8" });
    updateQuestProgress(worldWith(q), { act: "move", place: "square", agentId: "agent-8" });
    expect(q.progress).toBe(0);
    expect(q.status).toBe("active");

    updateQuestProgress(worldWith(q), { act: "move", place: "garden", agentId: "agent-7" });
    updateQuestProgress(worldWith(q), { act: "move", place: "square", agentId: "agent-7" });
    expect(q.progress).toBe(2);
    expect(q.status).toBe("completed");
  });
});

describe("the gate is additive — unclaimed quests behave exactly as before", () => {
  // Every save written before this feature exists is a board of unclaimed
  // quests. If they stopped activating, those towns would boot with a board that
  // can never be completed — a silent, permanent, data-shaped regression.

  it("an unclaimed available quest still auto-activates on first progress", () => {
    const q = available();
    expect(q.status).toBe("available");

    act(q, "lm1");
    expect(q.status).toBe("active");
    expect(q.progress).toBe(1);
  });

  it("an unclaimed quest still completes and still reports the completion", () => {
    const q = available({ required: 2 });
    expect(act(q, "lm1")).toHaveLength(0);
    const done = act(q, "lm1");
    expect(done).toHaveLength(1);
    expect(done[0]).toBe(q);
    expect(q.status).toBe("completed");
  });

  it("an unclaimed quest advances for whichever resident gets there first", () => {
    // Not a feature being pinned — the pre-existing behaviour this change must
    // not silently convert. Two different residents, one shared counter.
    const q = available({ required: 3 });
    act(q, "lm1");
    act(q, "lm2");
    act(q, "lm3");
    expect(q.progress).toBe(3);
    expect(q.status).toBe("completed");
  });

  it("the same worker may take the same quest's progress from a legacy save", () => {
    // A quest claimed before this boot (claimedBy present, status still
    // "available" because some older code path set only the id) must still be
    // completable by its owner, or the quest is stranded forever.
    const q = available({ status: "available", claimedBy: "lm1" });
    act(q, "lm1", "move", "market");
    expect(q.progress).toBe(1);
    expect(q.status).toBe("active");
  });
});

/**
 * A quest card that reads "→ The Smithy" is a claim about the world, not
 * decoration, so `work` and `social` only advance for a claimant standing at the
 * building it names. They could be gated because those acts arrive carrying a
 * real `place` — which the action axis deliberately does not, so those three
 * quests are marked advisory in the UI instead of pretending to be gated.
 */
describe("place-gated work and social quests", () => {
  it("a work quest does not advance for its claimant standing somewhere else", () => {
    const q = available({ type: "work", targetPlace: "smithy", required: 2 });
    claimQuestFor(worldWith(q), q.id, "agent-7");

    // same claimant, right verb, wrong building
    const updates = updateQuestProgress(worldWith(q), { act: "work", place: "market", agentId: "agent-7" });
    expect(updates).toHaveLength(0);
    expect(q.progress).toBe(0);
  });

  it("the same work quest advances at the building it names", () => {
    const q = available({ type: "work", targetPlace: "smithy", required: 2 });
    claimQuestFor(worldWith(q), q.id, "agent-7");

    const updates = updateQuestProgress(worldWith(q), { act: "work", place: "smithy", agentId: "agent-7" });
    expect(q.progress).toBe(1);
    expect(updates).toHaveLength(0);
  });

  it("a social quest does not advance for a post made elsewhere", () => {
    const q = available({ type: "social", targetPlace: "press", required: 2 });
    claimQuestFor(worldWith(q), q.id, "agent-7");

    const updates = updateQuestProgress(worldWith(q), {
      act: "say",
      place: "tavern",
      agentId: "agent-7",
      postKind: "post",
    });
    expect(updates).toHaveLength(0);
    expect(q.progress).toBe(0);
  });

  it("a quest from an old save, with no building, still advances anywhere", () => {
    // Every quest names a building now, but a save written before they did must
    // not be left holding jobs that can never be completed. This is the case
    // that makes the gate safe to add at all.
    const q = available({ type: "work", targetPlace: undefined, required: 2 });
    claimQuestFor(worldWith(q), q.id, "agent-7");

    updateQuestProgress(worldWith(q), { act: "work", place: "anywhere-at-all", agentId: "agent-7" });
    expect(q.progress).toBe(1);
  });

  it("a multi-building job accepts any of the buildings it names", () => {
    const q = available({ type: "work", targetPlace: undefined, targetPlaces: ["forge", "kiln"], required: 3 });
    claimQuestFor(worldWith(q), q.id, "agent-7");

    updateQuestProgress(worldWith(q), { act: "work", place: "kiln", agentId: "agent-7" });
    expect(q.progress).toBe(1);

    updateQuestProgress(worldWith(q), { act: "work", place: "foundry", agentId: "agent-7" });
    expect(q.progress).toBe(1);
  });
});

/**
 * The auto-activate used to sit above the matcher, so the first resident action
 * of any kind flipped every quest on the board to `active`. Since claimQuestFor
 * only takes on an `available` quest, that silently made the whole NPC quest
 * feature unreachable in a running town — production showed eight `active`
 * quests and no claimant at all, and no other test noticed.
 */
describe("an unclaimed quest stays claimable", () => {
  it("an event that is nothing to do with a quest leaves it available", () => {
    const q = available({ type: "visit", targetPlace: "smithy", required: 5 });

    // a resident wandering somewhere else entirely
    updateQuestProgress(worldWith(q), { act: "move", place: "tavern", agentId: "somebody-else" });

    expect(q.progress).toBe(0);
    expect(q.status).toBe("available");
  });

  it("so a resident can still take it on afterwards", () => {
    const q = available({ type: "visit", targetPlace: "smithy", required: 5 });
    updateQuestProgress(worldWith(q), { act: "move", place: "tavern", agentId: "somebody-else" });

    // the whole point: the quest is still on the board, not silently taken
    const res = claimQuestFor(worldWith(q), q.id, "agent-7");
    expect(res.ok).toBe(true);
    expect(q.claimedBy).toBe("agent-7");
    expect(q.status).toBe("active");
  });

  it("but it still activates the moment something really does count", () => {
    const q = available({ type: "visit", targetPlace: "smithy", required: 5 });

    updateQuestProgress(worldWith(q), { act: "move", place: "smithy", agentId: "somebody-else" });

    expect(q.status).toBe("active");
    expect(q.progress).toBe(1);
  });
});
