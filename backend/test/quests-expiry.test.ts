import { describe, it, expect } from "vitest";
import type { Quest, TownSnapshot } from "@slopagentbook/shared";
import { refreshExpiredQuests } from "../src/quests.js";

/**
 * 2026-10-31 — expiry used to be a FILTER (the quest left `world.quests`).
 * Under the shared store that is a delete, and the merge union resurrects a
 * quest the row still holds — expiry never landed on production: the stalled
 * orphan quests rode the loop forever. Now the quest is MARKED `expired`
 * instead, the same answer the herd's tombstones give: removal is state, not
 * absence. These tests pin the marking, the reasons that are never retired
 * (completed/claimed stay board history), and the derived horizon for a save
 * written before `expiresAt` existed.
 */

function quest(over: Partial<Quest> = {}): Quest {
  return {
    id: "q" + Math.random().toString(36).slice(2, 9),
    title: "test quest",
    description: "test quest",
    giver: "board",
    giverName: "Board",
    category: "Daily",
    type: "talk",
    progress: 0,
    required: 3,
    reward: { text: "x" },
    status: "available",
    difficulty: "easy",
    createdAt: 1_000,
    expiresAt: null,
    ...over,
  } as Quest;
}

function world(quests: Quest[]): TownSnapshot {
  // a one-resident herd: the refill floor may generateQuest, and the generator
  // names its giver from here (pick would hit `undefined.id` on an empty one)
  return { quests, herd: [{ id: "r1", name: "R1", mind: {} }] } as unknown as TownSnapshot;
}

describe("refreshExpiredQuests marks, it does not delete", () => {
  it("an expired quest stays on the board with status expired", () => {
    const w = world([quest({ id: "qk1", status: "active", expiresAt: 1 })]);
    refreshExpiredQuests(w);
    const board = w.quests as unknown as Quest[];
    // the refill floor may add fresh quests; the retired one is still PRESENT
    const retired = board.find((q) => q.id === "qk1")!;
    expect(retired).toBeDefined();
    expect(retired.status).toBe("expired");
  });

  it("both available and active quests are retired", () => {
    const w = world([quest({ id: "qk1", status: "available", expiresAt: 1 }), quest({ id: "qk2", status: "active", expiresAt: 1 })]);
    refreshExpiredQuests(w);
    const board = w.quests as unknown as Quest[];
    expect(board.find((q) => q.id === "qk1")!.status).toBe("expired");
    expect(board.find((q) => q.id === "qk2")!.status).toBe("expired");
  });

  it("completed and claimed quests are never retired", () => {
    const w = world([quest({ id: "qk1", status: "completed", expiresAt: 1 }), quest({ id: "qk2", status: "claimed", expiresAt: 1 })]);
    refreshExpiredQuests(w);
    const board = w.quests as unknown as Quest[];
    expect(board.find((q) => q.id === "qk1")!.status).toBe("completed");
    expect(board.find((q) => q.id === "qk2")!.status).toBe("claimed");
  });

  it("a live quest within its horizon is untouched", () => {
    const w = world([quest({ status: "active", expiresAt: Date.now() + 60_000 })]);
    refreshExpiredQuests(w);
    expect((w.quests as unknown as Quest[])[0]!.status).toBe("active");
  });

  it("a quest with no expiresAt (legacy save) dies a day after creation", () => {
    const w = world([quest({ status: "active", createdAt: Date.now() - 25 * 60 * 60 * 1000, expiresAt: null })]);
    refreshExpiredQuests(w);
    expect((w.quests as unknown as Quest[])[0]!.status).toBe("expired");
  });

  it("the refill floor still counts only live quests", () => {
    const w = world([quest({ status: "active", expiresAt: 1 })]);
    refreshExpiredQuests(w);
    const statuses = (w.quests as unknown as Quest[]).map((q) => q.status);
    expect(statuses.filter((s) => s === "available" || s === "active").length).toBeGreaterThanOrEqual(6);
  });
});
