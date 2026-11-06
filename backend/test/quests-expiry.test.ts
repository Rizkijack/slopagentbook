import { describe, it, expect } from "vitest";
import type { Quest, TownSnapshot } from "@slopagentbook/shared";
import { refreshExpiredQuests, QUEST_ACTIVE_TARGET, QUEST_BOARD_CAP } from "../src/quests.js";

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
    expect(statuses.filter((s) => s === "available" || s === "active").length).toBeGreaterThanOrEqual(QUEST_ACTIVE_TARGET);
  });

  it("a board topped up by two instances converges to the slot target, newest kept", () => {
    // two cold instances each generated a full board from the same six live
    // slots; the merge unions them. The extra rows are live, so the history-first
    // cap cannot remove them — the live trim has to.
    const live = (n: number) => quest({ id: "q" + n, status: "available", expiresAt: Date.now() + 60_000 });
    const w = world(Array.from({ length: QUEST_ACTIVE_TARGET + 20 }, (_, i) => live(i)));
    refreshExpiredQuests(w);
    const board = w.quests as unknown as Quest[];
    const lives = board.filter((q) => q.status === "available" || q.status === "active");
    expect(lives.length).toBe(QUEST_ACTIVE_TARGET);
    // generated quests are appended, so the NEWEST rows survive
    expect(board.some((q) => q.id === "q" + (QUEST_ACTIVE_TARGET + 19))).toBe(true);
    expect(board.some((q) => q.id === "q0")).toBe(false);
  });

  it("history is trimmed before live rows at the cap", () => {
    const live = (n: number) => quest({ id: "ql" + n, status: "available", expiresAt: Date.now() + 60_000 });
    const done = (n: number) => quest({ id: "qd" + n, status: "claimed", expiresAt: 1 });
    const w = world([
      ...Array.from({ length: 20 }, (_, i) => done(i)),
      ...Array.from({ length: QUEST_ACTIVE_TARGET }, (_, i) => live(i)),
    ]);
    refreshExpiredQuests(w);
    const board = w.quests as unknown as Quest[];
    expect(board.length).toBeLessThanOrEqual(QUEST_BOARD_CAP);
    expect(board.filter((q) => q.status === "available" || q.status === "active").length).toBe(QUEST_ACTIVE_TARGET);
    // the oldest finished rows are the ones that went
    expect(board.some((q) => q.id === "qd0")).toBe(false);
    expect(board.some((q) => q.id === "qd19")).toBe(true);
  });
});
