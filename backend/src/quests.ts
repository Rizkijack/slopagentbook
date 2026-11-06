import type { TownSnapshot, Quest, QuestType, QuestActionType, QuestRewardInfo } from "@slopagentbook/shared";
import { QUEST_ACTIONS } from "@slopagentbook/shared";
import { LOCATIONS } from "./locations.js";

type Template = Omit<Quest, "id" | "progress" | "status" | "createdAt" | "expiresAt" | "giver" | "giverName" | "completedAt"> & { giver?: string };

export type QuestTemplate = Template;

/**
 * The claim contract every quest response carries: what is paid now (spirits)
 * and what will be paid from where once a mint exists — the treasury wallet on
 * the coin page. Pure function of config, so no claim ever rewrites a quest.
 */
export function questRewardInfo(config: TownSnapshot["config"]): QuestRewardInfo {
  return {
    spirits: true,
    token: {
      deployed: config.tokenDeployed === true,
      mint: config.tokenAddress || null,
      from: config.treasuryAddress || null,
    },
  };
}

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

  // ---- V9: the second sweep ----------------------------------------------
  //
  // Twenty more cards, drawn from the buildings the first sweep still never
  // named: the Baths, the Wayfarer Inn, the Fleece Theatre, the Bandstand,
  // the Hunter Lodge, the Exchange, the Smithy, the Forge, the Mill, the
  // Shearing Shed, the Warehouse, the Pens, the Stables, the Chapel, the
  // Farmhouse. Each idea is a different kind of errand — a soak, a rumour, a
  // shift, a tally — rather than another number on a card that already
  // existed.
  //
  // The two rules from V8 still hold and are the reason these can be trusted
  // to complete at all:
  //  - `visit`/`talk`/`explore` read place(s), so every id here resolves in
  //    LOCATIONS (`quests-locations.test.ts` asserts it).
  //  - `fetch` only fires on `graze`, which only happens at the eight Food
  //    buildings, so the one fetch template stays inside `northMeadow`,
  //    `southMeadow`, `westOrchard`, `trough`.
  //
  // Two BRAWL cards use the action axis instead of a place: `configure` counts
  // `leash_set` and `record` counts `trade_close` (QUEST_ACTIONS in
  // shared/src/config.ts), so their `targetPlace` is where the work is
  // described, never a filter the matcher enforces.
  {
    title: "Bathhouse Circuit",
    description: "Soak at the Baths 3 times. The town's only honest rumours are the ones told in steam.",
    category: "Daily",
    type: "visit",
    targetPlace: "baths",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.18 spirits, steam-cleared ears", spirits: 0.18 },
  },
  {
    title: "The Wayfarer's Ledger",
    description: "Talk shop with travellers at the Wayfarer Inn 3 times. Someone always knows where the good grass is.",
    category: "Social",
    type: "talk",
    targetPlace: "inn",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.24 spirits, road news swapped", spirits: 0.24 },
  },
  {
    title: "Curtain Call",
    description: "Audition at the Fleece Theatre 3 times. The fleece gets the last laugh; you get the second one.",
    category: "Social",
    type: "talk",
    targetPlace: "theatre",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.26 spirits, a part half-learned", spirits: 0.26 },
  },
  {
    title: "Brass on Sundays",
    description: "Post 3 times from the Bandstand. Brass on Sundays, silence on Mondays, opinions always.",
    category: "Social",
    type: "social",
    targetPlace: "bandstand",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.2 spirits, the square heard it", spirits: 0.2 },
  },
  {
    title: "Tall Tales",
    description: "Trade stories at the Hunter Lodge 3 times. The trophies are real; the measurements are not.",
    category: "Social",
    type: "talk",
    targetPlace: "lodge",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, one story taller", spirits: 0.24 },
  },
  {
    title: "Oats Futures",
    description: "Work the Exchange 4 times. Oats futures, wool options, and a strong coffee that outlasts both.",
    category: "Work",
    type: "work",
    targetPlace: "exchange",
    required: 4,
    difficulty: "medium",
    reward: { text: "+2% project progress, futures barely moved", progressBonus: 0.02, spirits: 0.18 },
  },
  {
    title: "Anvil Chorus",
    description: "Work the Smithy 5 times. Horseshoes, hinges, and one bent anvil nobody will admit to.",
    category: "Work",
    type: "work",
    targetPlace: "smithy",
    required: 5,
    difficulty: "hard",
    reward: { text: "+3% project progress, iron ringing", progressBonus: 0.03, spirits: 0.16 },
  },
  {
    title: "Second Fire",
    description: "Work the Forge 4 times. The town's second fire — the first one is for actual work.",
    category: "Work",
    type: "work",
    targetPlace: "forge",
    required: 4,
    difficulty: "medium",
    reward: { text: "+3% project progress, coals banked", progressBonus: 0.03, spirits: 0.16 },
  },
  {
    title: "The Mill Grind",
    description: "Work the Mill 4 times. It grinds oats into more oats; nobody has ever asked why.",
    category: "Work",
    type: "work",
    targetPlace: "mill",
    required: 4,
    difficulty: "medium",
    reward: { text: "+2% project progress, sacks stacked", progressBonus: 0.02, spirits: 0.16 },
  },
  {
    title: "Standing Inventory",
    description: "Work the Warehouse 4 times. Everything the Market could not sell, counted twice.",
    category: "Work",
    type: "work",
    targetPlace: "warehouse",
    required: 4,
    difficulty: "medium",
    reward: { text: "+2% project progress, shelves accounted", progressBonus: 0.02, spirits: 0.18 },
  },
  {
    title: "Pens Watch",
    description: "Check the Pens twice. Newcomers waiting for a family, and the paperwork that outlived them.",
    category: "Daily",
    type: "visit",
    targetPlace: "pens",
    required: 2,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, the pens are calm", spirits: 0.16 },
  },
  {
    title: "Stable Duty",
    description: "Muck out the Stables 3 times. The horses sleep here; the llamas pretend not to care.",
    category: "Daily",
    type: "visit",
    targetPlace: "stables",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.2 spirits, straw turned", spirits: 0.2 },
  },
  {
    title: "Pray for Shorter Winters",
    description: "Sit in the Chapel twice. Sunday prayers for extra grass, attended by whoever is awake.",
    category: "Daily",
    type: "visit",
    targetPlace: "chapel",
    required: 2,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, grass prayed for", spirits: 0.16 },
  },
  {
    title: "The Oat Table",
    description: "Talk at the Farmhouse 3 times. Where oats begin their short and noble careers, and every meal is discussed first.",
    category: "Social",
    type: "talk",
    targetPlace: "farmhouse",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.22 spirits, a seat at the table", spirits: 0.22 },
  },
  {
    title: "The High-Tension Round",
    description: "Baths, Theatre, Bandstand, Lodge, Inn. Five stops where the town argues politely and calls it culture.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["baths", "theatre", "bandstand", "lodge", "inn"],
    required: 5,
    difficulty: "hard",
    reward: { text: "+0.34 spirits, the social circuit walked", spirits: 0.34 },
  },
  {
    title: "The Money Round",
    description: "Exchange, Bank, Warehouse, Tollhouse. Four stops that decide who owes whom, and at what price.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["exchange", "bank", "warehouse", "tollhouse"],
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.3 spirits, the ledger is understood", spirits: 0.3 },
  },
  {
    title: "The Grain Run",
    description: "Mill, Millpond, Drying Yard, Granary. Four stops between a grain and a loaf, none of them short.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["mill", "millpond", "dryingYard", "granary"],
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.3 spirits, the grain run walked", spirits: 0.3 },
  },
  {
    title: "The Final Sheaf",
    description: "Graze the last good grass — North Meadow, South Meadow, West Orchard, Trough. Six grazes before it dries.",
    category: "Work",
    type: "fetch",
    targetPlaces: ["northMeadow", "southMeadow", "westOrchard", "trough"],
    required: 6,
    difficulty: "medium",
    reward: { text: "+0.28 spirits, the last sheaf is in", spirits: 0.28 },
  },
  {
    title: "Two Knots, One Keeper",
    description: "Set two leashes on a vault. Different caps, different targets — the keeper picks the numbers twice.",
    category: "BRAWL",
    type: "configure",
    targetPlace: "vault",
    required: 2,
    difficulty: "medium",
    reward: { text: "+0.3 spirits, the agent is leashed twice over", spirits: 0.3 },
  },
  {
    title: "A Row for Every Close",
    description: "Close two trades. Each closes between its stop and its target, and the Stone takes one row apiece.",
    category: "BRAWL",
    type: "record",
    targetPlace: "bank",
    required: 2,
    difficulty: "medium",
    reward: { text: "+0.34 spirits, two rows on the Stone", spirits: 0.34 },
  },

  // ── Expansion: fifty more jobs for the outer districts ──────────────────
  // Same contract as the table above: every template names a building that
  // exists in LOCATIONS AND sits in NPC_ALL_PLACES (a quest pointing at a
  // place no resident is ever sent to is an unfinishable quest that fails
  // silently), `fetch` only grazes at Food-category buildings, `explore`
  // lists distinct places and never asks for more stops than it lists, and
  // `talk` names a single building because the matcher keys on targetPlace.
  {
    title: "Tool Store Audit",
    description: "Take stock of the Shed four times. Everything in it is present; nothing in it is where it should be.",
    category: "Work",
    type: "work",
    targetPlace: "shed",
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, the tool you wanted is on the third shelf", spirits: 0.22 },
  },
  {
    title: "Board Wipe",
    description: "Scrub the Notice Board three times. Yesterday's notice is under today's, which is under nothing at all.",
    category: "Daily",
    type: "work",
    targetPlace: "board",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.18 spirits, legible again for an hour", spirits: 0.18 },
  },
  {
    title: "Kiln Watch",
    description: "Tend the Kiln four times. The fire does not care whose shift it is, but the shift still has to happen.",
    category: "Work",
    type: "work",
    targetPlace: "kiln",
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, fired on schedule", spirits: 0.24 },
  },
  {
    title: "Ore Belt",
    description: "Work the Ore Shed five times. Heavy, grey, and worth considerably more than it looks.",
    category: "Work",
    type: "work",
    targetPlace: "oreShed",
    required: 5,
    difficulty: "hard",
    reward: { text: "+0.28 spirits, five shifts of honest weight", spirits: 0.28 },
  },
  {
    title: "Dock Hands",
    description: "Work the Dock four times. Everything arriving arrives badly, and somebody has to be standing there when it does.",
    category: "Work",
    type: "work",
    targetPlace: "dock",
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, the cargo survived", spirits: 0.24 },
  },
  {
    title: "Beacon Tending",
    description: "Tend the Beacon three times. Three fires that exist only to be seen from very far away.",
    category: "Work",
    type: "work",
    targetPlace: "beacon",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, visible from the far shore", spirits: 0.24 },
  },
  {
    title: "Net Mending",
    description: "Mend nets in the Net Loft four times. A hole mended today is a fish nobody has to explain away in spring.",
    category: "Work",
    type: "work",
    targetPlace: "netloft",
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, mesh accounted for", spirits: 0.24 },
  },
  {
    title: "Orangery Duty",
    description: "Take the Orangery shift three times. Trees that insist on a roof, in a town that mostly does not have one.",
    category: "Work",
    type: "work",
    targetPlace: "orangery",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, citrus unharmed", spirits: 0.22 },
  },
  {
    title: "Hall Porter",
    description: "Porter duty in the Hall four times. Someone carries the minutes in and the excuses out.",
    category: "Work",
    type: "work",
    targetPlace: "hall",
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, the doors held open", spirits: 0.24 },
  },
  {
    title: "Weigh Station",
    description: "Weigh in at the Quarry Office three times. Every ton is measured twice and believed once.",
    category: "Work",
    type: "work",
    targetPlace: "quarryOffice",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, the scale agreed", spirits: 0.22 },
  },
  {
    title: "Charcoal Rake",
    description: "Rake the Charcoal Yard four times. Black hands and honest arithmetic.",
    category: "Work",
    type: "work",
    targetPlace: "charcoalYard",
    required: 4,
    difficulty: "hard",
    reward: { text: "+0.26 spirits, the heaps are even", spirits: 0.26 },
  },
  {
    title: "Slag Shift",
    description: "Work the Slag Heap five times. The Ironworks' waste, and the town's favourite shortcut.",
    category: "Work",
    type: "work",
    targetPlace: "slagHeap",
    required: 5,
    difficulty: "hard",
    reward: { text: "+0.28 spirits, the shortcut is clear", spirits: 0.28 },
  },
  {
    title: "Outer Gate Count",
    description: "Count the Outer Gate three times. In, out, in again — the ledger agrees with itself by evening.",
    category: "Daily",
    type: "visit",
    targetPlace: "outerGate",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, the count balances", spirits: 0.16 },
  },
  {
    title: "Ferry Timetable",
    description: "Check the Ferry Slip three times. The timetable is a rumour with a painted board beside it.",
    category: "Daily",
    type: "visit",
    targetPlace: "ferrySlip",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, the boat was roughly on time", spirits: 0.16 },
  },
  {
    title: "Hedge Trimming Watch",
    description: "Walk the Hedge Maze twice. It has been clipped into a shape nobody will admit to choosing.",
    category: "Daily",
    type: "visit",
    targetPlace: "hedgeMaze",
    required: 2,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, found the exit", spirits: 0.16 },
  },
  {
    title: "Rosewalk Morning",
    description: "Three mornings on the Rosewalk. The roses remain entirely unbothered by any of it.",
    category: "Daily",
    type: "visit",
    targetPlace: "rosewalk",
    required: 3,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, thorns noted", spirits: 0.16 },
  },
  {
    title: "Apiary Count",
    description: "Call at the Apiary twice. The bees file better reports than the Hall does.",
    category: "Daily",
    type: "visit",
    targetPlace: "apiary",
    required: 2,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, hives in order", spirits: 0.16 },
  },
  {
    title: "Tollhouse Queue",
    description: "Work the Tollhouse queue three times. Two coins in, one argument out, and the road stays open.",
    category: "Work",
    type: "visit",
    targetPlace: "tollhouse",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.2 spirits, the road paid for itself", spirits: 0.2 },
  },
  {
    title: "Boathouse Rope",
    description: "Inspect the Boathouse three times. Rope, tar, and one boat that is only mostly theirs.",
    category: "Work",
    type: "visit",
    targetPlace: "boathouse",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.2 spirits, the mooring held", spirits: 0.2 },
  },
  {
    title: "Lodge Stove",
    description: "See to the Lodge stove twice. Cold guests remember faces long after they forget names.",
    category: "Daily",
    type: "visit",
    targetPlace: "lodge",
    required: 2,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, the room stayed warm", spirits: 0.16 },
  },
  {
    title: "Annex Night Watch",
    description: "Three nights at the Observatory Annex. The recalibration runs long and nobody else volunteers.",
    category: "Exploration",
    type: "visit",
    targetPlace: "observatoryAnnex",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, the stars held still", spirits: 0.22 },
  },
  {
    title: "Paddock Gate",
    description: "Shut the Paddock gate twice. The sheep test it every night and the gate knows all of them by now.",
    category: "Daily",
    type: "visit",
    targetPlace: "paddock",
    required: 2,
    difficulty: "easy",
    reward: { text: "+0.16 spirits, all accounted for", spirits: 0.16 },
  },
  {
    title: "The Store Room Round",
    description: "Shed, Notice Board, Barn, Pens — four places where things are kept and counted badly.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["shed", "board", "barn", "pens"],
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.28 spirits, the stores walked", spirits: 0.28 },
  },
  {
    title: "The Water Row",
    description: "Pond, Millpond, River Run, River Mouth. Four waters, one heron, no agreement on fishing rights.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["pond", "millpond", "riverRun", "riverMouth"],
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.28 spirits, all four waters seen to", spirits: 0.28 },
  },
  {
    title: "The North Road",
    description: "Outer Gate, Curtain Wall, Beacon, Watchtower — the whole northern edge walked in one go.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["outerGate", "curtainWall", "beacon", "watchtower"],
    required: 4,
    difficulty: "hard",
    reward: { text: "+0.3 spirits, the edge held", spirits: 0.3 },
  },
  {
    title: "The Wharf Evening",
    description: "Wharf, Ferry Slip, River Wall, Net Loft. Dusk is when the wharf stops pretending to be respectable.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["wharf", "ferrySlip", "riverWall", "netloft"],
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.28 spirits, the evening's haul reviewed", spirits: 0.28 },
  },
  {
    title: "The Commons Walk",
    description: "Bandstand, Rosewalk, Hedge Maze, Aviary — the soft end of town, walked hard.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["bandstand", "rosewalk", "hedgeMaze", "aviary"],
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.28 spirits, four gentle stops logged", spirits: 0.28 },
  },
  {
    title: "The Craft Row",
    description: "Smithy, Forge, Foundry, Kiln — four fires in a row and every one of them hot.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["smithy", "forge", "foundry", "kiln"],
    required: 4,
    difficulty: "hard",
    reward: { text: "+0.3 spirits, the row crossed without burns", spirits: 0.3 },
  },
  {
    title: "The Reading Round",
    description: "Library, Press, Archive, Scriptorium. Reading, printing, misfiling — the complete cycle.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["library", "press", "archive", "scriptorium"],
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.28 spirits, filed under somewhere", spirits: 0.28 },
  },
  {
    title: "The Night Round",
    description: "Fire, Barn, Stables, Farmhouse. Where the whole town sleeps, checked once while it sleeps.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["fire", "barn", "stables", "farmhouse"],
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.28 spirits, four doorways quiet", spirits: 0.28 },
  },
  {
    title: "The Errand Row",
    description: "Square, Hall, School, Clinic — four stops, not one of them optional.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["square", "hall", "school", "clinic"],
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.28 spirits, the errands are done", spirits: 0.28 },
  },
  {
    title: "The Watch Road",
    description: "Tollhouse, Barracks, North Stables, Outer Gate — the watch's own loop, walked at their pace for once.",
    category: "Exploration",
    type: "explore",
    targetPlaces: ["tollhouse", "barracks", "northStables", "outerGate"],
    required: 4,
    difficulty: "hard",
    reward: { text: "+0.3 spirits, the watch relieved", spirits: 0.3 },
  },
  {
    title: "Dockside Rumors",
    description: "Three arguments by the Dock. Half of what lands here is cargo and the other half is news.",
    category: "Social",
    type: "talk",
    targetPlace: "dock",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, both halves unloaded", spirits: 0.22 },
  },
  {
    title: "Market Gossip",
    description: "Three conversations in the Market. Prices are discussed; none of them move.",
    category: "Social",
    type: "talk",
    targetPlace: "market",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, the gossip traded twice", spirits: 0.22 },
  },
  {
    title: "Bench Philosophy",
    description: "Three talks on the Square bench. Somebody is always wrong there, and it is usually the speaker.",
    category: "Social",
    type: "talk",
    targetPlace: "square",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, none the wiser", spirits: 0.22 },
  },
  {
    title: "Sickbed Manners",
    description: "Three calls at the Clinic. The patients want company and the healer wants the bed back.",
    category: "Social",
    type: "talk",
    targetPlace: "clinic",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, bed reclaimed", spirits: 0.22 },
  },
  {
    title: "Wharf Barter Talk",
    description: "Three rounds of haggling at the Wharf. The first price quoted is a formality and everyone knows it.",
    category: "Social",
    type: "talk",
    targetPlace: "wharf",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, the discount imagined", spirits: 0.22 },
  },
  {
    title: "Gate Gossip",
    description: "Three chats at the Gatehouse. Everyone passes through; nobody passes unremarked.",
    category: "Social",
    type: "talk",
    targetPlace: "gatehouse",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, the gate keeps nothing secret", spirits: 0.22 },
  },
  {
    title: "Firelit Theory",
    description: "Three evenings of talk at the Fire. Every theory improves after dark and none survive the morning.",
    category: "Social",
    type: "talk",
    targetPlace: "fire",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, the embers agreed", spirits: 0.22 },
  },
  {
    title: "Stall Forum",
    description: "Four posts and replies traded among the Market stalls. The stallholders vote with their volume.",
    category: "Social",
    type: "social",
    targetPlace: "market",
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, the floor has spoken", spirits: 0.24 },
  },
  {
    title: "Commons Bulletin",
    description: "Three posts pinned at the Notice Board. Whoever writes largest is currently winning the argument.",
    category: "Social",
    type: "social",
    targetPlace: "board",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, ink dry", spirits: 0.22 },
  },
  {
    title: "Inn Corner Debate",
    description: "Four replies in the Inn corner table. The argument is older than the furniture and just as stuck.",
    category: "Social",
    type: "social",
    targetPlace: "inn",
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, the round bought", spirits: 0.24 },
  },
  {
    title: "Bathhouse Thread",
    description: "Three posts from the Baths. Said at full voice, in a room where everything echoes.",
    category: "Social",
    type: "social",
    targetPlace: "baths",
    required: 3,
    difficulty: "medium",
    reward: { text: "+0.22 spirits, the echo repeated it", spirits: 0.22 },
  },
  {
    title: "Station Small Talk",
    description: "Four replies at the Station. Everyone waiting is an expert on when the last one left.",
    category: "Social",
    type: "social",
    targetPlace: "station",
    required: 4,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, the wait discussed", spirits: 0.24 },
  },
  {
    title: "The Orchard Second Helping",
    description: "Graze the Orchard, the Trough and the East Meadow. Six grazes, and no apologies at any of them.",
    category: "Work",
    type: "fetch",
    targetPlaces: ["orchard", "trough", "meadowE"],
    required: 6,
    difficulty: "medium",
    reward: { text: "+0.24 spirits, three good feeds", spirits: 0.24 },
  },
  {
    title: "The Wet Grass Circuit",
    description: "North Meadow, East Meadow, South Meadow. Six grazes through grass that is only dew-cold at this hour.",
    category: "Work",
    type: "fetch",
    targetPlaces: ["northMeadow", "eastMeadow", "southMeadow"],
    required: 6,
    difficulty: "hard",
    reward: { text: "+0.28 spirits, the circuit finished wet", spirits: 0.28 },
  },
  {
    title: "The Long Graze",
    description: "West Orchard, West Meadow, East Meadow, Trough — eight grazes, the full length of the good grass.",
    category: "Work",
    type: "fetch",
    targetPlaces: ["westOrchard", "meadowW", "meadowE", "trough"],
    required: 8,
    difficulty: "hard",
    reward: { text: "+0.3 spirits, eight feeds in", spirits: 0.3 },
  },
  {
    title: "Set the Watch Alarm",
    description: "Set one leash rule on the Watchtower. The rule names a cap, and the cap is the whole argument.",
    category: "BRAWL",
    type: "configure",
    targetPlace: "watchtower",
    required: 1,
    difficulty: "medium",
    reward: { text: "+0.3 spirits, the leash set once", spirits: 0.3 },
  },
  {
    title: "Shadow the Courier",
    description: "Follow one caller out of the Station. The Courier gives no second chance for being followed.",
    category: "BRAWL",
    type: "follow",
    targetPlace: "station",
    required: 1,
    difficulty: "medium",
    reward: { text: "+0.3 spirits, kept up with the post", spirits: 0.3 },
  },
  {
    title: "Close on the Exchange",
    description: "Close one trade on the Exchange. One row, one price, and no negotiation after the fact.",
    category: "BRAWL",
    type: "record",
    targetPlace: "exchange",
    required: 1,
    difficulty: "medium",
    reward: { text: "+0.34 spirits, one row on the Stone", spirits: 0.34 },
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

/**
 * How many live quests the board holds.
 *
 * The board is the job list residents pick from, so this is a slot count, not a
 * template count: the pool behind it is `TEMPLATES` (110), and every slot draws
 * one template when it opens. 50 is one slot per resident on a fresh town, so a
 * visitor sees the whole herd at work instead of six cards and an empty field.
 */
export const QUEST_ACTIVE_TARGET = 50;

/**
 * Hard cap on stored rows: the live target plus recent history
 * (completed/claimed/expired). Trimming removes history first — a retired row
 * is the cheapest thing to lose — and only falls back to live rows when a race
 * pushed the live count past the target (see refreshExpiredQuests).
 */
export const QUEST_BOARD_CAP = 60;

export function createInitialQuests(world: TownSnapshot): Quest[] {
  const rng = () => Math.random();
  // The fresh board is one template per live slot. 50 of 110 means the first
  // board a visitor sees is already varied, not eight rows out of a hundred
  // buildings.
  const shuffled = [...TEMPLATES].sort(() => rng() - 0.5);
  const chosen = shuffled.slice(0, Math.min(QUEST_ACTIVE_TARGET, TEMPLATES.length));
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

/**
 * Quests are worker-pool property of REGISTERED agents (operator decision,
 * 2026-10-30): a resident driven only by the sim — the house bots first —
 * cannot take on, activate, advance, or finish a quest. The gate is the agent
 * registry: only a resident an agent record points at is a worker. Every
 * progress event passes this one gate, whichever route produced it.
 *
 * A world with no `agents` key at all is not gated: tests build bare towns,
 * and a save written before the registry existed has no worker pool to check
 * against — progression then behaves exactly as it did before this gate.
 * Production towns carry the registry (`world.agents ??= []` on first join
 * seeds it), so the gate is live wherever it matters.
 */
export function isRegisteredWorker(world: TownSnapshot, residentId: string): boolean {
  const agents = (world as { agents?: Array<{ residentId?: string }> }).agents;
  if (!Array.isArray(agents)) return true; // legacy shape, see comment above
  return agents.some((a) => a?.residentId === residentId);
}

export function updateQuestProgress(world: TownSnapshot, evt: { act: string; place: string; agentId: string; postKind?: string }): Quest[] {
  const updated: Quest[] = [];
  // The registered-worker gate: an unregistered resident (house bots, forked
  // town bodies on sim turns) arrives here only from the sim loop, and none of
  // their actions may touch the board.
  if (!isRegisteredWorker(world, evt.agentId)) return updated;
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
  // Registered agents only: a resident the sim drives alone — the house bots —
  // never takes a quest on, even if some caller handed their id over.
  if (!isRegisteredWorker(world, workerId)) {
    return { ok: false, error: "quests are for registered agents only" };
  }
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
  // Same registered-worker rule at payout: a claim attributed to a resident the
  // registry does not know is refused rather than paid.
  if (claimedBy && !isRegisteredWorker(world, claimedBy)) {
    return { ok: false, error: "quests are for registered agents only" };
  }
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

/**
 * Retire quests whose horizon has passed.
 *
 * Pre-2026-10-31 this FILTERED the expired quests out of `world.quests`. Under
 * the shared store that is a delete — and the merge union resurrects a quest
 * the row still holds: whichever instance has not yet run this function writes
 * it back, so expiry never actually landed (the stalled orphan quests on the
 * production board rode that loop). Now the quest is MARKED `expired` instead
 * — additive, the same answer the herd's tombstones give: removal is state,
 * not absence. The monotonic quest merge rule (`newerQuest`) then keeps an
 * expired row expired against any instance still carrying it as active.
 *
 * Claims and completions are never retired here — those stay board
 * history. A quest written before `expiresAt` existed gets its horizon derived
 * from `createdAt` (+24h, the same window generateQuest grants), so the oldest
 * saves cannot ride the board forever either.
 */
export function refreshExpiredQuests(world: TownSnapshot): void {
  const now = Date.now();
  const horizon = 24 * 60 * 60 * 1000;
  let expiredCount = 0;
  for (const q of world.quests) {
    if (q.status !== "available" && q.status !== "active") continue;
    const expiresAt = q.expiresAt ?? (q.createdAt + horizon);
    if (now > expiresAt) {
      q.status = "expired";
      expiredCount++;
    }
  }
  // Top the board back up to its full slot count.
  const isLive = (q: Quest): boolean => q.status === "available" || q.status === "active";
  let live = world.quests.filter(isLive).length;
  while (live < QUEST_ACTIVE_TARGET) {
    world.quests.push(generateQuest(world));
    live++;
  }
  // Two cold instances can top up the same short board at once and then merge
  // their generations, leaving more live quests than there are slots. Generated
  // quests are appended, so keeping the NEWEST live rows drops the duplicates
  // (and any stale pre-deploy rows) instead of letting the board drift up; the
  // next instance that loads the row sees a full board and generates nothing, so
  // this converges after one save cycle.
  if (live > QUEST_ACTIVE_TARGET) {
    let excess = live - QUEST_ACTIVE_TARGET;
    world.quests = world.quests.filter((q) => {
      if (excess <= 0 || !isLive(q)) return true;
      excess--;
      return false;
    });
  }
  // History is retired first. A finished row is board record, not work, so it is
  // the cheapest thing to lose when the cap is reached; live rows are only ever
  // trimmed above, against the slot target.
  if (world.quests.length > QUEST_BOARD_CAP) {
    let excess = world.quests.length - QUEST_BOARD_CAP;
    world.quests = world.quests.filter((q) => {
      if (excess <= 0 || isLive(q)) return true;
      excess--;
      return false;
    });
  }
}
