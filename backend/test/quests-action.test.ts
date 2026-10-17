import { describe, it, expect } from "vitest";
import type { Quest, TownSnapshot } from "@slopagentbook/shared";
import { QUEST_ACTIONS } from "@slopagentbook/shared";
import { updateQuestProgress, QUEST_TEMPLATES } from "../src/quests.js";

// V7 (§7) — the quest ACTION axis. Quests were keyed by location alone, so
// BRAWL's steps (tie a leash, follow a caller, close a trade) had nowhere to
// land: the type names existed only in prose. The new axis runs BESIDE the
// location one rather than through it, and "beside" is exactly the property
// nothing else in the suite can see — a mistake that let one axis advance the
// other's quests would show up only as a town completing quests nobody earned.

const actionTypes = Object.keys(QUEST_ACTIONS) as (keyof typeof QUEST_ACTIONS)[];

/** updateQuestProgress only touches world.quests — a minimal holder suffices. */
function worldWith(...quests: Quest[]): TownSnapshot {
  return { quests } as unknown as TownSnapshot;
}

function quest(overrides: Partial<Quest> & Pick<Quest, "type">): Quest {
  return {
    id: "q" + Math.random().toString(36).slice(2, 9),
    title: "test quest",
    description: "test quest",
    giver: "lm1",
    giverName: "Vetch",
    category: "Daily",
    progress: 0,
    required: 1,
    reward: { text: "x" },
    status: "active",
    difficulty: "easy",
    createdAt: Date.now(),
    expiresAt: null,
    ...overrides,
  } as Quest;
}

function fire(q: Quest, act: string, place = ""): Quest[] {
  return updateQuestProgress(worldWith(q), { act, place, agentId: "lm1" });
}

describe("V7 action axis — config is the mechanic", () => {
  it("names exactly the three action types", () => {
    expect(actionTypes.sort()).toEqual(["configure", "follow", "record"]);
  });

  it("gives every action type at least one event string", () => {
    for (const type of actionTypes) {
      expect(QUEST_ACTIONS[type], `${type} names no event`).not.toHaveLength(0);
      for (const evt of QUEST_ACTIONS[type]) {
        expect(typeof evt).toBe("string");
        expect(evt.length).toBeGreaterThan(0);
      }
    }
  });

  it("the pool carries a template for every action type", () => {
    // Without a template a type can never appear in a town, so its mechanic
    // would be dead code that no runtime ever exercises.
    const carried = QUEST_TEMPLATES.map((t) => t.type);
    for (const type of actionTypes) {
      expect(carried, `no template of type ${type} — the axis is unreachable`).toContain(type);
    }
  });
});

describe("V7 action axis — the three BRAWL steps progress", () => {
  it.each(actionTypes)("a %s quest completes on its own action", (type) => {
    const q = quest({ type });
    const updated = fire(q, QUEST_ACTIONS[type][0]!);
    expect(q.progress).toBe(1);
    expect(q.status).toBe("completed");
    expect(updated).toContain(q);
  });

  it("counts toward required instead of completing outright", () => {
    const q = quest({ type: "configure", required: 3 });
    fire(q, "leash_set");
    expect(q.progress).toBe(1);
    expect(q.status).toBe("active");
    fire(q, "leash_set");
    expect(q.progress).toBe(2);
    expect(q.status).toBe("active");
    fire(q, "leash_set");
    expect(q.progress).toBe(3);
    expect(q.status).toBe("completed");
  });

  it("keys on the action alone — a place beside it is not required", () => {
    // recordAction() deliberately sends an empty place; the axis must not
    // depend on that being true to fire.
    const q = quest({ type: "follow" });
    fire(q, "caller_follow", "tower");
    expect(q.progress).toBe(1);
  });
});

describe("V7 action axis — the two axes stay independent", () => {
  it("an action event does not advance a location quest", () => {
    const q = quest({ type: "visit", targetPlace: "vault", required: 1 });
    fire(q, "leash_set", "");
    expect(q.progress).toBe(0);
    expect(q.status).toBe("active");
  });

  it("a location event does not advance an action quest", () => {
    const q = quest({ type: "configure" });
    fire(q, "move", "vault");
    expect(q.progress).toBe(0);
    expect(q.status).toBe("active");
  });

  it("an event the config does not name advances nothing", () => {
    // The near-miss string: a refactor that renamed trade_close in one place
    // and not the other must fail here rather than silently stop progressing.
    const q = quest({ type: "record" });
    fire(q, "close_trade");
    expect(q.progress).toBe(0);
  });

  it("the location axis still works exactly as before", () => {
    // Additive-only: the second axis runs beside the first, it does not
    // replace it.
    const q = quest({ type: "visit", targetPlace: "vault", required: 1 });
    fire(q, "move", "vault");
    expect(q.progress).toBe(1);
    expect(q.status).toBe("completed");
  });
});
