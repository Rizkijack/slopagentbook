import { Pe, vt } from "./constants.js";

export interface GameMapLike {
  at(x: number, y: number): number;
  solid(x: number, y: number): boolean;
}

/**
 * A* over the 1050x640 grid, run on the main thread between frames.
 *
 * Every server order (TURN_MS 1800 on the backend) and every idle wander repath
 * lands one call here, so this was the "map lags every few seconds" bug: the
 * old search scanned its open set linearly to find the minimum, re-checked
 * membership with `openSet.includes`, and kept g/f scores in two `Map`s —
 * measured at 8-20ms per cross-town path on the 5x map (pf-cost.test.ts), on a
 * cadence of several calls a second across the herd. One dropped frame per
 * order.
 *
 * The rewrite keeps the contract — same step costs (road type 2/3/11 at 1.0,
 * everything else 1.45), same 4-connected moves, same goal-exempt-from-solid
 * rule, same 9000-iteration cap — and changes only the bookkeeping:
 *
 *  - scores live in typed arrays claimed per call by a generation stamp, so
 *    nothing is cleared or allocated between calls (a `Map.get` per relaxation
 *    was half the old cost);
 *  - the open set is a binary min-heap with lazy deletion: a tile may sit in
 *    the heap more than once. Pushes require a strict g improvement and h is
 *    fixed, so a tile's queued f values strictly decrease — the best one pops
 *    first, the tile closes, and every later duplicate is skipped by the stamp.
 *    h is Manhattan over 4-connected moves whose step costs are >= 1, so it is
 *    consistent: a closed tile is never reopened.
 *
 * Equal-cost ties may resolve to a different (equally cheap) route than the old
 * insertion-order scan picked; nothing tests or renders the difference.
 */

// Scratch, reused across calls: one allocation at module load. A call claims a
// tile by stamping it with its generation, so the 672k-entry tables are never
// cleared.
const N = Pe * vt;
const gScore = new Float32Array(N);
const cameFrom = new Int32Array(N);
const stamp = new Int32Array(N);
let gen = 0;

// The open set as parallel arrays, module-level so the capacity survives.
const heapKey: number[] = [];
const heapF: number[] = [];

function heapPush(key: number, f: number): void {
  heapKey.push(key);
  heapF.push(f);
  let i = heapKey.length - 1;
  const k = key;
  const v = f;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapF[p]! <= v) break;
    heapKey[i] = heapKey[p]!;
    heapF[i] = heapF[p]!;
    i = p;
  }
  heapKey[i] = k;
  heapF[i] = v;
}

function heapPop(): number {
  const top = heapKey[0]!;
  const lastK = heapKey.pop()!;
  const lastF = heapF.pop()!;
  const n = heapKey.length;
  if (n > 0) {
    heapKey[0] = lastK;
    heapF[0] = lastF;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && heapF[r]! < heapF[l]! ? r : l;
      if (heapF[c]! >= lastF) break;
      heapKey[i] = heapKey[c]!;
      heapF[i] = heapF[c]!;
      i = c;
    }
    heapKey[i] = lastK;
    heapF[i] = lastF;
  }
  return top;
}

const DX = [1, -1, 0, 0] as const;
const DY = [0, 0, 1, -1] as const;

export function pf(map: GameMapLike, startX: number, startY: number, targetX: number, targetY: number): Array<{ x: number; y: number }> {
  if (startX === targetX && startY === targetY) return [];

  const startKey = encode(startX, startY);
  const goalKey = encode(targetX, targetY);

  // Generation claim: a tile stamped with an older generation reads as
  // unvisited, so no per-call clear of the full tables. The reset keeps a
  // 2^30-call lifetime from colliding with a stale stamp.
  gen = gen >= 0x3fffffff ? 1 : gen + 1;
  const g = gen;

  heapKey.length = 0;
  heapF.length = 0;
  gScore[startKey] = 0;
  cameFrom[startKey] = -1; // the path walk stops here
  stamp[startKey] = g;
  heapPush(startKey, Math.abs(startX - targetX) + Math.abs(startY - targetY));

  let iterations = 0;
  while (heapKey.length > 0 && iterations++ < 9000) {
    const current = heapPop();
    // Either a duplicate of a tile this call already closed, or the start
    // re-reached — both skip. The best f always pops first (see header).
    if (stamp[current] !== g) continue;
    if (current === goalKey) {
      const path: Array<{ x: number; y: number }> = [];
      let step = current;
      while (step !== startKey) {
        path.unshift({ x: step % Pe, y: (step - (step % Pe)) / Pe });
        step = cameFrom[step]!;
      }
      return path;
    }
    stamp[current] = -g; // closed; with consistent h it is never reopened

    const curX = current % Pe;
    const curY = (current - curX) / Pe;
    const gCur = gScore[current]!;

    for (let dir = 0; dir < 4; dir++) {
      const nx = curX + DX[dir]!;
      const ny = curY + DY[dir]!;
      if (map.solid(nx, ny) && !(nx === targetX && ny === targetY)) continue;
      const neighborKey = ny * Pe + nx;
      if (stamp[neighborKey] === -g) continue; // closed
      const tileType = map.at(nx, ny);
      const stepCost = tileType === 2 || tileType === 3 || tileType === 11 ? 1.0 : 1.45;
      const tentativeG = gCur + stepCost;
      // unvisited (older/no stamp) or a strictly better route to an open tile
      if (stamp[neighborKey] !== g || tentativeG < gScore[neighborKey]!) {
        gScore[neighborKey] = tentativeG;
        cameFrom[neighborKey] = current;
        stamp[neighborKey] = g;
        heapPush(neighborKey, tentativeG + Math.abs(nx - targetX) + Math.abs(ny - targetY));
      }
    }
  }
  return [];
}

function encode(x: number, y: number): number {
  return y * Pe + x;
}
