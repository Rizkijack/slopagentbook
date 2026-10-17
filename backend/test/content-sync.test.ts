import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BESTIARY } from "../src/bestiary.js";
import { ELDER, elderNode } from "../src/elder.js";

// CONTENT SYNC (P4). The Bestiary and the Elder each ship TWICE — once on the
// rail, once as a frontend data module — because both sides deliberately keep
// their own shape: the wire `Monster` carries a category string, a hex accent
// and an icon token, while the card's carries a 1–5 ladder and an 8×8 sprite.
// Two shapes is the agreed design; two STORIES is the bug, and it is the bug
// this file exists to prevent: a keeper reading #/bestiary must not be told
// six different monsters than a client calling /api/brawl/bestiary.
//
// It also walks every `next` branch on both sides. The backend once offered a
// branch to a node id that did not exist; the UI never noticed because
// ElderDialog filters unknown ids, and the route test only walks root.next[0],
// so nothing else could see it.

const FE_BESTIARY = readFileSync(resolve(import.meta.dirname, "../../frontend/src/views/bestiary.ts"), "utf8");
const FE_ELDER = readFileSync(resolve(import.meta.dirname, "../../frontend/src/views/elder.ts"), "utf8");

/** Every `key: "value"` in source order. */
function quoted(src: string, key: string): string[] {
  const re = new RegExp(`\\b${key}:\\s*"([^"]*)"`, "g");
  return [...src.matchAll(re)].map((m) => m[1]!);
}

/** Every `key: [...]` literal, split into its quoted members. */
function arrays(src: string, key: string): string[][] {
  const re = new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`, "g");
  return [...src.matchAll(re)].map((m) => [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!));
}

describe("content sync — bestiary", () => {
  const feIds = quoted(FE_BESTIARY, "id");
  const feNames = quoted(FE_BESTIARY, "name");
  const feMitigation = quoted(FE_BESTIARY, "mitigation");

  it("both sides carry the same monsters, in the same order", () => {
    expect(feIds).toHaveLength(6);
    expect(feIds).toEqual(BESTIARY.map((m) => m.id));
    expect(feNames).toHaveLength(6);
    expect(feNames).toEqual(BESTIARY.map((m) => m.name));
  });

  it("the mitigation shown on the page is the sentence the API serves", () => {
    expect(feMitigation).toHaveLength(6);
    expect(feMitigation).toEqual(BESTIARY.map((m) => m.weak));
  });

  it("keeps the API's lookup id pinned by the route tests", () => {
    expect(BESTIARY.map((m) => m.id)).toContain("gap");
  });
});

describe("content sync — elder", () => {
  const feIds = quoted(FE_ELDER, "id");
  const feTopics = quoted(FE_ELDER, "topic");
  const feTexts = quoted(FE_ELDER, "text");
  const feNext = arrays(FE_ELDER, "next");

  it("both sides carry the same nodes, in the same order", () => {
    // The interface block also declares these fields; only the data rows are
    // quoted, so a count mismatch here means the parse and the content disagree.
    expect(feIds).toEqual(ELDER.map((n) => n.id));
    expect(feIds.length).toBeGreaterThan(8);
    expect(feTopics).toEqual(ELDER.map((n) => n.topic));
    expect(feTexts).toEqual(ELDER.map((n) => n.text));
  });

  it("branches to the same topics on both sides", () => {
    expect(feNext).toHaveLength(ELDER.length);
    const beNext = ELDER.map((n) => n.next ?? []);
    expect(feNext).toEqual(beNext);
  });

  it("every branch the backend offers resolves to a real node", () => {
    for (const node of ELDER) {
      for (const target of node.next ?? []) {
        expect(elderNode(target), `backend ${node.id} → ${target}`).toBeDefined();
      }
    }
  });

  it("every branch the frontend offers resolves to a real node", () => {
    for (const [i, targets] of feNext.entries()) {
      for (const target of targets) {
        expect(feIds, `frontend ${feIds[i]} → ${target}`).toContain(target);
      }
    }
  });

  it("is reachable from the root — no orphan node a reader can never open", () => {
    const seen = new Set<string>(["root"]);
    const queue = ["root"];
    while (queue.length) {
      const id = queue.shift()!;
      for (const target of elderNode(id)?.next ?? []) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    expect([...seen].sort()).toEqual([...ELDER.map((n) => n.id)].sort());
  });
});
