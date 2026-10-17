import { describe, it, expect } from "vitest";
import type { Quest, Resident, Season } from "@slopagentbook/shared";
import { LEADER_LIMIT, formatQuestPoints, isExternalAgent, leaderboard, leaderboardNote, questPointsBy } from "../src/views/leaderboard.js";

// The leaderboard on the town page. The metric is season standings, and that
// choice is the whole point of these tests: the town has no per-agent quest
// score (claimQuest records no claimer, and reward.spirits is applied to every
// resident alike), so the honest alternative is contest points labelled as
// such. These pin that it ranks by real per-agent data, that it never invents a
// number, and that it does not reorder itself between renders.

function resident(id: string, over: Partial<Resident> = {}): Resident {
  return {
    id,
    name: id,
    handle: id,
    mind: { doing: { act: "wander", place: "square", placeName: "the square", since: 0, why: "" }, spirits: 0, obsession: "", memories: [], relationships: {} },
    ...over,
  } as unknown as Resident;
}

function external(id: string, over: Partial<Resident> = {}): Resident {
  return resident(id, { mind: { control: "external" } as Resident["mind"], ...over } as Partial<Resident>);
}

function season(standings: Season["standings"]): Season {
  return { id: "s1", no: 3, startedAt: 0, state: "trials", standings };
}

const standing = (agentId: string, points: number, wins = 0, losses = 0) => ({ agentId, points, wins, losses });

describe("leaderboard", () => {
  it("ranks by season points, highest first", () => {
    const board = leaderboard(
      [resident("low"), resident("top"), resident("mid")],
      season([standing("low", 1), standing("top", 10), standing("mid", 5)]),
    );
    expect(board.map((r) => r.id)).toEqual(["top", "mid", "low"]);
    expect(board.map((r) => r.points)).toEqual([10, 5, 1]);
  });

  it("carries wins and losses through next to the score", () => {
    const board = leaderboard([resident("a")], season([standing("a", 16, 2, 1)]));
    expect(board[0]!.wins).toBe(2);
    expect(board[0]!.losses).toBe(1);
  });

  it("puts everyone on the board, not only the ones who scored", () => {
    // A town of 200 with three contestants is not a leaderboard if four-fifths
    // of it is missing. No standing means zero, which is what zero means.
    const herd = [resident("scored"), resident("quiet1"), resident("quiet2")];
    const board = leaderboard(herd, season([standing("scored", 10)]));
    expect(board.map((r) => r.id)).toEqual(["scored", "quiet1", "quiet2"]);
    expect(board.slice(1).map((r) => r.points)).toEqual([0, 0]);
    expect(board.slice(1).map((r) => r.wins)).toEqual([0, 0]);
  });

  it("never invents a score when the save has no season at all", () => {
    const board = leaderboard([resident("a"), resident("b")], undefined);
    expect(board.map((r) => r.points)).toEqual([0, 0]);
    expect(board).toHaveLength(2);
  });

  it("drops a standing whose resident is no longer in the town", () => {
    // standings outlive residents — a removed agent keeps its season record —
    // and a leaderboard is about who is here now, not who once was.
    const board = leaderboard([resident("here")], season([standing("gone", 99), standing("here", 1)]));
    expect(board.map((r) => r.id)).toEqual(["here"]);
  });

  it("breaks ties the same way every time", () => {
    // points, then wins, then name, then id. Without the last one two residents
    // with identical records can swap places between snapshots, and a rank that
    // reshuffles on every SSE push is not a rank.
    const herd = [resident("z", { name: "Zed" }), resident("a", { name: "Ann" }), resident("m", { name: "Mo" })];
    const tied = season([standing("z", 5), standing("a", 5), standing("m", 5)]);
    const first = leaderboard(herd, tied).map((r) => r.id);
    const again = leaderboard([...herd].reverse(), tied).map((r) => r.id);
    expect(first).toEqual(["a", "m", "z"]);       // name wins the tie
    expect(again).toEqual(first);                  // herd order does not matter
  });

  it("prefers wins over name when the points are level", () => {
    const board = leaderboard(
      [resident("a", { name: "Ann" }), resident("z", { name: "Zed" })],
      season([standing("a", 5, 0, 2), standing("z", 5, 1, 0)]),
    );
    expect(board.map((r) => r.id)).toEqual(["z", "a"]);
  });

  it("honours the row limit", () => {
    const herd = Array.from({ length: 40 }, (_, i) => resident(`r${i}`));
    const st = season(herd.map((h, i) => standing(h.id, i)));
    expect(leaderboard(herd, st, [], 8)).toHaveLength(8);
    expect(leaderboard(herd, st).length).toBeLessThanOrEqual(LEADER_LIMIT);
    expect(LEADER_LIMIT).toBe(8);
  });

  it("is empty for an empty town, and does not throw", () => {
    expect(leaderboard([], season([standing("ghost", 99)]))).toEqual([]);
  });
});

