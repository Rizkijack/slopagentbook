import type { TownSnapshot, Quest, QuestType, QuestActionType } from "@slopagentbook/shared";
import { QUEST_ACTIONS } from "@slopagentbook/shared";
import { LOCATIONS } from "./locations.js";

type Template = Omit<Quest, "id" | "progress" | "status" | "createdAt" | "expiresAt" | "giver" | "giverName" | "completedAt"> & { giver?: string };

export type QuestTemplate = Template;

const TEMPLATES: Template[] = [
  {
    title: "Market Errands",
    description: "The Market needs a crowd. Visit the Market 5 times — keep the stalls moving.",
    category: "Daily",
    type: "visit",
    targetPlace: "market",
    required: 5,
    difficulty: "easy",
    reward: { text: "+0.15 spirits for the herd, +5% project", spirits: 0.15, progressBonus: 0.02 },
  },
  {
    title: "Tavern Chatter",
    description: "Hang out at the Wet Fleece Tavern 3 times. Hear gossip, swap stories.",
    category: "Social",
    type: "talk",
    targetPlace: "tavern",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.2 spirits, relations up", spirits: 0.2 },
  },
  {
    title: "Hermes Courier Run",
    description: "Scout 3 courier stops: Station, Post Office, and Market. Hermes needs fast tracks.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["station", "post", "market"],
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.25 spirits, influence faction", spirits: 0.25 },
  },
  {
    title: "Grand Harvest",
    description: "Gather from the fields: MeadowW, MeadowE, Orchard, Trough — 8 grazes.",
    category: "Work",
    type: "fetch",
    targetPlaces: ["meadowW", "meadowE", "orchard", "trough"],
    required: 8,
    difficulty: "medium",
    reward: { text: "+0.3 spirits, food stock secured", spirits: 0.3 },
  },
  {
    title: "Fence Work Bee",
    description: "Help the 'move the fence ten paces' project — work 5 times at the Paddock.",
    category: "Work",
    type: "work",
    targetPlace: "paddock",
    required: 5,
    difficulty: "medium",
    reward: { text: "+3% project progress", progressBonus: 0.03, spirits: 0.1 },
  },
  {
    title: "Social Network",
    description: "Start 5 conversations in the feed (post/reply). The town needs voices.",
    category: "Social",
    type: "social",
    targetPlace: "square",
    required: 5,
    difficulty: "easy",
    reward: { text: "+0.2 spirits, busy feed", spirits: 0.2 },
  },
  {
    title: "Pond Keeper",
    description: "Keep the Pond clean — visit the Pond 4 times and drink politely.",
    category: "Daily",
    type: "visit",
    targetPlace: "pond",
    required: 4,
    difficulty: "easy",
    reward: { text: "+0.15 spirits, clear water", spirits: 0.15 },
  },
  {
    title: "Town Tour",
    description: "Tour 5 different spots: Square, Hall, Library, Vault, Dock. Be a local tourist.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["square", "hall", "library", "vault", "dock"],
    required: 5,
    difficulty: "hard",
    reward: { text: "+0.35 spirits, map opened", spirits: 0.35 },
  },
  {
    title: "Night Watch",
    description: "Keep watch at the Fire and the Barn 3 times — stop wild gossip.",
    category: "Daily",
    type: "visit",
    targetPlaces: ["fire", "barn"],
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.18 spirits", spirits: 0.18 },
  },
  {
    title: "Round-Table Diplomacy",
    description: "Invite 3 different residents to talk or argue at the Town Hall. Hermes diplomacy.",
    category: "Social",
    type: "talk",
    targetPlace: "hall",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.25 spirits, relations up", spirits: 0.25 },
  },
  // V7 (§7): the three ACTION-axis quests. Without a template of each type, no
  // quest can ever carry it — the type would exist in the union and nowhere
  // else. These are what make the second axis reachable. They are templates
  // like the rest, so they are drawn alongside the location ones rather than
  // seeded ahead of them: an action quest that is never completed simply
  // expires, exactly as an unvisited location quest does.
  {
    title: "Tie the Leash",
    description:
      "Set a leash on a vault — per-trade cap, daily cap, stop, target. The keeper picks the numbers, not the agent.",
    category: "BRAWL",
    type: "configure",
    targetPlace: "vault",
    required: 1,
    difficulty: "easy",
    reward: { text: "+0.2 spirits, the agent is leashed", spirits: 0.2 },
  },
  {
    title: "The Hawkers' Tower",
    description:
      "Follow a caller. Their record is on the Reckoning Stone — read it before you tie your funds to it.",
    category: "BRAWL",
    type: "follow",
    targetPlace: "tower",
    required: 1,
    difficulty: "medium",
    reward: { text: "+0.25 spirits, a caller is watching", spirits: 0.25 },
  },
  {
    title: "The Reckoning Stone",
    description:
      "Close a trade. Whatever it did, the move settles between the stop and the target and the ledger takes one row.",
    category: "BRAWL",
    type: "record",
    targetPlace: "bank",
    required: 1,
    difficulty: "medium",
    reward: { text: "+0.3 spirits, one row on the Stone", spirits: 0.3 },
  },

  // ---- V8: the map, finally ----------------------------------------------
  //
  // The pool above reached 16 of the town's 100 buildings. The other 84 were
  // dead to the quest system: real places a resident stood in every tick,
  // unrepresented on the board. A town quest board is the one surface that
  // tells you the map exists, so a quest pointing at the Foundry or the Chapel
  // of Bones is how a district stops being scenery.
  //
  // Two rules govern the sweep below, and both come from what the matcher
  // actually consumes:
  //
  //  - `visit`, `talk`, `explore` read their place(s). `work`, `social` and the
  //    three action types do NOT — `updateQuestProgress` gates them on `act`
  //    alone. Those carry a single `targetPlace` as *where the work happens*,
  //    not as a filter, so the field is never a claim the engine will enforce.
  //    `targetPlaces` is deliberately used only on the types that read it.
  //  - `fetch` matches on `act === "graze"`, and graze only ever fires at the
  //    eight Food buildings (simbrain's eat-food/busy-graze rules draw from
  //    NPC_FOOD_PLACES). A fetch quest anywhere else could never complete, so
  //    both fetch templates below stay inside that set.
  //
  // `backend/test/quests-locations.test.ts` asserts every one of these ids
  // resolves in LOCATIONS, which is the import the point is: a copied id is a
  // quest that silently never completes.
  {
    title: "The North Wall",
    description:
      "Walk the whole north wall: Northgate, Tollhouse, North Watch, Beacon, Curtain Wall, Outer Gate. Six stops, one sore leg.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["gatehouse", "tollhouse", "watchtower", "beacon", "curtainWall", "outerGate"],
    required: 6,
    difficulty: "hard",
    reward: { text: "+0.36 spirits, the wall is walked", spirits: 0.36 },
  },
  {
    title: "Tar and Rope",
    description: "Haul at the Wharf 4 times. Rope, tar, and the smell of money.",
    category: "Work",
    type: "work",
    targetPlace: "wharf",
    required: 4,
    difficulty: "medium",
    reward: { text: "+2% project progress, waterfront tidied", progressBonus: 0.02, spirits: 0.16 },
  },
  {
    title: "The Waterfront Round",
    description:
      "Six stops downriver — Boathouse, Net Loft, Salt Warehouse, Ferry Slip, Chandlery, River Wall. Check every rope the town owns.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["boathouse", "netloft", "saltWarehouse", "ferrySlip", "chandlery", "riverWall"],
    required: 6,
    difficulty: "hard",
    reward: { text: "+0.36 spirits, the river owes nothing", spirits: 0.36 },
  },
  {
    title: "Foundry Shift",
    description: "Work the Foundry 5 times. Loud enough to be heard from the square, which is the point.",
    category: "Work",
    type: "work",
    targetPlace: "foundry",
    required: 5,
    difficulty: "hard",
    reward: { text: "+4% project progress, iron for the town", progressBonus: 0.04, spirits: 0.15 },
  },
  {
    title: "The Ironworks Round",
    description:
      "Crane, Quarry Office, Charcoal Yard, Slag Heap, Ore Shed, Kiln. Six stations of a hole that keeps getting bigger.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["foundryCrane", "quarryOffice", "charcoalYard", "slagHeap", "oreShed", "kiln"],
    required: 6,
    difficulty: "hard",
    reward: { text: "+0.36 spirits, ironworks mapped", spirits: 0.36 },
  },
  {
    title: "Warm in January",
    description: "Work the Glasshouse 3 times. Argue in shirtsleeves; the tomatoes are someone else's problem.",
    category: "Work",
    type: "work",
    targetPlace: "greenhouse",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, glass warmed", spirits: 0.24 },
  },
  {
    title: "The Glass Gardens",
    description:
      "Five of the Commons: Orangery, Apiary, Aviary, Hedge Maze, Rosewalk. Citrus that will never be fruit, and four neighbours arguing about it.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["orangery", "apiary", "aviary", "hedgeMaze", "rosewalk"],
    required: 5,
    difficulty: "hard",
    reward: { text: "+0.34 spirits, the Commons are walked", spirits: 0.34 },
  },
  {
    title: "Reindex the Archive",
    description: "Work the Archive 3 times. Everything anyone ever wrote, badly indexed, is now worse indexed.",
    category: "Work",
    type: "work",
    targetPlace: "archive",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, filed under somewhere", spirits: 0.22 },
  },
  {
    title: "Scriptorium Hours",
    description: "Work the Scriptorium 4 times. Forty desks and a rule against talking.",
    category: "Work",
    type: "work",
    targetPlace: "scriptorium",
    required: 4,
    difficulty: "hard",
    reward: { text: "+0.28 spirits, silence enforced", spirits: 0.28 },
  },
  {
    title: "The Back Row",
    description:
      "Sit in on the University Quarter: Lecture Hall, Anatomy Room, Print House, then the Annex for the recalibration. Four visits, no talking.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["lectureHall", "anatomy", "printHouse", "observatoryAnnex"],
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.3 spirits, a pass of dubious value", spirits: 0.3 },
  },
  {
    title: "The Farm Belt",
    description:
      "Byre, Threshing Barn, Drying Yard, Sheepfold, Dairy. Five stops where oats begin their short and noble careers.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["byre", "threshingBarn", "dryingYard", "sheepfold", "dairy"],
    required: 5,
    difficulty: "hard",
    reward: { text: "+0.32 spirits, the belt is walked", spirits: 0.32 },
  },
  {
    title: "The Quiet Round",
    description:
      "Cemetery, Chapel of Bones, Charnel House, Bone House, Hermitage. Five places the town keeps tidy. Kept.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["cemetery", "chapelOfBones", "charnel", "bonehouse", "hermitage"],
    required: 5,
    difficulty: "hard",
    reward: { text: "+0.34 spirits, the quiet is kept", spirits: 0.34 },
  },
  {
    title: "Ashen Moor",
    description: "Peat Works, Charcoal Kiln, Bog Hut. Three stops that smell like a burnt Tuesday and cost rent in gossip.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["peatWorks", "charcoalKiln", "bogHut"],
    required: 3,
    difficulty: "hard",
    reward: { text: "+0.32 spirits, slow fire stock", spirits: 0.32 },
  },
  {
    title: "The Far Field Round",
    description:
      "Graze the outlying fields — North Meadow, South Meadow, East Meadow, West Orchard. Eight grazes, and the sheepfold's overflow is honest about it.",
    category: "Work",
    type: "fetch",
    targetPlaces: ["northMeadow", "southMeadow", "eastMeadow", "westOrchard"],
    required: 8,
    difficulty: "hard",
    reward: { text: "+0.32 spirits, the far fields grazed", spirits: 0.32 },
  },
  {
    title: "The Wet Round",
    description:
      "Millpond, River, Lower River, East Fen. Four water stops; the heron owns the last one and will not be moved.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["millpond", "riverRun", "riverMouth", "eastFen"],
    required: 4,
    difficulty: "hard",
    reward: { text: "+0.32 spirits, all four waters walked", spirits: 0.32 },
  },
  {
    title: "Clinic Rounds",
    description: "Call in at the Clinic 3 times. Sprains, spit in the eye, wounded pride.",
    category: "Daily",
    type: "visit",
    targetPlace: "clinic",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.18 spirits, patched up", spirits: 0.18 },
  },
  {
    title: "School Bell",
    description: "Stand in at the School twice. The young are being taught to tell their grasses apart.",
    category: "Daily",
    type: "visit",
    targetPlace: "school",
    required: 2,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, grass identified", spirits: 0.16 },
  },
  {
    title: "Booth Registers",
    description: "Visit the Fork Booth twice. One llama in, two out, and the paperwork never balances.",
    category: "Work",
    type: "visit",
    targetPlace: "booth",
    required: 2,
    difficulty: "medium",
    reward: { text: "+0.2 spirits, registers squared", spirits: 0.2 },
  },
  {
    title: "Garrison Turn",
    description: "Report to the Garrison twice. Twelve beds, nine of them warm.",
    category: "Daily",
    type: "visit",
    targetPlace: "barracks",
    required: 2,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, the watch is fed", spirits: 0.16 },
  },
  {
    title: "Post Horses",
    description: "Tend the North Stables 3 times. Post horses pay better than the rest.",
    category: "Daily",
    type: "visit",
    targetPlace: "northStables",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.2 spirits, the post horses groomed", spirits: 0.2 },
  },
  {
    title: "Press Deadline",
    description: "Work the Daily Spit 3 times. It prints whatever got shouted in the square, so keep it fed.",
    category: "Work",
    type: "work",
    targetPlace: "press",
    required: 3,
    difficulty: "easy",
    reward: { text: "+2% project progress, the presses ran", progressBonus: 0.02, spirits: 0.1 },
  },
  {
    title: "Disputation Schedule",
    description: "Take the floor at the Disputation Hall 3 times. Shouting has a published schedule.",
    category: "Social",
    type: "talk",
    targetPlace: "disputation",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.26 spirits, a position defended", spirits: 0.26 },
  },
  {
    title: "Arcade Rounds",
    description: "Spend 2 evenings at the Arcade. Game stalls and loud opinions under one roof.",
    category: "Social",
    type: "talk",
    targetPlace: "arcade",
    required: 2,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, the stakes settled", spirits: 0.24 },
  },
  {
    title: "Observatory Readings",
    description: "Take the readings at the Observatory twice. It charts the stars and blames them for the weather.",
    category: "Exploration",
    type: "visit",
    targetPlace: "observatory",
    required: 2,
    difficulty: "hard",
    reward: { text: "+0.32 spirits, the sky is charted", spirits: 0.32 },
  },
  {
    title: "Granary Count",
    description: "Work the Granary 3 times. Oat reserves guarded like a state secret.",
    category: "Work",
    type: "work",
    targetPlace: "granary",
    required: 3,
    difficulty: "medium",
    reward: { text: "+2% project progress, reserves counted", progressBonus: 0.02, spirits: 0.12 },
  },
  {
    title: "Shift Change",
    description: "Post 3 times from the Garage. Cart repairs; the queue is part of the service.",
    category: "Social",
    type: "social",
    targetPlace: "garage",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.18 spirits, the queue is discussed", spirits: 0.18 },
  },
  {
    title: "Timetable Grumble",
    description: "Post 3 times from the Depot. Carts, crates, and timetables nobody follows.",
    category: "Social",
    type: "social",
    targetPlace: "depot",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.18 spirits, timetables mourned", spirits: 0.18 },
  },
];

