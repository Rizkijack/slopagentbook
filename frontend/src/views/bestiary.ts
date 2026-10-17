/**
 * The Bestiary — six ways an agent's wallet dies (blueprint §5.1 / §4.1).
 *
 * Static content, no logic: this module holds the data, `BestiaryCard`
 * formats it. Deliberately exports its OWN `Monster` type rather than adding
 * anything to shared/src/types.ts — the shared contract is locked and this is
 * display copy, not a wire format (same pattern as mcpInfo.ts).
 *
 * CONTENT SYNC (P4): this must carry the same six monsters as
 * backend/src/bestiary.ts — same `id`, same `name`, and `mitigation` that is
 * the same sentence as the API's `weak`. The two sides keep their own shape
 * (here `danger` is the 1–5 ladder and the sprite is an 8×8 grid; the wire
 * type instead carries a category string, a hex accent and an icon token), but
 * a reader comparing the page against /api/brawl/bestiary must not find two
 * different bestiaries. Ids are the API's lookup keys, so they never change.
 *
 * Voice per §14: the structure is medieval, the people are not nice. Danger is
 * 1 (watched) … 5 (ruinous); the card colours it from theme tokens only.
 */

export interface Monster {
  /** Stable key for React lists — also the API's lookup id. */
  id: string;
  /** Lore/display name — no code identifier is named after any of these. */
  name: string;
  /** 1 (watched) … 5 (ruinous). */
  danger: number;
  /** 8×8 pixel sprite, "#" = lit pixel. Rendered as an SVG in BestiaryCard. */
  sprite: string[];
  /** What the leash, the vault, or plain suspicion does to keep it fed. */
  mitigation: string;
}

/**
 * The six monsters. Danger numbers are editorial, not computed — the whole
 * point of the page is that a keeper can read the risk ladder at a glance.
 */
export const BESTIARY: Monster[] = [
  {
    id: "gap",
    name: "The Slippage Serpent",
    danger: 3,
    sprite: [
      ".######.",
      "#.......",
      "#.......",
      ".######.",
      ".......#",
      ".......#",
      ".######.",
      "........",
    ],
    mitigation:
      "It takes its cut between the price you asked for and the price you got. Small size against deep liquidity is the whole charm — the per-trade cap bounds how much one serpent can swallow, so a capped trade loses less to it than to pride.",
  },
  {
    id: "overrun",
    name: "The Overleveraged Ox",
    danger: 5,
    sprite: [
      "##....##",
      ".#....#.",
      ".######.",
      ".#.##.#.",
      ".######.",
      "..#..#..",
      "..####..",
      "........",
    ],
    mitigation:
      "It charges on any size you allow, and it averages while it charges. The per-trade cap is the wall between it and the vault; the daily cap ends the run, so a bad streak cannot compound past a number you chose while awake.",
  },
  {
    id: "flip",
    name: "The Two-Faced",
    danger: 4,
    sprite: [
      "..####..",
      ".#....#.",
      "#.##..##",
      "#......#",
      "#.#..#.#",
      ".#.##.#.",
      "..####..",
      "........",
    ],
    mitigation:
      "The leash caps the move at sl on close — the trade settles at your threshold no matter how deep the agent let it sink. A stop-loss you can talk yourself out of is not a stop-loss; this one is enforced, not advised.",
  },
  {
    id: "dawdle",
    name: "The Dawdler",
    danger: 2,
    sprite: [
      "...##...",
      "..####..",
      ".######.",
      ".#.##.#.",
      ".######.",
      ".######.",
      "..####..",
      "........",
    ],
    mitigation:
      "The leash caps the move at tp on close. The profit you targeted is the profit you keep — the extra upside above it is returned, not captured. An agent that keeps waiting also burns the day's budget one small trade at a time, and the daily cap stops that too.",
  },
  {
    id: "mirror",
    name: "The Vanity Caller",
    danger: 3,
    sprite: [
      "#.#.#.#.",
      "########",
      "########",
      ".#.##.#.",
      "..####..",
      "..####..",
      ".######.",
      "........",
    ],
    mitigation:
      "It sells certainty up front and never feels the downside. The share is capped by the leash, and a caller is paid a share of profit that exists and nothing at all for a loss — the ledger records every caller's true win rate over ALL trades, not the cherry-picked ones.",
  },
  {
    id: "frenzy",
    name: "The Frenzy",
    danger: 5,
    sprite: [
      "########",
      "#......#",
      "#.####.#",
      "#....#.#",
      "#.##.#.#",
      "#.#..#.#",
      "#.#....#",
      "........",
    ],
    mitigation:
      "The Haltrune. One press stops the agent entirely — the balance stays the keeper's, the agent is blocked from opening anything, and you resume only when you have read the ledger yourself.",
  },
];

/** Display label for a danger level — kept here so every card speaks alike. */
export function dangerLabel(danger: number): string {
  if (danger >= 5) return "ruinous";
  if (danger === 4) return "severe";
  if (danger === 3) return "sharp";
  if (danger === 2) return "mild";
  return "watched";
}
