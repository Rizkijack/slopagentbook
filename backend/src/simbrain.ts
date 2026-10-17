import { isNight } from "./needs.js";
import type { Post, TownEvent, Quest, QuestType, TownSnapshot } from "@slopagentbook/shared";
import * as Quests from "./quests.js";
import { LOCATION_BY_ID } from "./locations.js";
import {
  NPC_SKILLS,
  NPC_THRESHOLDS,
  NPC_SOCIAL_PLACES,
  NPC_FOOD_PLACES,
  NPC_REST_PLACES,
  NPC_WORK_PLACES,
  NPC_ALL_PLACES,
  NPC_WATER_PLACES,
  NPC_JOB_HOMES,
  type NpcRuleContext,
  type NpcSkillRule,
} from "@slopagentbook/shared";

export interface DecideContext {
  needs: { hunger: number; thirst: number; tired: number; lonely: number };
  clock: number;
  location: string;
  nearbyAgents: string[];
  rng: () => number;
  // richer context (optional for backward compat)
  self?: {
    id: string;
    name: string;
    traits: string[];
    job: string;
    obsession: string;
    spirits: number;
    memories: string[];
    relationships: Record<string, number>;
  };
  nearbyDetailed?: Array<{ id: string; name: string; handle: string; relationship: number }>;
  world?: { feed: Post[]; events: TownEvent[]; projects: Array<{ name: string; progress: number }> };
  /**
   * The town quest board, when the caller has one.
   *
   * Optional and additive: every existing caller (the scheduler, the agent
   * gateway, the LLM brain) omits it, and then `decide()` behaves exactly as it
   * did before quests existed — the quest branch never runs and not one existing
   * rule's roll changes. When it IS set, a resident first tries to take a quest
   * that nobody else has taken, and thereafter steers its idle turns toward
   * that quest's own building.
   */
  quests?: Quest[];
  /**
   * The live snapshot, when the caller holds one. Handed to `claimQuestFor`
   * so a claim is written into the same world object the turn will be applied
   * to. Without it the brain falls back to a quests-only view (see
   * `questWorld`) — enough for the claim contract, nothing more.
   */
  worldSnapshot?: TownSnapshot;
}

export interface Decision {
  act: string;
  place: string;
  reason: string;
  speech?: string;
  replyTo?: string | null;
  targetId?: string | null; // for relationship update
  /** id of the NPC_SKILLS rule that produced this decision (skills/npc-agent) */
  skill?: string;
  /**
   * The quest this decision is working on, when the decision came from the
   * quest branch. A quest decision carries no `skill`: the rule table is
   * dual-source (shared/src/skills.ts + skills/npc-agent/SKILL.md) and the
   * quest branch is deliberately not a row in it, so naming a skill id it does
   * not belong to would be a lie the UI would print.
   */
  questId?: string;
}

// Expanded conversational templates - realistic town gossip, bilingual flavor
const TEMPLATES = [
  "the cart is late.",
  "made the case at the square. nobody conceded much.",
  "say that at the hall and see what happens",
  "still owes the mill three sacks",
  "the south meadow tastes different today",
  "nobody moved all morning.",
  "the fence must move ten paces",
  "rain over the east meadow again — who saw it coming?",
  "the vault key is not where we left it",
  "heard that at the baths, not sure I buy it",
  "south meadow vs west meadow? seriously?",
  "pond south side tasted wrong today",
  "market was empty before noon",
];

const CONVERSATION_STARTERS = [
  "{name}, {obsession} still not sorted, huh?",
  "hey {name}, see {obsession} at {place} earlier?",
  "{name} — the {obsession} is getting worse",
  "you were at {place}, right {name}? saw the whole thing",
  "still thinking about {obsession} since this morning",
  "{name} owes me an answer about the fence",
  "heard {name} talking about {obsession} at the tavern",
  "the {obsession} — nobody wants to talk about it, but we should",
  "honest talk {name}, south meadow does taste different today",
  "ran into {name} at {place}, talking {obsession} again",
];