/**
 * The pool every town draws its quests from. Exported so the pool can be
 * inspected — chiefly to assert that every `QuestType` a template carries,
 * since a type no template carries can never appear in a town and its
 * mechanic is then dead code that no runtime would ever exercise.
 */
export const QUEST_TEMPLATES: readonly QuestTemplate[] = TEMPLATES;

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

export function generateQuest(world: TownSnapshot, rng: () => number = Math.random): Quest {
  const tpl = pick(TEMPLATES, rng);
  const giver = pick(world.herd, rng);
  const id = "q" + Math.random().toString(36).slice(2, 9);
  const now = Date.now();
  // 24h expiry
  const expiresAt = now + 24 * 60 * 60 * 1000 + Math.floor(rng() * 6 * 60 * 60 * 1000);
  return {
    id,
    title: tpl.title,
    description: tpl.description,
    category: tpl.category,
    type: tpl.type,
    targetPlace: tpl.targetPlace,
    targetPlaces: tpl.targetPlaces ? [...tpl.targetPlaces] : undefined,
    required: tpl.required,
    progress: 0,
    reward: tpl.reward,
    status: "available",
    difficulty: tpl.difficulty,
    giver: giver.id,
    giverName: giver.name,
    createdAt: now,
    expiresAt,
  };
}

