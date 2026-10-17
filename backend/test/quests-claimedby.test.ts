import { describe, it, expect } from "vitest";
import type { Quest, TownSnapshot } from "@slopagentbook/shared";
import { claimQuest } from "../src/quests.js";

// Quest.claimedBy — the only per-agent quest number the town has ever kept.
//
// Until this existed the leaderboard had nothing honest to rank on. `giver` is
// the resident who *posted* the job, and `reward.spirits` is paid out to every
// resident in one loop over world.herd, so any per-agent total had to be
// invented. These pin that the claim is attributed, that it is attributed to the
// claimant rather than the giver, and that an anonymous claim is recorded as
// unknown rather than guessed at.

function worldWith(...quests: Quest[]): TownSnapshot {
  return {
    quests,
    herd: [{ mind: { spirits: 0 } }],
    feed: [],
    events: [],
    projects: [],
  } as unknown as TownSnapshot;
}

function done(id: string, over: Partial<Quest> = {}): Quest {
  return {
    id,
    title: "test quest",
    description: "test quest",
    giver: "npc-giver",
    giverName: "Vetch",
    category: "Daily",
    type: "visit",
    progress: 1,
    required: 1,
    reward: { spirits: 0.25, text: "x" },
    status: "completed",
    difficulty: "easy",
    createdAt: 0,
    expiresAt: null,
    ...over,
  } as Quest;
}

describe("claimQuest records who claimed", () => {
  it("attributes the claim to the caller, not to the quest's giver", () => {
    const world = worldWith(done("q1"));
    const res = claimQuest(world, "q1", "agent-7");

    expect(res.ok).toBe(true);
    expect(res.quest!.claimedBy).toBe("agent-7");
    // the giver is untouched — posting a quest is not doing it
    expect(res.quest!.giver).toBe("npc-giver");
    expect(res.quest!.claimedBy).not.toBe(res.quest!.giver);
  });

  it("leaves claimedBy unset when nobody is known, rather than guessing", () => {
    const world = worldWith(done("q1"));
    const res = claimQuest(world, "q1");

    expect(res.ok).toBe(true);
    expect(res.quest!.claimedBy).toBeUndefined();
    expect("claimedBy" in res.quest!).toBe(false);
  });

  it("still refuses an unfinished or unknown quest, and writes nothing", () => {
    const world = worldWith(done("q1", { status: "available" }), done("q2"));
    expect(claimQuest(world, "q1", "a").ok).toBe(false);
    expect(claimQuest(world, "nope", "a").ok).toBe(false);

    const [q1] = world.quests;
    expect(q1!.claimedBy).toBeUndefined();
    expect(q1!.status).toBe("available");
  });

  it("will not re-attribute a quest that is already claimed", () => {
    const world = worldWith(done("q1", { status: "claimed", claimedBy: "first" }));
    expect(claimQuest(world, "q1", "second").ok).toBe(false);
    expect(world.quests[0]!.claimedBy).toBe("first");
  });

  it("survives a save written before the field existed", () => {
    // Old saves have no claimedBy at all. Reading them must not throw, and
    // claiming one must add the field rather than assume it was there.
    const legacy = done("q1");
    delete (legacy as Partial<Quest>).claimedBy;
    const world = worldWith(legacy);

    expect(claimQuest(world, "q1", "fresh").quest!.claimedBy).toBe("fresh");
  });

  it("still pays the herd-wide reward, which is a separate thing", () => {
    const world = worldWith(done("q1"));
    const before = world.herd[0]!.mind.spirits;
    claimQuest(world, "q1", "agent-7");
    // reward.spirits still goes to everyone — that is the town-wide payout, and
    // claimedBy records the claimant without changing how the reward works
    expect(world.herd[0]!.mind.spirits).not.toBe(before);
  });
});