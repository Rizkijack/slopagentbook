import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Blueprint §6.4 names four motion rules. Three of them had no rule anywhere in
// the repo until this pass: there was no `prefers-reduced-motion` block at all,
// the second breakpoint (600px) was missing, and no button pressed on :active.
// These tests exist because every one of those is a rule that can be deleted
// silently — nothing in a render test notices a media query that is gone.
//
// The reduced-motion assertions are less obvious than they look. `.stagger > *`
// starts at `opacity: 0` and relies on its animation's `forwards` fill to
// become visible, so the obvious implementation of this media query —
// `animation: none` — renders every staggered card invisible forever. The
// duration has to collapse to ~0 with the fill intact, not to "none". That is
// asserted below rather than left as a comment nobody re-reads.

const TOKENS = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
const GLOBAL = readFileSync(resolve(import.meta.dirname, "../src/styles/global.css"), "utf8");

/** Body of the rule whose selector header is `header`. */
function block(css: string, header: string): string {
  const start = css.indexOf(header);
  if (start < 0) throw new Error(`rule not found: ${header}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${header}`);
}

/** CSS with block comments removed — a class named in prose is not a class. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("§6.4 — prefers-reduced-motion turns the motion off", () => {
  const body = block(TOKENS, "@media (prefers-reduced-motion: reduce)");

  it("the query exists at all", () => {
    expect(TOKENS).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("collapses animation and transition durations to ~0", () => {
    expect(body).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(body).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(body).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(body).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it("covers pseudo-elements too — the theme toggle dot animates there", () => {
    // `.theme-toggle .dot::before` carries the transform that shows which theme
    // is active, and it is reached through a pseudo-element. `*` alone would
    // leave it transitioning.
    expect(body).toMatch(/\*::before/);
    expect(body).toMatch(/\*::after/);
  });

  it("does NOT use `animation: none` — that would hide every staggered card", () => {
    // global.css starts `.stagger > *` at opacity 0 and animates to 1 with a
    // `forwards` fill. Kill the animation and the fill goes with it, so the
    // cards stay at opacity 0 permanently. This is the one way to get this
    // media query catastrophically wrong.
    expect(body).not.toMatch(/animation:\s*none/);
    expect(GLOBAL).toMatch(/\.stagger > \*\s*\{[^}]*opacity:\s*0/);
    expect(GLOBAL).toMatch(/animation:\s*rise[^;]*forwards/);
  });

  it("zeroes animation-delay — the 0.02s–0.18s stagger is travel too", () => {
    expect(body).toMatch(/animation-delay:\s*0s\s*!important/);
    expect(body).toMatch(/transition-delay:\s*0s\s*!important/);
    // and the delays it is cancelling really are there
    expect(GLOBAL).toMatch(/animation-delay:\s*0\.18s/);
  });
});

describe("§6.4 — buttons press when held", () => {
  it(".pbtn does not exist, so the rule went to the buttons that do", () => {
    // The blueprint names `.pbtn`. No component has ever used that class, so
    // defining it would be dead CSS. The behaviour belongs to real buttons.
    // Stripped of comments first: the rule's own comment explains this, and
    // prose about a class must not read as a declaration of one.
    expect(stripComments(TOKENS)).not.toContain(".pbtn");
  });

  it.each([".btn", ".btn-ghost", ".theme-toggle"])("%s presses at scale 0.97", (sel) => {
    const body = block(TOKENS, `${sel}:active`);
    expect(body).toMatch(/transform:\s*scale\(0\.97\)/);
  });

  it("transform joins the transition list so the press eases", () => {
    const body = block(TOKENS, ".btn,\n.btn-ghost,\n.theme-toggle {");
    expect(body).toMatch(/transition-property:[^;]*transform/);
  });
});

describe("§6.4 — slider thumb is gold and framed", () => {
  it("the control opts out of the UA appearance, or Chrome ignores the thumb", () => {
    const body = block(TOKENS, 'input[type="range"] {');
    expect(body).toMatch(/-webkit-appearance:\s*none/);
    expect(body).toMatch(/appearance:\s*none/);
  });

  it.each(["::-webkit-slider-thumb", "::-moz-range-thumb"])("%s is gold with a frame", (pseudo) => {
    const body = block(TOKENS, `input[type="range"]${pseudo} {`);
    expect(body).toMatch(/background:\s*var\(--accent\)/);
    expect(body).toMatch(/border:\s*2px solid var\(--ink\)/);
  });

  it("restyles the track too — appearance:none takes the track down with it", () => {
    expect(TOKENS).toContain("::-webkit-slider-runnable-track");
    expect(TOKENS).toContain("::-moz-range-track");
  });
});

describe("§6.4 — two responsive breakpoints", () => {
  it.each([900, 600])("collapses at %spx", (px) => {
    expect(TOKENS).toContain(`@media (max-width: ${px}px)`);
  });

  it("the masthead wraps at 600px — ~20 nav links never fit a phone", () => {
    const body = block(TOKENS, "@media (max-width: 600px)");
    expect(body).toMatch(/\.masthead\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(body).toMatch(/\.masthead nav\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});

describe("§6.4 — the block adds no raw hex", () => {
  it("colour comes from tokens", () => {
    // Sliced on the section comment, then stripped of comments: a hex written
    // inside a comment is prose about colour, not a colour.
    const motion = stripComments(TOKENS.slice(TOKENS.indexOf("§6.4 Gerak (motion)")));
    expect(motion).not.toMatch(/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/);
  });
});