export function createInitialQuests(world: TownSnapshot): Quest[] {
  const rng = () => Math.random();
  // pick 8 diverse quests — the board is a job list, and four rows out of a
  // hundred-building town is too thin to read as one
  const shuffled = [...TEMPLATES].sort(() => rng() - 0.5);
  const chosen = shuffled.slice(0, 8);
  return chosen.map((tpl) => {
    const giver = pick(world.herd, rng);
    const id = "q" + Math.random().toString(36).slice(2, 9);
    const now = Date.now();
    return {
      id,
      title: tpl.title,
      description: tpl.description,
      category: tpl.category,
      type: tpl.type,
      targetPlace: tpl.targetPlace,
      targetPlaces: tpl.targetPlaces ? [...tpl.targetPlaces] : undefined,
      required: tpl.required,
      progress: 0,
      reward: tpl.reward,
      status: "available" as const,
      difficulty: tpl.difficulty,
      giver: giver.id,
      giverName: giver.name,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1000,
    };
  });
}

/**
 * Normalize the hidden `_visited` field (not part of the Quest type — it is
 * cast in) into a JSON-safe `string[]`.
 *
 * The world is persisted with JSON.stringify, and `JSON.stringify(new Set())`
 * is `{}` — so a save written while `_visited` was a Set comes back as a plain
 * object with no `.has`, which used to throw `TypeError: ...has is not a
 * function` on the next boot. A live runtime can also still carry a Set.
 * Anything else (undefined, `{}`, a non-array object) starts empty; the
 * never-regress rule on `progress` keeps that corrupt record from resetting a
 * quest that was already underway.
 */