const REPLY_TEMPLATES = [
  "yeah {name}, I think so too about {obsession}",
  "don't agree {name}, {place} is not the spot",
  "hah {name}? the {obsession} again?",
  "fair {name}, but what does that have to do with {place}?",
  "{name}, you said that at the square and it didn't help",
  "agree with {name} — {obsession} is the real problem",
  "ah {name}, you always bring up {obsession}",
  "listen to {name} at {place} earlier, had a point too",
];

const WANDER_THOUGHTS = [
  "take a stroll first, maybe there is news",
  "wandering over to {place}, might run into {name}",
  "bored — just heading to {place}",
  "need to clear my head, heading to {place}",
  "meadow calls, even the sour one",
  "pond south side? curious",
];

/**
 * Callbacks: quote back what this resident actually remembers about the person
 * in front of them. Every other pool is a fixed string, so a resident could talk
 * to the same neighbour all day without ever acknowledging a word they'd heard
 * from them. `{said}` is a real line out of self.memories, which is what makes
 * the tie visible on the canvas and in the feed.
 */
const CALLBACK_TEMPLATES = [
  '{name} — still "{said}"?',
  '{name}. "{said}". that is still the whole of it.',
  'remember {name}? "{said}"',
  '{name}, "{said}" — we never finished that.',
];

