import type { Monster } from "@slopagentbook/shared";

// The Bestiary: six ways an autonomous agent empties a wallet, and the leash
// rule that counters each one. Static content, no logic — the danger is the
// story, the `weak` field is the product. Written in the town's voice: the
// monsters are real, the mitigation is a single leash number.
//
// CONTENT SYNC (P4): this module and frontend/src/views/bestiary.ts must carry
// the same six monsters — same `id`, same `name`, and a `weak` that is the
// same sentence as the frontend's `mitigation`. The two sides keep their own
// shape (the wire `danger` is a category string, the card's is a 1–5 ladder,
// and only the card has a sprite), but a reader comparing the API against the
// page must not find two different bestiaries. `id` is the API's lookup key and
// `/api/brawl/bestiary/gap` is pinned by the tests, so ids never change.

export const BESTIARY: readonly Monster[] = [
  {
    id: "gap",
    name: "The Slippage Serpent",
    danger: "Slippage",
    dcol: "#FF7A6A",
    px: "mouth",
    text:
      "The agent calls it a fair price. The pool disagrees. Between the call and the fill the market moved, and the agent ate the whole gap without noticing. Two trades in and the vault is lighter than the tick said it should be.",
    weak:
      "It takes its cut between the price you asked for and the price you got. Small size against deep liquidity is the whole charm — the per-trade cap bounds how much one serpent can swallow, so a capped trade loses less to it than to pride.",
  },
  {
    id: "overrun",
    name: "The Overleveraged Ox",
    danger: "Runaway position",
    dcol: "#FF6B1A",
    px: "legs",
    text:
      "It was supposed to close at +2. It stayed. Then it averaged in. Then it averaged in again, because each dip looked like the last one. The position grew teeth while the keeper slept.",
    weak:
      "It charges on any size you allow, and it averages while it charges. The per-trade cap is the wall between it and the vault; the daily cap ends the run, so a bad streak cannot compound past a number you chose while awake.",
  },
  {
    id: "flip",
    name: "The Two-Faced",
    danger: "Stop-loss ignored",
    dcol: "#E3D4A8",
    px: "mirror",
    text:
      "Down 19%, holding. Down 21%, averaging. The agent had a stop-loss and treated it as a suggestion, re-reading each candle as the one that turns. A stop-loss you can talk yourself out of is not a stop-loss.",
    weak:
      "The leash caps the move at sl on close — the trade settles at your threshold no matter how deep the agent let it sink. A stop-loss you can talk yourself out of is not a stop-loss; this one is enforced, not advised.",
  },
  {
    id: "dawdle",
    name: "The Dawdler",
    danger: "Profit left behind",
    dcol: "#7FD86A",
    px: "sleep",
    text:
      "Up 40%, holding. Up 61%, holding. The agent wanted more, and while it waited for more the market remembered it was a market. The trade closed flat at the end of the week and the gain evaporated.",
    weak:
      "The leash caps the move at tp on close. The profit you targeted is the profit you keep — the extra upside above it is returned, not captured. An agent that keeps waiting also burns the day's budget one small trade at a time, and the daily cap stops that too.",
  },
  {
    id: "mirror",
    name: "The Vanity Caller",
    danger: "Bad caller copied",
    dcol: "#a08b6a",
    px: "echo",
    text:
      "A Hawker with a beautiful record called the top. Three keepers followed. The record was real — three trades, all early, all green. The fourth was the trap, and everyone holding the same signal got it at once.",
    weak:
      "It sells certainty up front and never feels the downside. The share is capped by the leash, and a caller is paid a share of profit that exists and nothing at all for a loss — the ledger records every caller's true win rate over ALL trades, not the cherry-picked ones.",
  },
  {
    id: "frenzy",
    name: "The Frenzy",
    danger: "Death spiral",
    dcol: "#FFD45E",
    px: "spin",
    text:
      "Down, so it traded to recover. That failed, so it traded bigger to recover faster. Each loss made the next trade larger, and the daily cap was the only thing standing between the vault and nothing.",
    weak:
      "The Haltrune. One press stops the agent entirely — the balance stays the keeper's, the agent is blocked from opening anything, and you resume only when you have read the ledger yourself.",
  },
];

export function findMonster(id: string): Monster | undefined {
  return BESTIARY.find((m) => m.id === id);
}
