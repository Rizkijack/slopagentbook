import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The herd grid lost its third column off the right edge of the page.
//
// `grid-template-columns: repeat(3, 1fr)` is `minmax(auto, 1fr)`, and `auto`
// floors a track at its items' min-content width. A resident card renders its
// name and bio as `white-space: nowrap` + ellipsis, so a card with a long one
// of those widened its entire column past its share; the tracks stopped
// dividing the page column evenly, the last one ran outside the viewport, and
// the page grew a horizontal scrollbar. The floor is the defect — the ellipsis
// is what is supposed to absorb long text, so a track minimum has to be 0.
//
// These are assertions about the stylesheet and the inline value, not about a
// rendered layout: jsdom has no layout engine, so there is no width here to
// measure. What can be pinned is the property that caused the bug.

const CSS = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
const TOWN = readFileSync(resolve(import.meta.dirname, "../src/views/TownView.tsx"), "utf8");

/** The body of one top-level rule, `selector` included. */
function ruleBody(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, `${selector} rule missing from tokens.css`).toBeGreaterThanOrEqual(0);
  return CSS.slice(start, CSS.indexOf("}", start));
}

describe("grid tracks cannot floor at their content", () => {
  for (const [selector, columns] of [[".grid-3", 3], [".grid-2", 2]] as const) {
    it(`${selector} declares ${columns} tracks of minmax(0, 1fr)`, () => {
      expect(ruleBody(selector)).toContain(`repeat(${columns}, minmax(0, 1fr))`);
    });
  }

  it("the masthead and its nav wrap instead of overflowing the page", () => {
    // 22 uppercase mono links plus the status block is wider than a 1920px
    // viewport, and an unwrapped flex row does not shrink: it took the right
    // end of the header — theme toggle, herd counter — off screen.
    expect(ruleBody(".masthead")).toContain("flex-wrap: wrap");
    expect(ruleBody(".masthead nav")).toContain("flex-wrap: wrap");
  });

  it("the town hero grid gives both columns an explicit 0 minimum", () => {
    const declared = /gridTemplateColumns:\s*"([^"]+)"/.exec(TOWN)?.[1];
    expect(declared, "town hero grid declaration missing").toBeTruthy();

    const tracks = declared!.split(/\s+(?=minmax)/);
    expect(tracks.length, "expected two tracks").toBe(2);
    for (const track of tracks) expect(track).toMatch(/^minmax\(0,\s*[\d.]+fr\)$/);

    // The responsive override keys off the serialized inline value. Change one
    // without the other and the page silently stops stacking below 900px.
    expect(TOWN).toContain(`div[style*="grid-template-columns: ${declared}"]`);
  });
});