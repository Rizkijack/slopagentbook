import { describe, it, expect } from "vitest";
import type { QuestType } from "@slopagentbook/shared";
import { NPC_ALL_PLACES } from "@slopagentbook/shared";
import { QUEST_TEMPLATES } from "../src/quests.js";
import { LOCATIONS } from "../src/locations.js";

// Every quest points at a building. Every building in LOCATIONS exists.
//
// This is the second time this repo has been bitten by a copied id table, so
// this test imports LOCATIONS — the one owner, which also exports
// LOCATION_BY_ID from the same array — rather than restating the list. A
// hand-copied "targetPlace" is a quest no resident can ever complete: it sits on
// the board until it expires, looks like a broken feature, and never throws
// anything to tell you which id was wrong.
//
// The second half of the same failure is quieter still: an id that resolves in
// LOCATIONS but that residents never visit, or that the matcher cannot count,
// is just as uncompletable and just as silent. Those are asserted too — see the
// reachability and fetch-only-on-Food tests below.

const LOCATION_IDS = new Set(LOCATIONS.map((l) => l.id));
const FOOD_IDS = new Set(LOCATIONS.filter((l) => l.category === "Food").map((l) => l.id));

/** Every place a template names, as `[templateTitle, placeId]` pairs. */
function referencedPlaces(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const tpl of QUEST_TEMPLATES) {
    if (tpl.targetPlace) out.push([tpl.title, tpl.targetPlace]);
    for (const place of tpl.targetPlaces ?? []) out.push([tpl.title, place]);
  }
  return out;
}

describe("quest templates name a building", () => {
  it("every template has a targetPlace or a targetPlaces", () => {
    // A location-less template is not a town job, it is a counter. It also has
    // nowhere to render — a quest with no place shows the worker nothing about
    // where to go.
    const homeless = QUEST_TEMPLATES.filter((t) => !t.targetPlace && !(t.targetPlaces && t.targetPlaces.length > 0)).map(
      (t) => t.title,
    );
    expect(homeless, "templates with no building at all").toEqual([]);
  });

  it("every targetPlace resolves in LOCATIONS", () => {
    const bad: string[] = [];
    for (const [title, place] of referencedPlaces()) {
      if (!LOCATION_IDS.has(place)) bad.push(`${title} -> "${place}"`);
    }
    // The offending ids are in the failure message on purpose: the whole cost of
    // this bug is knowing which string was wrong.
    expect(bad, `quest targets a building that does not exist:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("every entry of every targetPlaces resolves in LOCATIONS", () => {
    for (const tpl of QUEST_TEMPLATES) {
      for (const place of tpl.targetPlaces ?? []) {
        expect(LOCATION_IDS.has(place), `template "${tpl.title}" names unknown location "${place}"`).toBe(true);
      }
    }
  });

  it("no template names the same building twice in its own targetPlaces", () => {
    // A repeat is a place that reads as two stops and counts once, so `required`
    // can never be reached.
    for (const tpl of QUEST_TEMPLATES) {
      const places = tpl.targetPlaces ?? [];
      const dupes = places.filter((p, i) => places.indexOf(p) !== i);
      expect(dupes, `template "${tpl.title}" repeats ${JSON.stringify(dupes)}`).toEqual([]);
    }
  });

  it("required never exceeds what the template can actually count", () => {
    // explore counts DISTINCT places, so required above the place count is
    // arithmetically impossible. Everything else counts repeats, so it is not.
    for (const tpl of QUEST_TEMPLATES) {
      if (tpl.type === "explore") {
        const places = tpl.targetPlaces?.length ?? 0;
        expect(
          tpl.required,
          `explore template "${tpl.title}" needs ${tpl.required} distinct visits but lists ${places}`,
        ).toBeLessThanOrEqual(places);
      }
    }
  });
});

describe("quest templates reach buildings residents actually visit", () => {
  it("every named place is somewhere a resident is sent", () => {
    // NPC_ALL_PLACES is the wander/need pool in shared/src/skills.ts. A quest
    // naming a place outside it can never be visited, however real the building
    // is — and unlike a bad id, this one cannot be spotted by eye.
    const reachable = new Set<string>(NPC_ALL_PLACES);
    const bad: string[] = [];
    for (const [title, place] of referencedPlaces()) {
      if (!reachable.has(place)) bad.push(`${title} -> "${place}"`);
    }
    expect(bad, `quest targets a place no resident is ever sent to:\n  ${bad.join("\n  ")}`).toEqual([]);
  });

  it("fetch templates only name places residents can graze at", () => {
    // The match is `type === "fetch" && act === "graze" && targetPlaces.includes(place)`.
    // graze fires only from simbrain's eat-food and busy-graze rules, which draw
    // from NPC_FOOD_PLACES — the Food-category buildings. A fetch quest on any
    // other building is well-formed, resolves in LOCATIONS, and can never move.
    for (const tpl of QUEST_TEMPLATES) {
      if (tpl.type !== "fetch") continue;
      for (const place of tpl.targetPlaces ?? []) {
        expect(FOOD_IDS.has(place), `fetch template "${tpl.title}" asks for grazing at "${place}", which is not a Food building`).toBe(true);
      }
    }
  });
});

describe("quest pool coverage", () => {
  it("every QuestType has at least one template", () => {
    // A type no template carries can never appear in a town, so its mechanic is
    // dead code that no runtime ever exercises.
    const carried = new Set<QuestType>(QUEST_TEMPLATES.map((t) => t.type));
    const missing = (["visit", "talk", "fetch", "work", "explore", "social", "configure", "follow", "record"] as QuestType[]).filter(
      (t) => !carried.has(t),
    );
    expect(missing, `quest types no template can ever produce: ${missing.join(", ")}`).toEqual([]);
  });

  it("the pool spreads across the map instead of clustering in the core", () => {
    // 16 of 100 buildings were reachable before this expansion, which left most
    // of the town dead to the quest system. This is the regression guard: a
    // future trim that silently shrinks coverage back toward the core fails here.
    const distinct = new Set(referencedPlaces().map(([, place]) => place));
    expect(
      distinct.size,
      `templates reach only ${distinct.size} of ${LOCATIONS.length} buildings`,
    ).toBeGreaterThanOrEqual(60);
  });
});