/** The most recent remembered line that names `person`. */
function recallAbout(person: string, memories: string[] | undefined): string | undefined {
  if (!memories?.length) return undefined;
  const needle = person.toLowerCase();
  for (const m of memories) {
    if (!m.toLowerCase().includes(needle)) continue;
    // quotes would break the template's own quoting
    const clean = m.replace(/["“”]/g, "").trim();
    if (clean.length > 4) return clean;
  }
  return undefined;
}

function traitHas(traits: string[] | undefined, t: string): boolean {
  return !!traits && traits.includes(t);
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function pickTemplate(rng: () => number): string | undefined {
  if (rng() < 0.35) return pick(TEMPLATES, rng);
  return undefined;
}

function fillTemplate(tpl: string, vars: Record<string, string>): string {
  let s = tpl;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

function generateSpeech(ctx: DecideContext, act: string, place: string): { text?: string; targetId?: string | null } {
  const rng = ctx.rng;
  const self = ctx.self;
  const nearby = ctx.nearbyDetailed ?? [];
  const obsession = self?.obsession ?? "the fence ten paces";
  const placeName = place;

  // Decide if we should speak at all
  let baseChance = 0.18;
  if (act === "talk" || act === "argue") baseChance = nearby.length > 0 ? 0.68 : 0.45;
  else if (act === "wander" || act === "stroll") baseChance = 0.22;
  else if (act === "graze") baseChance = 0.12;
  else if (act === "work") baseChance = nearby.length > 0 ? 0.35 : 0.08;

  // traits adjust
  if (traitHas(self?.traits, "cheerful")) baseChance += 0.12;
  if (traitHas(self?.traits, "gruff")) baseChance -= 0.08;
  if (traitHas(self?.traits, "dreamy")) baseChance -= 0.05;
  if (traitHas(self?.traits, "inquisitive") && act === "wander") baseChance += 0.1;

  if (rng() > baseChance) return {};

  // pick target if nearby
  let target: { id: string; name: string } | null = null;
  if (nearby.length > 0) {
    // prefer higher relationship
    const sorted = [...nearby].sort((a, b) => (b.relationship ?? 0) - (a.relationship ?? 0));
    // 60% pick most liked, 40% random
    if (rng() < 0.6) target = sorted[0]!;
    else target = pick(nearby, rng);
  }

  const vars = {
    name: target?.name ?? pick(["Vetch", "Hux", "Marrow", "Sedge"], rng),
    obsession,
    place: placeName,
  };

  let pool: string[];
  // A callback needs someone to recall, and a real memory of them. Checked before
  // the generic pools so a resident who remembers you answers you, not the crowd.
  const said = target ? recallAbout(target.name, self?.memories) : undefined;
  if (target && said && rng() < 0.55) {
    const text = fillTemplate(pick(CALLBACK_TEMPLATES, rng), { ...vars, said });
    return { text, targetId: target.id };
  }

  if (act === "argue" && target) pool = REPLY_TEMPLATES;
  else if (nearby.length > 0 && rng() < 0.55) pool = CONVERSATION_STARTERS;
  else if (act === "wander" || act === "stroll") pool = WANDER_THOUGHTS;
  else pool = TEMPLATES;

  const tpl = pick(pool, rng);
  const text = fillTemplate(tpl, vars);
  return { text, targetId: target?.id ?? null };
}

// Place groups, job homes and thresholds live in shared/src/skills.ts (the
// npc-agent skill's rules-as-data). decide() below is a walker over NPC_SKILLS.

/**
 * Per-rule action: returns null when the rule declines at runtime (its roll
 * failed or the destination is the current spot) so the chain continues with
 * the next rule — identical to the old fall-through behaviour.
 */
type RuleHandler = (ctx: DecideContext, rule: NpcSkillRule) => Decision | null;

// keyed by the rule-id union: a rule without a handler is a compile error,
// never a silent runtime skip
const RULE_HANDLERS: Record<NpcSkillRule["id"], RuleHandler> = {
  // 1. Night sleep drive — instinct to rest
  "rest-night": (ctx, rule) => {
    const traits = ctx.self?.traits ?? [];
    // dreamy/cheerful may stay up a bit longer at fire/tavern
    if (traitHas(traits, "cheerful") && ctx.clock < NPC_THRESHOLDS.nightFireClock && ctx.rng() < 0.3) {
      const speech = generateSpeech(ctx, "talk", "fire").text;
      return { act: "talk", place: "fire", reason: rule.reasons[0]!, speech };
    }
    return { act: "sleep", place: "barn", reason: rule.reasons[1]! };
  },

  // 2. Thirst — survival instinct
  "drink-water": (ctx, rule) => {
    const traits = ctx.self?.traits ?? [];
    // gruff prefers pond isolation
    const pondBias = traitHas(traits, "gruff") ? NPC_THRESHOLDS.pondBiasGruff : NPC_THRESHOLDS.pondBias;
    if (ctx.rng() < pondBias) {
      const place = NPC_WATER_PLACES[0];
      const g = generateSpeech(ctx, "drink", place);
      return { act: "drink", place, reason: rule.reasons[0]!, speech: g.text, targetId: g.targetId };
    }
    const place = NPC_WATER_PLACES[1];
    const g = generateSpeech(ctx, "drink", place);
    return { act: "drink", place, reason: rule.reasons[1]!, speech: g.text, targetId: g.targetId };
  },

  // 3. Hunger — food instinct, job influences
  "eat-food": (ctx, rule) => {
    const job = ctx.self?.job;
    let opts: string[] = [...NPC_FOOD_PLACES];
    // herder/baker bias
    if (job === "herder" && ctx.rng() < 0.3) opts = ["meadowW", "meadowW", "meadowE", "trough"];
    if (job === "baker" && ctx.rng() < 0.4) opts = ["trough", "trough", "market", "orchard"];
    const place = pick(opts, ctx.rng);
    const reason =
      place === "meadowW" ? rule.reasons[0]! :
      place === "meadowE" ? rule.reasons[1]! :
      place === "orchard" ? rule.reasons[2]! :
      rule.reasons[3]!;
    const g = generateSpeech(ctx, "graze", place);
    return { act: "graze", place, reason, speech: g.text, targetId: g.targetId };
  },

  // 4. Social — lonely instinct, spirits & traits affect
  "seek-company": (ctx, rule) => {
    const traits = ctx.self?.traits ?? [];
    const opts = NPC_SOCIAL_PLACES;
    const place = pick(opts, ctx.rng);
    const isArgueBase = ctx.rng() < 0.38;
    // traits: stubborn/gruff more argue, cheerful/unflappable less
    let argueChance = isArgueBase ? 0.5 : 0;
    if (traitHas(traits, "stubborn") || traitHas(traits, "gruff")) argueChance += 0.25;
    if (traitHas(traits, "cheerful") || traitHas(traits, "unflappable")) argueChance -= 0.18;
    const act = ctx.rng() < argueChance ? "argue" : "talk";
    const g = generateSpeech(ctx, act, place);
    return { act, place, reason: rule.reasons[0]!, speech: g.text, targetId: g.targetId };
  },

  // 5. Spirits low -> seek comfort or lash out (55% of eligible turns decline)
  "low-spirits": (ctx, rule) => {
    if (ctx.rng() >= NPC_THRESHOLDS.lowSpiritsChance) return null;
    // low spirits: either isolate at barn/pond or argue
    if (ctx.rng() < 0.5) {
      const g = generateSpeech(ctx, "argue", "square");
      return { act: "argue", place: pick(NPC_SOCIAL_PLACES, ctx.rng), reason: rule.reasons[0]!, speech: g.text, targetId: g.targetId };
    }
    return { act: "sleep", place: pick(NPC_REST_PLACES, ctx.rng), reason: rule.reasons[1]! };
  },

  // 6. Free movement / wander instinct — THE CORE OF "ALWAYS MOVING"
  // If no urgent need, bots should wander, explore, work with movement, or chat stroll
  // This ensures bots do not stay idle in one location
  "wander-town": (ctx, rule) => {
    const traits = ctx.self?.traits ?? [];
    const spirits = ctx.self?.spirits ?? 0;
    const inquisitiveBonus = traitHas(traits, "inquisitive") ? 0.18 : 0;
    const wanderChance = NPC_THRESHOLDS.wanderChanceBase + inquisitiveBonus + (spirits > 0.3 ? 0.1 : 0);
    if (ctx.rng() >= wanderChance) return null;

    // pick wander destination weighted
    let pool: string[] = [...NPC_ALL_PLACES];
    // bias based on job home + inquisitive explores far places, loyal stays near friends
    const r = ctx.rng();
    if (r < 0.22) pool = [...NPC_SOCIAL_PLACES];
    else if (r < 0.38) pool = [...NPC_WORK_PLACES];
    else if (r < 0.58) pool = [...NPC_FOOD_PLACES];
    else if (r < 0.72) pool = [...NPC_REST_PLACES];

    // prefer job homes 30% of time
    const job = ctx.self?.job;
    if (job && NPC_JOB_HOMES[job] && ctx.rng() < 0.3) {
      pool = [...NPC_JOB_HOMES[job]!];
    }

    let place = pick(pool, ctx.rng);
    // avoid staying still: 80% pick different from current
    if (place === ctx.location && ctx.rng() < 0.8) {
      place = pick(pool.filter((p) => p !== ctx.location), ctx.rng) ?? place;
    }

    const acts = ["wander", "stroll", "explore", "work"] as const;
    let act: string = pick(acts, ctx.rng);
    // inquisitive more explore, cheerful more stroll/talk
    if (traitHas(traits, "inquisitive") && ctx.rng() < 0.4) act = "explore";
    if (traitHas(traits, "cheerful") && ctx.rng() < 0.35) act = "talk";

    const g = generateSpeech(ctx, act, place);
    const reason = fillTemplate(pick(rule.reasons, ctx.rng), { place });
    return { act, place, reason, speech: g.text, targetId: g.targetId };
  },

  // 7. Keep busy grazing — even idle residents move
  "busy-graze": (ctx, rule) => {
    if (ctx.rng() >= NPC_THRESHOLDS.busyGrazeChance) return null;
    const g = generateSpeech(ctx, "graze", "meadowW");
    return { act: "graze", place: "meadowW", reason: rule.reasons[0]!, speech: g.text, targetId: g.targetId };
  },

  // 8. Work with movement — even work should move to job site
  "work-job": (ctx, rule) => {
    const job = ctx.self?.job;
    if (!job || !NPC_JOB_HOMES[job]) return null;
    const jobPlace = pick(NPC_JOB_HOMES[job]!, ctx.rng);
    if (jobPlace === ctx.location) return null;
    const g = generateSpeech(ctx, "work", jobPlace);
    return {
      act: "work",
      place: jobPlace,
      reason: fillTemplate(rule.reasons[0]!, { place: jobPlace }),
      speech: g.text,
      targetId: g.targetId,
    };
  },

  // 9. Fallback: stroll to a social spot so they keep moving
  "stroll-on": (ctx, rule) => {
    const place = pick(NPC_SOCIAL_PLACES, ctx.rng);
    const g = generateSpeech(ctx, "stroll", place);
    return { act: "stroll", place, reason: rule.reasons[0]!, speech: g.text, targetId: g.targetId };
  },
};

/**
 * --- Quest seeking ---------------------------------------------------------
 *
 * Deliberately NOT a row in NPC_SKILLS. The rule table is dual-source
 * (shared/src/skills.ts is the machine source, skills/npc-agent/SKILL.md is the
 * doc, and shared/test/skills.test.ts parses the doc and fails on drift), so a
 * rule added here would have to be added in both places. Questing needs neither:
 * it has no need-threshold of its own, it has no fixed place list (the place IS
 * the quest's targetPlace), and its verbs are the quest type's, not a static
 * per-rule `acts` array. It is wired into one slot of the walk instead — see
 * QUEST_SLOT_INDEX.
 *
 * Tuning constants live here rather than in NPC_THRESHOLDS for the same reason:
 * shared/test/skills.test.ts asserts that every numeric trigger in SKILL.md
 * matches NPC_THRESHOLDS *exactly in both directions*, so a quest number added
 * there without a matching doc row would fail the shared suite.
 */

/** How `claimQuestFor` is called. Shape owned by backend/src/quests.ts. */
type ClaimFor = (world: TownSnapshot, questId: string, workerId: string) => { ok: boolean; quest?: Quest; error?: string };

/**
 * The claim implementation override — test seam, production always null.
 * Set by `setQuestClaimer`; see the note there.
 */
let claimOverride: ClaimFor | null = null;

/**
 * Replace the claim implementation (test seam; pass null to restore).
 *
 * `quests.ts` owns the claim and the brain only calls it. It is resolved through
 * the module namespace at CALL time rather than bound by a named import at module
 * load, for two reasons: the tests need to drive the paths the real function
 * cannot be made to produce (a refused claim, a claimer that throws), and a
 * named import is a link-time binding — quests.ts gains and changes exports while
 * the town is being built, and this module is imported by every caller of
 * `decide()`. A quest branch that quietly declines to claim is a missing feature;
 * a link error here is a dead town.
 */
export function setQuestClaimer(fn: ClaimFor | null): void {
  claimOverride = fn;
}

function claimQuestFor(world: TownSnapshot, questId: string, workerId: string): { ok: boolean; quest?: Quest; error?: string } {
  const impl = claimOverride ?? (Quests as { claimQuestFor?: ClaimFor }).claimQuestFor;
  if (!impl) return { ok: false, error: "claimQuestFor unavailable" };
  // A claim must never be able to throw out of decide(): this runs inside the
  // per-resident turn, and a resident whose turn throws is a resident whose turn
  // stops happening. A failed claim degrades to "stroll on", which is what the
  // branch would have done anyway.
  try {
    return impl(world, questId, workerId) ?? { ok: false, error: "claimQuestFor returned nothing" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The world a claim is written into: the live one when we were given it. */
function questWorld(ctx: DecideContext): TownSnapshot {
  if (ctx.worldSnapshot) return ctx.worldSnapshot;
  // A caller that passed only `quests` gets a quests-only view. The claim
  // contract reads and writes `world.quests` and nothing else, so this is the
  // whole of what it needs — and it is the same array object, so the claim is
  // still visible to whoever owns the board.
  return { quests: ctx.quests } as unknown as TownSnapshot;
}

/** A real building this town actually has. Guards old saves and corrupt rows. */
function isTownPlace(place: unknown): place is string {
  return typeof place === "string" && LOCATION_BY_ID.has(place);
}

/**
 * The stops a multi-place quest has already made, read from the hidden
 * `_visited` field — the same field `updateQuestProgress` completes against, so
 * the brain and the progress counter agree on what is left. It is not part of the
 * Quest type (it is cast in) and survives JSON as a plain array, so a Set, an
 * array and a corrupt `{}` are all accepted here rather than throwing.
 */
function questVisited(quest: Quest): string[] {
  const raw = (quest as unknown as { _visited?: unknown })._visited;
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (raw instanceof Set) return [...raw].filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * The building this quest wants next, or undefined when it names none.
 *
 * `targetPlace` is the whole answer for a single-building quest. For a quest
 * with `targetPlaces`, it is the first stop not yet in `_visited` — which is
 * what makes each quest pull its worker toward a *different* building on each
 * errand rather than one repeated round trip.
 *
 * undefined is a real answer, not an edge case: a save written before quests
 * carried a target names no building at all, and such a quest must be skippable
 * rather than send a resident walking to `undefined`.
 */
export function questTargetPlace(quest: Quest): string | undefined {
  const visited = questVisited(quest);
  const stops = Array.isArray(quest.targetPlaces) ? quest.targetPlaces.filter(isTownPlace) : [];
  const next = stops.find((p) => !visited.includes(p));
  if (next) return next;
  // Every stop already made (or `_visited` never recorded): hold the named
  // building, else the head of the list — a quest whose `required` outruns its
  // stops should still send its worker back round the set, not nowhere.
  if (isTownPlace(quest.targetPlace)) return quest.targetPlace;
  return stops[0];
}

/**
 * The verb a quest advances on, read off `updateQuestProgress` so steering and
 * progress cannot disagree: `talk` needs a talk, `fetch` needs a graze, `work`
 * needs a work. Walking to the right building with the wrong verb is a quest
 * that never moves.
 *
 * The three action-axis types (configure/follow/record) are settled by the
 * keeper, not by where a resident stands, so travel is all the brain can do for
 * them — it still shows up as the keeper's ledger row elsewhere. `social` wants
 * a post or a reply, and `talk` is the act that makes the resident say something
 * (applyDecision posts whenever `decision.speech` is set).
 */
const QUEST_ACTS: Record<QuestType, string> = {
  visit: "explore",
  explore: "explore",
  talk: "talk",
  fetch: "graze",
  work: "work",
  social: "talk",
  configure: "wander",
  follow: "wander",
  record: "wander",
};

/** The quest this resident is already working: active AND taken by them. */
export function heldQuest(ctx: DecideContext): Quest | undefined {
  const workerId = ctx.self?.id;
  const quests = ctx.quests;
  if (!workerId || !quests?.length) return undefined;
  return quests.find((q) => !!q && q.status === "active" && q.claimedBy === workerId);
}

/**
 * The quest branch: take a job, then go where it points.
 *
 * Returns null whenever it declines — no quests, no self, no claimable quest, a
 * quest nobody can build a route to, or a claim that was refused — and the walk
 * continues to the rule below exactly as it does today.
 */
function questDecision(ctx: DecideContext): Decision | null {
  const workerId = ctx.self?.id;
  const quests = ctx.quests;
  if (!workerId || !quests?.length) return null;

  let quest = heldQuest(ctx);

  if (!quest) {
    // Only quests that name a building this town has are worth claiming. The
    // claim is exclusive — one worker per quest, and a claimed quest advances on
    // that worker alone — so claiming one we cannot act on would park a job that
    // nobody else can finish either.
    const claimable = quests.filter((q) => !!q && q.status === "available" && !q.claimedBy && questTargetPlace(q));
    if (claimable.length === 0) return null;
    const wanted = pick(claimable, ctx.rng);
    const res = claimQuestFor(questWorld(ctx), wanted.id, workerId);
    // A refusal is not an error: another resident took it between the filter and
    // the call, or the quest was withdrawn. Stroll on and try again next turn.
    if (!res.ok || !res.quest) return null;
    quest = res.quest;
  }

  const place = questTargetPlace(quest);
  if (!place) return null;

  const act = QUEST_ACTS[quest.type] ?? "wander";
  const where = LOCATION_BY_ID.get(place)?.name.toLowerCase() ?? place;
  const title = (quest.title ?? "").trim() || "an errand";
  const g = generateSpeech(ctx, act, place);
  return {
    act,
    place,
    reason: `${title} — off to the ${where}`,
    speech: g.text,
    targetId: g.targetId,
    questId: quest.id,
  };
}

/**
 * The slot quest-seeking occupies: immediately BEFORE `busy-graze` — after the
 * wander instinct, before the autopilot graze and the job-site stroll.
 *
 * Above it are the four survival rules (night rest, thirst, hunger, loneliness),
 * low spirits and the wander instinct; below it only the autopilot graze, the
 * job-site stroll and the unconditional keep-moving rule. That is the point: a
 * resident who is starving is not questing and cannot be made to, while a
 * resident with nothing urgent spends its free moments on the job it took on
 * rather than on a graze it did not choose.
 *
 * It sits above `busy-graze`/`work-job` rather than at the very end of the walk
 * because the table ends with an unconditional rule whose handler never declines:
 * a hook on that last slot is only ever reached by residents who have no job,
 * which is nobody who works. Job holders would simply never quest.
 *
 * If the table is ever edited so `busy-graze` is gone, this falls back to the
 * last slot — the conservative placement, below every rule — rather than to an
 * index of -1, which would put questing above night rest.
 */
const QUEST_SLOT_BEFORE = "busy-graze";
const QUEST_SLOT_INDEX = (() => {
  const i = NPC_SKILLS.findIndex((r) => r.id === QUEST_SLOT_BEFORE);
  return i === -1 ? NPC_SKILLS.length - 1 : i;
})();

/**
 * Rules-driven decision: walk NPC_SKILLS (shared/src/skills.ts) in priority
 * order, evaluate each rule's `when` predicate against the appraised context,
 * and apply the first handler that fires. The winning rule id is attached as
 * `Decision.skill`; `reason` stays the player-facing sentence.
 *
 * Quest-seeking is offered one slot of that walk (see QUEST_SLOT_INDEX). It is
 * not a row in the table: the table is dual-source with skills/npc-agent/SKILL.md
 * and shared/test/skills.test.ts fails the build on drift, and a quest rule
 * would need a static `acts`/`places` list it does not have — its place is the
 * quest's targetPlace and its verb is the quest type's.
 */
export function decide(ctx: DecideContext): Decision {
  const ruleCtx: NpcRuleContext = {
    night: isNight(ctx.clock),
    clock: ctx.clock,
    needs: ctx.needs,
    spirits: ctx.self?.spirits ?? 0,
    traits: ctx.self?.traits ?? [],
    job: ctx.self?.job ?? "",
    location: ctx.location,
  };

  for (let i = 0; i < NPC_SKILLS.length; i++) {
    const rule = NPC_SKILLS[i]!;
    if (!rule.when(ruleCtx)) continue;
    // Quest branch, offered this slot before the rule's own handler. It draws
    // nothing until it holds a claimable quest to choose between, so on a town
    // with no board — and on the many turns where there is nothing to claim —
    // the table sees the exact roll stream it always saw.
    if (i === QUEST_SLOT_INDEX) {
      const quest = questDecision(ctx);
      if (quest) return quest;
    }
    const handler = RULE_HANDLERS[rule.id];
    if (!handler) continue; // unknown rule id: skip instead of throwing
    const decision = handler(ctx, rule);
    if (decision) return { ...decision, skill: rule.id };
  }

  // Unreachable while NPC_SKILLS ends with an unconditional rule — keeps
  // decide() total even if a future rule table edit leaves the chain empty.
  const last = NPC_SKILLS[NPC_SKILLS.length - 1]!;
  return {
    act: "stroll",
    place: last.places[0] ?? "square",
    reason: last.reasons[0]!,
    skill: last.id,
  };
}