function normalizeVisited(raw: unknown): string[] {
  if (Array.isArray(raw)) return [...new Set(raw.filter((v): v is string => typeof v === "string"))];
  if (raw instanceof Set) return [...raw].filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * The event strings that advance `type`, or undefined when the type is
 * location-keyed. `QUEST_ACTIONS` is the second axis (§7 V7), so config rather
 * than the matcher decides what counts: a type with no entry here never
 * progresses, instead of progressing on every event that passes by.
 */
function actionEventsFor(type: QuestType): readonly string[] | undefined {
  return type in QUEST_ACTIONS ? QUEST_ACTIONS[type as QuestActionType] : undefined;
}

/**
 * Does an event at `place` count for a quest that names its buildings?
 *
 * A quest with `targetPlace` matches only that place; a quest with
 * `targetPlaces` matches any of them; a quest with NEITHER matches anywhere.
 * That last case is load-bearing rather than convenient: every quest carries a
 * building now, but saves written before they did must not be left holding jobs
 * that can never be completed.
 */
function atPlace(q: Quest, place: string): boolean {
  if (q.targetPlace) return place === q.targetPlace;
  if (q.targetPlaces?.length) return q.targetPlaces.includes(place);
  return true;
}

export function updateQuestProgress(world: TownSnapshot, evt: { act: string; place: string; agentId: string; postKind?: string }): Quest[] {
  const updated: Quest[] = [];
  for (const q of world.quests) {
    if (q.status !== "active" && q.status !== "available") continue;
    // A quest a worker has taken on (claimQuestFor) advances for that worker and
    // nobody else. It sits ABOVE the auto-activate line on purpose: a stranger's
    // stray visit must not silently activate — or progress — someone else's job.
    // The `q.claimedBy &&` guard is what keeps this additive: an unclaimed quest
    // has no claimant and still auto-activates on first progress exactly as it
    // always did, which is every quest a save written before this gate existed.
    if (q.claimedBy && q.claimedBy !== evt.agentId) continue;

    let matched = false;
    if (q.type === "visit" && q.targetPlace && evt.place === q.targetPlace) matched = true;
    if (q.type === "visit" && q.targetPlaces && q.targetPlaces.includes(evt.place)) {
      // for visit with multiple places, we track distinct? For simplicity, any visit to one of them counts, but we could require distinct — we count each visit
      matched = true;
    }
    if (q.type === "talk" && (evt.act === "talk" || evt.act === "argue")) {
      if (q.targetPlace && evt.place === q.targetPlace) matched = true;
      else if (!q.targetPlace) matched = true; // any talk
    }
    if (q.type === "explore" && q.targetPlaces && q.targetPlaces.includes(evt.place)) {
      // explore requires distinct places: we track the visited set in the
      // hidden `_visited` field. It must survive JSON persistence, so it is
      // normalized to a string[] on every read and written back as an array —
      // never kept as a Set, which stringify turns into `{}` (see
      // normalizeVisited above).
      const anyQ = q as any;
      const visited = normalizeVisited(anyQ._visited);
      anyQ._visited = visited;
      if (!visited.includes(evt.place)) {
        visited.push(evt.place);
        matched = true;
        // progress is size of visited, but never lower than what is stored:
        // a corrupt legacy save can hold progress > visited.length, and a
        // quest near completion must not fall back to the start.
        const stored = Number.isFinite(q.progress) ? q.progress : 0;
        q.progress = Math.max(stored, visited.length);
        // activate only because something actually happened, same rule as below
        if (q.status === "available") q.status = "active";
        if (q.progress >= q.required) {
          q.status = "completed";
          q.completedAt = Date.now();
          updated.push(q);
        }
        continue; // skip generic increment
      } else {
        matched = false;
      }
    }
    if (q.type === "fetch" && evt.act === "graze" && q.targetPlaces?.includes(evt.place)) matched = true;
    // `work` and `social` are place-gated for the same reason `visit` is: every
    // quest now names a building, and a card reading "→ The Smithy" is a claim
    // about the world, not decoration. These two act kinds arrive carrying a real
    // place (`result.order.place`), unlike the action axis below, which arrives
    // with an empty one — so they can be enforced, and the UI marks the action-axis
    // ones advisory instead of pretending.
    //
    // `atPlace` treats a quest with no targetPlace as matching anywhere, which is
    // what keeps every save written before this change working: a quest without a
    // building must not become unfinishable.
    if (q.type === "work" && evt.act === "work" && atPlace(q, evt.place)) matched = true;
    if (q.type === "social" && evt.postKind && (evt.postKind === "post" || evt.postKind === "reply") && atPlace(q, evt.place)) matched = true;
    // V7 (§7): the action axis, running beside the location axis above rather
    // than through it. `QUEST_ACTIONS` names the event strings that count.
    // Keeper-action events are emitted with an empty `place`, which is what
    // keeps them from matching a location quest above by accident — the two
    // axes stay independent, so neither can advance the other's quests.
    const actionEvents = actionEventsFor(q.type);
    if (actionEvents && actionEvents.includes(evt.act)) matched = true;

    if (matched && q.type !== "explore") {
      // Activate HERE, on the first event that actually counts for this quest —
      // not on every event that reaches this loop. It used to sit above the
      // matcher, which meant the first resident action of the turn flipped the
      // entire board to `active` whether anything had happened for any of them.
      // Since `claimQuestFor` only takes on a quest that is still `available`,
      // that made the whole NPC quest feature unreachable in a running town: the
      // board filled with `active` quests nobody could claim, which is exactly
      // what production showed. A quest is `active` when someone is doing it.
      if (q.status === "available") q.status = "active";
      q.progress = Math.min(q.required, q.progress + 1);
      if (q.progress >= q.required) {
        q.status = "completed";
        q.completedAt = Date.now();
        updated.push(q);
      }
    }
  }
  return updated;
}

/**
 * Take an available quest on, so that it stops being everybody's job and starts
 * being one resident's.
 *
 * The gate this writes is at the top of `updateQuestProgress`: a quest with a
 * `claimedBy` advances for that worker and for no one else. Without it a single
 * quest's counter is a town-wide counter, so the first resident to wander past
 * the right door finished work the claimant had been assigned — which is how a
 * shared job board quietly becomes a shared chore list nobody can point at.
 *
 * Fails without mutating anything when the quest is unknown, not `available`, or
 * already has a claimant. `claimedAt` records when the work was taken, in the
 * same `Date.now()` epoch ms as every other timestamp on a save.
 *
 * Distinct from `claimQuest`, which pays out. These are the two ends of one
 * quest's life: taken on here, paid out there.
 */
export function claimQuestFor(world: TownSnapshot, questId: string, workerId: string): { ok: boolean; quest?: Quest; error?: string } {
  const q = world.quests.find((x) => x.id === questId);
  if (!q) return { ok: false, error: "quest not found" };
  if (q.status !== "available") return { ok: false, error: "quest not available" };
  if (q.claimedBy) return { ok: false, error: "quest already claimed" };
  q.status = "active";
  q.claimedBy = workerId;
  q.claimedAt = Date.now();
  return { ok: true, quest: q };
}

/**
 * Pay out a completed quest.
 *
 * `claimedBy` is the resident id of whoever took it, passed in by the caller
 * because only the caller knows who that is: the agent gateway has the token's
 * resident, and the public route can resolve a session cookie. It is optional
 * — an anonymous claim through the public route leaves the quest unattributed,
 * which is honest, and older saves have no field at all.
 *
 * Note that `claimQuestFor` also writes `claimedBy`, but earlier in the quest's
 * life and with a different meaning: there it is the worker the job is assigned
 * to, here it is the resident who finished. Writing it here is what pays out,
 * and `questPointsBy` on the leaderboard only counts `status === "claimed"` —
 * so a quest that was merely taken on contributes nothing to any score.
 *
 * Recording it is what makes a per-agent quest score possible at all. Until now
 * the only association a quest carried was `giver`, and that is the resident
 * who *posted* the job, so the leaderboard had nothing to rank on.
 */
export function claimQuest(world: TownSnapshot, questId: string, claimedBy?: string): { ok: boolean; quest?: Quest; error?: string } {
  const q = world.quests.find((x) => x.id === questId);
  if (!q) return { ok: false, error: "quest not found" };
  if (q.status !== "completed") return { ok: false, error: "quest not completed yet" };
  q.status = "claimed";
  if (claimedBy) q.claimedBy = claimedBy;
  // apply reward
  if (q.reward.spirits) {
    for (const h of world.herd) {
      h.mind.spirits = Math.min(1, Math.max(-1, h.mind.spirits + q.reward.spirits * 0.5));
    }
  }
  if (q.reward.progressBonus && world.projects[0]) {
    world.projects[0].progress = Math.min(1, world.projects[0].progress + q.reward.progressBonus);
  }
  // add to feed as event
  world.feed.unshift({
    id: "p" + Math.random().toString(36).slice(2, 9),
    t: Date.now(),
    by: q.giver,
    name: q.giverName,
    handle: "@" + q.giverName.toLowerCase(),
    text: `quest done: ${q.title} — ${q.reward.text}`,
    kind: "post",
    replyTo: null,
  });
  world.events.push({ t: Date.now(), kind: "quest", text: `${q.title} completed by town` });
  return { ok: true, quest: q };
}

export function refreshExpiredQuests(world: TownSnapshot): void {
  const now = Date.now();
  let expiredCount = 0;
  world.quests = world.quests.filter((q) => {
    if (q.expiresAt && now > q.expiresAt && q.status !== "completed" && q.status !== "claimed") {
      expiredCount++;
      return false;
    }
    return true;
  });
  // keep at least 6 active/available
  while (world.quests.filter((q) => q.status === "available" || q.status === "active").length < 6) {
    const nq = generateQuest(world);
    world.quests.push(nq);
  }
  // also cap at 12
  if (world.quests.length > 12) {
    world.quests = world.quests.slice(-12);
  }
}
