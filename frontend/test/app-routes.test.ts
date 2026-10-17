import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Route.page is a plain `string`, not a union of literals, so a Link to="vault"
// paired with page === "vautl" type-checks, ships, and shows "Unknown page" to
// everyone who clicks it. Nothing else in the app can catch that: tsc never
// compares the two literals, and there is no browser in the gate. This pins the
// three lists App.tsx keeps — nav targets, route cases, and the known-page
// allowlist — against each other, the same way map-overlay-theme.test.ts pins
// the token blocks by reading the source.

const APP = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");

function matches(re: RegExp): string[] {
  return [...APP.matchAll(re)].map((m) => m[1]!);
}

/** Every `{page === "x" && <View …/>}` case. */
const routeCases = [...new Set(matches(/page === "([^"]+)"/g))].sort();

/** Every `<Link to="x">` — both the masthead nav and the inline links. */
const linkTargets = [...new Set(matches(/<Link to="([^"]+)"/g))].sort();

/** The known-page allowlist that suppresses the "Unknown page" card. */
const allowlist = (() => {
  const block = APP.match(/!\[([^\]]+)\]\.includes\(page\)/);
  expect(block, "known-page allowlist not found in App.tsx").toBeTruthy();
  return [...block![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
})();

describe("App.tsx routing", () => {
  it("every link points at a page that has a route", () => {
    const orphans = linkTargets.filter((t) => !routeCases.includes(t));
    expect(orphans, "these Link targets have no `page === …` case").toEqual([]);
  });

  it("every routed page is on the known-page allowlist", () => {
    const missing = routeCases.filter((p) => !allowlist.includes(p));
    expect(missing, "these routes would still render the Unknown page card").toEqual([]);
  });

  it("every allowlisted page has a route to render", () => {
    const dead = allowlist.filter((p) => !routeCases.includes(p));
    expect(dead, "these allowlisted pages render nothing but Unknown page").toEqual([]);
  });

  it("the BRAWL rail and content pages are all wired", () => {
    // P2 + P3 + P4: the ten routes added for the rail and the content pages. A
    // rename here without the matching nav link and allowlist entry is caught
    // by the three tests above; this one catches a route dropped outright.
    for (const page of [
      "vault", "ledger", "scales", "bestiary", "elder", "testnet", "guild", "notice",
      "faq", "spellbook",
    ]) {
      expect(routeCases, `missing route for #/${page}`).toContain(page);
      expect(linkTargets, `no nav link to #/${page}`).toContain(page);
      expect(allowlist, `#${page} not on the allowlist`).toContain(page);
    }
  });

  it("keeps the pre-existing pages reachable", () => {
    for (const page of ["town", "herd", "feed", "brawl", "docs", "llama", "contest"]) {
      expect(routeCases).toContain(page);
      expect(allowlist).toContain(page);
    }
  });
});
