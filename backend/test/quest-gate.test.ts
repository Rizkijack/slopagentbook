import { describe, it, expect } from "vitest";
import type { Quest, TownSnapshot } from "@slopagentbook/shared";
import { claimQuestFor, claimQuest, updateQuestProgress, isRegisteredWorker, questRewardInfo } from "../src/quests.js";
import { HOUSE_AGENTS } from "../src/houseagents.js";

/**
 * Operator decision, 2026-10-30: a quest may be taken on, advanced, and
 * finished ONLY by an agent that registered through the register page â€” a live
 * AgentRecord pointing at their resident. The built-in house bots, driven by
 * the sim alone, never touch the board. One gate (isRegisteredWorker) lives at
 * the three doors: progress (updateQuestProgress), take-on (claimQuestFor) and
 * payout (claimQuest with an attributed claimant).
 *
 * The reward contract (questRewardInfo) answers the second half of the same ask:
 * what pays now (spirits) and what pays from where later (the treasury wallet
 * on the coin page, once a mint is deployed).
 */

function quest(over: Partial<Quest> = {}): Quest {
  return {
    id: "q" + Math.random().toString(36).slice(2, 9),
    title: "test quest",
    description: "test quest",
    giver: "board",
    giverName: "Board",
    category: "Daily",
    type: "visit",
    targetPlace: "market",
    progress: 3,
    required: 3,
    reward: { text: "x" },
    status: "completed",
    difficulty: "easy",
    createdAt: 0,
    expiresAt: null,
    ...over,
  } as Quest;
}

function world(quests: Quest[], agents: Array<{ residentId: string }> = []): TownSnapshot {
  // feed/events must exist: a successful claimQuest payout unshifts the board
  // announcement into both
  return { quests, agents, feed: [], events: [] } as unknown as TownSnapshot;
}

describe("isRegisteredWorker*, the one gate", () => {
  it("recognises an agent whose record points at the resident", () => {
    expect(isRegisteredWorker(world([], [{ residentId: "r1" }]), "r1")).toBe(true);
  });

  it("refuses an unregistered resident â€” house bots included", () => {
    expect(isRegisteredWorker(world([], []), "r1")).toBe(false);
    const botId = HOUSE_AGENTS[0]!.id;
    expect(isRegisteredWorker(world([], []), botId)).toBe(false);
  });

  it("a world with no agents key (legacy shape) is not gated", () => {
    // bare fixture/legacy rule, documented at the gate
    expect(isRegisteredWorker({ quests: [] } as unknown as TownSnapshot, "r1")).toBe(true);
  });
});

describe("updateQuestProgress, gated", () => {
  it("ignores a sim-driven resident's event entirely", () => {
    // ACTIVE, not completed: a stopped quest teaches nothing about the gate —
    // the for-loop skips completed quests before any worker check.
    const q = quest({ progress: 3, required: 5, status: "active" });
    const town = world([q], [{ residentId: "registered-1" }]);
    const out = updateQuestProgress(town, { act: "move", place: "market", agentId: "sim-bot-body" });
    expect(out).toEqual([]);
    expect(q.progress).toBe(3);
    expect(q.status).toBe("active");
  });

  it("advances the same quest for the registered agent", () => {
    const q = quest({ progress: 3, required: 5, status: "active" });
    const town = world([q], [{ residentId: "registered-1" }]);
    updateQuestProgress(town, { act: "move", place: "market", agentId: "registered-1" });
    expect(q.progress).toBe(4);
  });
});

describe("claimQuestFor / claimQuest, gated", () => {
  it("a house bot cannot take a quest on", () => {
    const q = quest({ status: "available", progress: 0 });
    const town = world([q], [{ residentId: "someone-else" }]);
    const res = claimQuestFor(town, q.id, HOUSE_AGENTS[0]!.id);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/registered/i);
    expect(q.claimedBy).toBeUndefined();
    expect(q.status).toBe("available");
  });

  it("a registered agent takes the same quest on", () => {
    const q = quest({ status: "available", progress: 0 });
    const town = world([q], [{ residentId: "worker-9" }]);
    expect(claimQuestFor(town, q.id, "worker-9").ok).toBe(true);
    expect(q.claimedBy).toBe("worker-9");
  });

  it("payout refuses an attributed claimant that is not registered", () => {
    const q = quest();
    const town = world([q], [{ residentId: "registered-2" }]);
    const res = claimQuest(town, q.id, "bot-body");
    expect(res.ok).toBe(false);
    expect(q.status).toBe("completed"); // unpaid
  });

  it("the public anonymous claim path is NOT gated (a signed-out person)", () => {
    // no claimant to attribute: the town-wide payout stands, as it always did
    const q = quest();
    const town = world([q], [{ residentId: "registered-2" }]);
    expect(claimQuest(town, q.id).ok).toBe(true);
  });
});

describe("questRewardInfo, the claim contract", () => {
  it("reflects an undeployed mint: spirits now, token later, from the treasury", () => {
    const info = questRewardInfo({
      tokenAddress: "",
      tokenDeployed: false,
      treasuryAddress: "EnS8fknZdYHkJZtGN2HcS3vExJ3fyGqubNeg5Kpr5yBx",
    } as TownSnapshot["config"]);
    expect(info.spirits).toBe(true);
    expect(info.token.deployed).toBe(false);
    expect(info.token.mint).toBeNull();
    expect(info.token.from).toBe("EnS8fknZdYHkJZtGN2HcS3vExJ3fyGqubNeg5Kpr5yBx");
  });

  it("flips on once a mint is deployed, with the treasury paying", () => {
    const info = questRewardInfo({
      tokenAddress: "So11111111111111111111111111111111111111112",
      tokenDeployed: true,
      treasuryAddress: "EnS8fknZdYHkJZtGN2HcS3vExJ3fyGqubNeg5Kpr5yBx",
    } as TownSnapshot["config"]);
    expect(info.token.deployed).toBe(true);
    expect(info.token.mint).toBe("So11111111111111111111111111111111111111112");
  });

  it("answers claimQuest the pure way: claiming never rewrites the contract", () => {
    const q = quest({ rewardToken: undefined } as unknown as Partial<Quest>);
    const town = world([q], [{ residentId: "registered-2" }]);
    claimQuest(town, q.id);
    expect((q as Quest).rewardToken).toBeUndefined();
  });
});
