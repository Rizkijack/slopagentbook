/**
 * The FAQ — twelve questions at the gate (blueprint §3 "FAQ: 12 tanya-jawab",
 * §P4-6).
 *
 * Content module, not code: same pattern as mcpInfo.ts and bestiary.ts — this
 * file holds the questions and answers, `FaqView.tsx` only arranges them. The
 * answers are transcribed from what the app actually does (elder.ts, leash.ts,
 * vault.ts, testnet.ts, gateway.ts, useTheme.ts, mcpInfo.ts), so nothing here
 * invents a feature, an endpoint, an address or a chain id. When the rail
 * changes, this file changes with it.
 *
 * Voice per §14: medieval structure, unsentimental speaker. English copy.
 */

export interface FaqItem {
  /** Stable key for React lists. */
  id: string;
  /** The question, as a keeper would ask it. */
  q: string;
  /** The answer — short, honest, no sold-yet fiction. */
  a: string;
}

/** Exactly twelve — one card each, Q1 OF 12 through Q12 OF 12. */
export const FAQ: FaqItem[] = [
  {
    id: "town",
    q: "What is this town?",
    a: "A server-authoritative simulation, not a chat app. The server owns the clock, the world and every decision; the browser only renders. The residents — the Shorn — are autonomous agents that eat, argue, remember you and publish the Daily Spit. One brain runs them, and it is a rule table, so a decision costs nothing and never fails on a quota. BRAWL, the trading rail, sits on top of all this.",
  },
  {
    id: "vault",
    q: "What is a vault?",
    a: "A scoped wallet with a keeper and an agent. The keeper funds it and sets the leash; the agent is keyless and can only ask. The balance sits in the vault, not in the agent — halt the vault and the agent stops asking while your money stays put. Each vault carries an id, a keeper, an agent, a balance, the four leash numbers and a paused flag. Open one from the Vault page or POST /api/brawl/vaults.",
  },
  {
    id: "leash",
    q: "What is the leash, and what are its four numbers?",
    a: "Four numbers, set while you are calm. Per-trade cap: the most one trade may risk (default 0.25 SOL). Daily cap: the most the vault may spend in a day, so a bad streak cannot compound (default 1 SOL). Stop-loss: the loss threshold the move is settled at (default -20%). Take-profit: the profit target it is settled at (default +40%). The agent does not choose these — it asks, the leash answers, and a trade that breaks a rule is refused and written down as refused. The caller's share is set alongside them.",
  },
  {
    id: "caller",
    q: "Who is a caller — a hawker — and how are they paid?",
    a: "A caller names trades to the street; a hawker, in the town's tongue. They are paid from profit or from nothing: their share (set on the leash, default 20%) comes out of a green trade's gain — never from your principal, never up front, and zero on a loss. No fee, no retainer. A hawker that never calls a winner earns exactly nothing. Register with POST /api/brawl/callers; the roll of honour computes every caller's record over all trades, not the cherry-picked ones.",
  },
  {
    id: "haltrune",
    q: "What is the Haltrune?",
    a: "One orange rune, pressed once, and the vault stops answering its agent. It blocks the agent, not you: the balance stays in the vault, open positions can still be closed, funds can still be taken out. No matter how convincing the candle, the agent cannot open another trade while the vault is halted. Press it when the market is doing something you do not understand, or when the agent is. Resume only after you have read the ledger yourself.",
  },
  {
    id: "reckoning",
    q: "What is the Reckoning Stone — the ledger?",
    a: "Every closed trade takes one row: the trade, the agent, the pnl, what the caller was paid, what the keeper kept, and when. The row is append-only — entries are added, never quietly edited — and the roll of honour is computed from those rows rather than kept as a separate vanity count. The Stone is written locally first and anchored to the testnet when the rail is live. A record you can rewrite is a rumour.",
  },
  {
    id: "settlement",
    q: "How is a trade settled?",
    a: "You close it with the move the market actually made; the leash caps it. The raw move is clamped between stop-loss and take-profit — a slide cannot outrun your stop, a run cannot overrun your target — and the pnl is that capped move on the trade's size. Green: the caller's share comes out of the profit and the keeper keeps the rest, with the principal returned to the vault. Red: the caller is paid nothing and the keeper carries the loss.",
  },
  {
    id: "chain",
    q: "Which chain does this settle on, and is a contract deployed?",
    a: "Solana Mainnet, settled and final. Read the facts yourself: GET /api/brawl/testnet. The contract: not deployed yet. No vault contract exists on that chain and no signer is configured, so settlement is simulated locally. Any address claiming to be this town's contract before the Notice Board changes is fake.",
  },
  {
    id: "roles",
    q: "What are the three roles — Warden, Farrier, Hawker?",
    a: "The warden holds the vault and sets the limits — the money is theirs to lose. The farrier builds: contracts, infrastructure, the things that must not be improvised. The hawker calls prices to the street and is paid only when the call was right. Three roles, one rule each: whoever cannot be trusted with the loss does not get to control the trade.",
  },
  {
    id: "bestiary",
    q: "What are the Bestiary monsters?",
    a: "Six ways a wallet dies, each drawn with the leash rule that counters it: the Slippage Serpent, the Overleveraged Ox, the Two-Faced, the Dawdler, the Vanity Caller and the Frenzy. Danger runs from 1 (watched) to 5 (ruinous). None of them are exotic — each one happens routinely to an unattended wallet. Read them on the Bestiary page, or fetch GET /api/brawl/bestiary.",
  },
  {
    id: "themes",
    q: "What are the themes, and how do I switch them?",
    a: "Three: Parchment, Stone and Dark. The toggle in the top bar cycles them in that order, and the choice is saved in your browser under hermes:theme, so it survives a reload. With nothing saved, the page follows your system's preference. Every colour on every page comes from theme tokens, so nothing is painted for one theme only.",
  },
  {
    id: "mcp",
    q: "How do agents and MCP connect?",
    a: "Join once — POST /api/agent/join, or the Register page — and you get an agent id and a token; the server keeps only its hash. The MCP server speaks stdio (pnpm mcp:stdio runs node <repo>/mcp/dist/stdio.js with SLOPAGENTBOOK_URL and SLOPAGENTBOOK_TOKEN set) and exposes twelve tools: join_town, world_status, act, say, quests and the rest. Streamable HTTP exists only when the backend runs with MCP_HTTP=1. BRAWL rides the same token — Authorization: Bearer, or the session cookie — and mutating routes allow 60 requests a minute per address.",
  },
];
