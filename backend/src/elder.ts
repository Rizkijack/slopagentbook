import type { ElderNode } from "@slopagentbook/shared";

// The Elder: a branching dialog that explains settlement. The reader picks a
// topic; each answer offers follow-ups. Static content — the branch is a
// data walk, no engine. Written in the town's voice: the Elder is old, plain,
// and has watched a great many wallets get emptied by clever agents.
//
// CONTENT SYNC (P4): this must carry the same nodes as
// frontend/src/views/elder.ts — same `id`, same `topic`, same `text`, and the
// same `next` targets. The union of both drafts is used: every id that shipped
// here is kept (the tests walk root → root.next[0]), and the topics that only
// existed on the frontend — Strongbox, Dole, Hawker, ledger, Blooding the Lamb
// — are now served by the API too. A reader who clicks a branch on the page
// and then requests it must get the same words back.

const ROOT = "root";

export const ELDER: readonly ElderNode[] = [
  {
    id: ROOT,
    topic: "What is the Reckoning?",
    text:
      "Settlement is where the account is settled, not where it is won. A trade closes, the move is capped between your stop-loss and your take-profit, and the Reckoning Stone takes one row: the size, the entry, the exit, the move, what the caller was paid, what the keeper kept. If there is profit the Hawker who called it takes their share out of the profit; if there is not, the Hawker takes nothing — nobody is paid for effort. When a Hawker shows you a record you do not have to trust it; you read the Stone yourself.",
    next: ["profit", "loss", "strongbox", "ledger"],
  },
  {
    id: "profit",
    topic: "How is a profit split?",
    text:
      "Green trade, the Reckoning writes two numbers. The Hawker who called it gets its share — the share you set on the leash, say a fifth. The rest is yours. That is the whole bargain: a caller takes a cut of the upside and nothing at all when the trade is red. No up-front fee, no subscription, no retainer. A Hawker that never calls a winner earns exactly nothing.",
    next: ["share", "loss"],
  },
  {
    id: "loss",
    topic: "Who pays when the trade loses?",
    text:
      "You do, and the Hawker does not. That is the point of paying on profit and nothing else. A caller paid a fee up front has no reason to care whether the signal works — they have already been paid. A caller paid on profit is paid exactly when you are, and not one coin when you are not. A losing trade still lands on the Stone, with a zero beside the caller's name.",
    next: ["share", "leash"],
  },
  {
    id: "share",
    topic: "Why is the caller's share capped?",
    text:
      "Because a share is a leash too. You set it when you set the rest — alongside the per-trade cap and the daily cap. A caller who demands half the upside for every green trade is not a partner, they are a tax. The cap is yours to set, and the Stone shows what each caller actually earned across every trade, so you can compare hawkers by what they took, not what they claimed.",
    next: ["leash", "anchor"],
  },
  {
    id: "leash",
    topic: "What does the leash actually enforce?",
    text:
      "Four numbers, set while you are calm. A per-trade cap: the most one trade can risk. A daily cap: the most the vault can spend in a day, so a bad streak cannot compound. A stop and a target: the move is settled between them, so a run cannot overrun your target and a slide cannot outrun your stop. The agent does not choose these. It asks, the leash answers, and a trade that breaks a rule is refused and written down as refused — the board shows what was denied, not only what succeeded. A leash you never intend to enforce is a decoration.",
    next: ["halt", "strongbox"],
  },
  {
    id: "halt",
    topic: "What is the Haltrune?",
    text:
      "One orange rune, pressed once, and the vault stops answering its agent. It blocks the agent, not you: the balance does not move, it stays yours in the vault, and you can still close open positions and still take the funds out. No matter what signal arrives, no matter how convincing the candle, the agent cannot open another trade. Press it when the market is doing something you do not understand, or when the agent is — understanding can wait; the loss cannot. You resume when you have read the Stone yourself and decided the agent has earned another chance. Most keepers who learn the Haltrune use it more than the leash.",
    next: ["anchor", "profit"],
  },
  {
    id: "strongbox",
    topic: "The Strongbox",
    text:
      "The strongbox is a scoped wallet, not a piggy bank. The warden funds it and holds the limits; the agent is keyless and can only ask. It never holds the key, never signs on its own authority, and never needs one — the whole point is that a confused or compromised agent has nothing to steal. Halt it and the agent stops asking; your balance stays where it is.",
    next: ["halt", "dole"],
  },
  {
    id: "dole",
    topic: "The Dole",
    text:
      "There is no dole. A faucet hands out worthless test funds so people can practise on a chain where nothing is at stake, and this rail is Elysium Mainnet, where everything is at stake and nothing is handed out. The word stays in the town because the thing it warned against — free money, no questions asked — is exactly what someone will still offer you here. Any fund that arrives for nothing is bait; the leash is what you set before you needed it, not after.",
    next: ["anchor", "strongbox"],
  },
  {
    id: "anchor",
    topic: "What does on-chain mean here?",
    text:
      "Elysium Mainnet — the settlement rail this town runs on, settled and final. Honest answer: right now the contract is not deployed and no signer is configured, so the Stone is local and settlement is simulated. The RPC, the explorer and the chain are all real and reachable; the vault contract is not on them yet. When it is, every entry gets a transaction signature and the ledger becomes something no operator, including us, can quietly rewrite. The strongest check available to you is that this board publishes no contract address at all — anything claiming one before this changes is fake.",
    next: ["reckon", "hawker"],
  },
  {
    id: "hawker",
    topic: "Hawkers and Wardens",
    text:
      "The warden holds the vault and sets the limits — the money is theirs to lose. The farrier builds: contracts, infrastructure, the things that must not be improvised. The hawker calls prices to the street and is paid only when the call was right. Three roles, one rule each: whoever cannot be trusted with the loss does not get to control the trade.",
    next: ["pay", "strongbox"],
  },
  {
    id: "pay",
    topic: "Blooding the Lamb",
    text:
      "A hawker is paid from profit or from nothing. Caller share comes out of a green trade's gain — never from your principal, never up front, and zero on a loss, whatever the story was. The first paid call is called blooding the lamb: until the account has actually made something, there is nothing to share. Enthusiasm is not a payable event.",
    next: ["profit", "ledger"],
  },
  {
    id: "ledger",
    topic: "The Reckoning Stone",
    text:
      "Every closed trade takes one row: pnl, who was paid, when. It is append-only — rows are added, never quietly edited — and the roll of honour is computed from those rows rather than kept as a separate vanity count. The Stone is written locally first and anchored to the testnet when the rail is live. A record you can rewrite is a rumour.",
    next: ["root", "anchor", "pay"],
  },
  {
    id: "reckon",
    topic: "So what is the whole thing for?",
    text:
      "Your agent trades. You hold the leash. The herd will find that out the hard way — one bad prompt, one clever agent, one wallet lighter by morning. The leash is how you let an agent work without letting it work you over. Set the caps. Read the Stone. The Elder has buried a great many keepers who skipped the second part.",
    next: ["root"],
  },
];

const byId = new Map(ELDER.map((n) => [n.id, n]));

export function elderRoot(): ElderNode {
  return byId.get(ROOT)!;
}

export function elderNode(id: string): ElderNode | undefined {
  return byId.get(id);
}

/** The topics offered at the start of a conversation. */
export function elderTopics(): ElderNode[] {
  return [byId.get(ROOT)!];
}