describe("registered agent vs built-in NPC", () => {
  it("reads mind.control, the only signal that reaches the browser", () => {
    // GET /api/snapshot drops the whole agent registry (server.ts) because it
    // holds token hashes, so AgentRecord.owner and origin are never available
    // here. control is what the gateway sets and the sim leaves absent.
    expect(isExternalAgent(external("a"))).toBe(true);
    expect(isExternalAgent(resident("n"))).toBe(false);
    expect(isExternalAgent(resident("s", { mind: { control: "sim" } as Resident["mind"] }))).toBe(false);
  });

  it("marks every row, so the board says who is driven by a person", () => {
    const board = leaderboard([external("bot"), resident("npc1")], season([standing("bot", 7), standing("npc1", 3)]));
    expect(board.map((r) => [r.id, r.external])).toEqual([["bot", true], ["npc1", false]]);
  });

  it("does not treat a missing control as external", () => {
    // absent means "the sim drives this", not "unknown, guess agent"
    expect(leaderboard([resident("n")], undefined)[0]!.external).toBe(false);
  });
});

describe("quest points", () => {
  const quest = (id: string, claimedBy: string | undefined, spirits: number, status = "claimed") =>
    ({ id, title: id, description: "", giver: "npc1", giverName: "npc1", type: "visit", category: "Daily", progress: 1, required: 1, reward: { spirits, text: "x" }, status, claimedBy, difficulty: "easy", createdAt: 0, expiresAt: null }) as unknown as Quest;

  it("sums the rewards of the quests a resident actually claimed", () => {
    const m = questPointsBy([
      quest("q1", "a", 0.15), quest("q2", "a", 0.2), quest("q3", "b", 0.35),
    ]);
    expect(m.get("a")).toBeCloseTo(0.35, 10);
    expect(m.get("b")).toBeCloseTo(0.35, 10);
  });

  it("never credits a quest to its giver", () => {
    // giver is whoever posted the job. Crediting a claim to them is how a
    // leaderboard ends up ranking people for work they asked someone else to do.
    const m = questPointsBy([quest("q1", undefined, 0.3)]);
    expect(m.size).toBe(0);
  });

  it("ignores a quest that is not actually claimed", () => {
    const m = questPointsBy([quest("q1", "a", 0.3, "completed"), quest("q2", "a", 0.3, "available")]);
    expect(m.size).toBe(0);
  });

  it("ignores a claim worth nothing", () => {
    const m = questPointsBy([quest("q1", "a", 0)]);
    expect(m.has("a")).toBe(false);
  });

  it("ranks on quest points first, and falls through to contest points when empty", () => {
    const herd = [resident("contestLeader"), resident("claimer"), resident("neither")];
    const st = season([standing("contestLeader", 16, 3, 0)]);

    // with a claimed quest, the claimer outranks a three-time contest winner
    const withQuest = leaderboard(herd, st, [quest("q1", "claimer", 0.5)]);
    expect(withQuest[0]!.id).toBe("claimer");
    expect(withQuest[0]!.questPoints).toBeCloseTo(0.5, 10);

    // with nothing claimed, the board ranks exactly as it did before
    const empty = leaderboard(herd, st, []);
    expect(empty.map((r) => r.id)).toEqual(["contestLeader", "claimer", "neither"]);
    expect(empty.every((r) => r.questPoints === 0)).toBe(true);
  });

  it("does not mutate the quests it reads", () => {
    const qs = [quest("q1", "a", 0.3)];
    const before = JSON.stringify(qs);
    leaderboard([resident("a")], undefined, qs);
    questPointsBy(qs);
    expect(JSON.stringify(qs)).toBe(before);
  });
});

describe("formatQuestPoints", () => {
  it("shows the real fractional total rather than a padded whole number", () => {
    expect(formatQuestPoints(0)).toBe("0.00");
    expect(formatQuestPoints(0.15)).toBe("0.15");
    expect(formatQuestPoints(0.35 + 0.2)).toBe("0.55");
    // 0.15 + 0.2 is 0.35 in decimal but not in binary, so this is the whole
    // reason it formats instead of rounding to an int somewhere
    expect(formatQuestPoints(0.15 + 0.2)).toBe("0.35");
  });
});

describe("leaderboardNote", () => {
  it("says how much of the town is actually on the board", () => {
    expect(leaderboardNote(8, 8)).toBe("8 residents");
    expect(leaderboardNote(1, 1)).toBe("1 resident");
    expect(leaderboardNote(8, 142)).toBe("top 8 of 142");
    expect(leaderboardNote(0, 0)).toBe("no residents");
  });
});