import type { Quest, Resident, Season } from "@slopagentbook/shared";

/**
 * The town leaderboard.
 *
 * The metric is quest points: the `reward.spirits` of every quest a resident has
 * claimed, summed. Until `Quest.claimedBy` existed that number was not
 * recoverable at all — `Quest.giver` is the resident who *posted* the job, and
 * `reward.spirits` is paid out to every resident in one loop over `world.herd`,
 * so a per-agent total had to be invented rather than read. `claimedBy` is now
 * written by both claim paths (the agent gateway knows its resident; the public
 * route resolves the session cookie) and that is the whole basis for this.
 *
 * Contest points are kept as the second column and the second sort key. A town
 * that has claimed no quests yet ranks entirely on them, which is exactly the
 * behaviour you want while the number is still empty — and the number only ever
 * appears where it came from.
 */

export interface LeaderRow {
  id: string;
  name: string;
  /** Sum of reward.spirits over quests this resident has claimed. */
  questPoints: number;
  /** Season standings points — contest ranking, 10/5/1 per Trials win place. */
  points: number;
  wins: number;
  losses: number;
  /** driven by an external agent gateway rather than the internal sim. */
  external: boolean;
}

/** How many rows the card shows. The card is meant to sit in a side column. */
export const LEADER_LIMIT = 8;

export function isExternalAgent(r: Pick<Resident, "mind">): boolean {
  return r.mind?.control === "external";
}

/**
 * Claimed quest value per resident id.
 *
 * Only quests that actually name a claimant count. An anonymous claim through
 * the public route leaves `claimedBy` unset, and crediting that to the quest's
 * giver would be inventing an owner — the giver posted the work, they did not
 * necessarily do it.
 */
export function questPointsBy(quests: Quest[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const q of quests) {
    if (!q.claimedBy || q.status !== "claimed") continue;
    const v = q.reward?.spirits ?? 0;
    if (v === 0) continue;
    m.set(q.claimedBy, (m.get(q.claimedBy) ?? 0) + v);
  }
  return m;
}

/**
 * Rank every resident.
 *
 * The tiebreak chain is quest points, contest points, wins, name, id — the last
 * one so two residents with identical records never swap places between
 * renders. A leaderboard that reorders itself on every snapshot is not a rank.
 */
export function leaderboard(
  herd: Resident[],
  season: Season | undefined,
  quests: Quest[] = [],
  limit = LEADER_LIMIT,
): LeaderRow[] {
  const byAgent = new Map<string, Season["standings"][number]>();
  for (const s of season?.standings ?? []) byAgent.set(s.agentId, s);
  const quest = questPointsBy(quests);

  return herd
    .map((r) => {
      const s = byAgent.get(r.id);
      return {
        id: r.id,
        name: r.name,
        questPoints: quest.get(r.id) ?? 0,
        points: s?.points ?? 0,
        wins: s?.wins ?? 0,
        losses: s?.losses ?? 0,
        external: isExternalAgent(r),
      };
    })
    .sort((a, b) =>
      b.questPoints - a.questPoints
      || b.points - a.points
      || b.wins - a.wins
      || a.name.localeCompare(b.name)
      || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Quest points, to two places — they are fractions, not a score out of 100. */
export function formatQuestPoints(v: number): string {
  return v.toFixed(2);
}

/** One-line caption for the card header: how much of the town is on the board. */
export function leaderboardNote(shown: number, total: number): string {
  if (total === 0) return "no residents";
  return total <= shown ? `${total} resident${total === 1 ? "" : "s"}` : `top ${shown} of ${total}`;
}