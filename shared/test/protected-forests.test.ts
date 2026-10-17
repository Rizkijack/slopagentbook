import { describe, it, expect } from "vitest";
import {
  DISTRICT_PARCELS,
  GROVE_SPECS,
  PROTECTED_FOREST_SPECS,
  PROTECTED_FOREST_SUFFIX,
} from "../src/mapdata.js";

/**
 * The rule the metropolitan districts are built against: every one of them is
 * owed a protected forest, and the country districts are not.
 *
 * This lives in shared because the guarantee is a relationship between three
 * tables — the parcels, the grove specs and the protected-forest specs — and a
 * test in any one consumer only sees two of them. `scenery.ts` checks that the
 * wood was actually placed inside the right parcel; this checks that the parcel
 * was owed one in the first place.
 */
describe("protected forests", () => {
  const metro = DISTRICT_PARCELS.filter((d) => d.metro);
  const country = DISTRICT_PARCELS.filter((d) => !d.metro);

  it("has at least one metropolitan district and at least one country district", () => {
    // Both halves of the rule need something to stand on. A table where every
    // district is metropolitan would make the flag meaningless and the tests
    // below would pass while checking nothing.
    expect(metro.length, "metropolitan districts").toBeGreaterThan(0);
    expect(country.length, "country districts").toBeGreaterThan(0);
  });

  it("owes each metropolitan district exactly one protected forest", () => {
    for (const d of metro) {
      const owned = PROTECTED_FOREST_SPECS.filter((f) => f.parcel === d.name);
      expect(owned, `${d.name} is metropolitan but owns ${owned.length} protected forest(s)`).toHaveLength(1);
    }
    expect(PROTECTED_FOREST_SPECS).toHaveLength(metro.length);
  });

  it("never points a protected forest at a country district", () => {
    // The complement, and the one that fails quietly: a forest filed under
    // farmland satisfies a count while protecting nobody.
    for (const f of PROTECTED_FOREST_SPECS) {
      const parcel = DISTRICT_PARCELS.find((d) => d.name === f.parcel);
      expect(parcel, `no parcel named ${f.parcel}`).toBeTruthy();
      expect(parcel!.metro, `${f.name} is filed under ${f.parcel}, which is not metropolitan`).toBe(true);
    }
  });

  it("names every protected forest with the suffix the renderer matches on", () => {
    // scenery.ts draws the boundary by suffix rather than by a separate list, so
    // a wood named without it would be placed, paved over and never fenced —
    // present in the data and invisible on the map.
    for (const f of PROTECTED_FOREST_SPECS) {
      expect(f.name.endsWith(PROTECTED_FOREST_SUFFIX), `${f.name} is missing the suffix`).toBe(true);
      expect(f.name.slice(0, -PROTECTED_FOREST_SUFFIX.length), `${f.name} does not name its district`).toBe(f.parcel);
    }
  });

  it("leaves the country districts their groves, and gives none to the metro ones", () => {
    // One wood per parcel, named for what it is. Two woods competing for the same
    // ground is what left the dense parcels unable to hold either.
    for (const d of country) {
      const owned = GROVE_SPECS.filter((g) => g.parcel === d.name);
      expect(owned, `${d.name} is country but owns ${owned.length} grove(s)`).toHaveLength(1);
    }
    for (const d of metro) {
      expect(GROVE_SPECS.filter((g) => g.parcel === d.name), `${d.name} still owns a grove`).toHaveLength(0);
    }
  });

  it("never lets a grove and a protected forest name the same parcel", () => {
    const both = GROVE_SPECS.filter((g) => PROTECTED_FOREST_SPECS.some((f) => f.parcel === g.parcel));
    expect(both.map((g) => g.parcel)).toEqual([]);
  });

  it("keeps every wood inside the parcel it belongs to", () => {
    // the specs carry no position, so what is checkable here is that the request
    // itself is not larger than the parcel it asked for
    for (const spec of [...GROVE_SPECS, ...PROTECTED_FOREST_SPECS]) {
      const p = DISTRICT_PARCELS.find((d) => d.name === spec.parcel)!;
      expect(spec.w, `${spec.name} is wider than ${spec.parcel}`).toBeLessThan(p.w);
      expect(spec.h, `${spec.name} is taller than ${spec.parcel}`).toBeLessThan(p.h);
    }
  });
});
