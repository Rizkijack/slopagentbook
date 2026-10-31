import { describe, it } from "vitest";
import { pf } from "../src/canvas/pf.js";
import { navmap } from "../src/canvas/navmap.js";
import { LOCATIONS } from "../src/canvas/locationsData.js";
import { V } from "../src/canvas/constants.js";

// Pathfinding cost, measured rather than asserted.
//
// The map grew 5x to 1050x640 and pf() still walks it with a linear-scan open
// set and two Maps. Every server order (TURN_MS 1800 on the backend) and every
// idle wander repath (1.4-4s per resident) lands one of these on the main
// thread between frames, so a slow call is a dropped frame exactly on the
// cadence the town ticks. This measures the calls the game actually makes:
// spot-to-spot across the real collision map, far and near.
//
// Not an assertion on purpose — same rule as frame-cost.test.ts: a hard
// ceiling encodes today's machine as law. Run it, read it, judge.

const nav = navmap();

function tileOf(locId: string): { x: number; y: number } {
  const loc = LOCATIONS.find((l) => l.id === locId)!;
  return nav.nearestWalkable(loc.spot[0]!, loc.spot[1]!);
}

function measure(label: string, fromId: string, toId: string): void {
  const from = tileOf(fromId);
  const to = tileOf(toId);
  // warm-up (JIT + first-touch of any internal tables)
  pf(nav, from.x, from.y, to.x, to.y);
  const RUNS = 20;
  const t0 = process.hrtime.bigint();
  let pathLen = 0;
  for (let i = 0; i < RUNS; i++) {
    pathLen = pf(nav, from.x, from.y, to.x, to.y).length;
  }
  const us = Number(process.hrtime.bigint() - t0) / 1000 / RUNS;
  console.log(
    `  ${label.padEnd(28)} ${fromId.padEnd(12)} -> ${toId.padEnd(12)} ` +
      `path ${String(pathLen).padStart(5)} tiles  ${us.toFixed(0).padStart(7)} us/call`,
  );
}

describe("pf cost on the real navmap", () => {
  it("measures cross-town and local paths", () => {
    console.log("");
    console.log(`  grid ${LOCATIONS.length} locations; world 1050x640 tiles`);
    // the long hauls: one end of the map to the other
    measure("cross-town E->W", "square", "mill");
    measure("cross-town W->E", "mill", "square");
    measure("cross-town N->S", "observatory", "trough");
    measure("cross-town S->N", "trough", "observatory");
    // the ordinary case: neighbours
    const near = LOCATIONS.find((l) => l.id !== "square")!;
    measure("local hop", "square", near.id);
    console.log("");
  });

  it("measures the failed-path worst case", () => {
    // A path that burns the whole 9000-iteration cap — every failed wander
    // does this, and failure retries 0.6-1.6s later, so failures repeat. The
    // goal is sealed in a wall box in open ground: h points straight at it, so
    // the search floods the reachable field around the box and exhausts the
    // cap. (A wall over the START exits after one iteration — not a burn.)
    console.log("");
    const inBox = (x: number, y: number) =>
      x >= 898 && x <= 902 && y >= 498 && y <= 502 && !(x === 900 && y === 500);
    const sealed = { at: () => 0, solid: (x: number, y: number) => inBox(x, y) };
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) pf(sealed, 0, 0, 900, 500);
    const us = Number(process.hrtime.bigint() - t0) / 1000 / 20;
    console.log(`  ${"goal sealed, cap burn".padEnd(28)} ${"".padEnd(12)} -> ${"".padEnd(12)} ${" ".repeat(5)} ${us.toFixed(0).padStart(7)} us/call`);
    console.log("");
  });
});
