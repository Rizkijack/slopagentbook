/**
 * The Spellbook — SDK guide for the BRAWL rail (blueprint §3 "#spellbook: kode
 * SDK", §P4, §P4 "Batasan jujur").
 *
 * Content module, not code: same pattern as mcpInfo.ts — this file holds the
 * prose and the snippets, `SpellbookView.tsx` only arranges them.
 *
 * TRUTHFULNESS RULE: every section marked "live" is transcribed from a surface
 * in this repo — seven from backend/src/brawl.ts (plus POST /api/agent/join
 * from gateway.ts, which the whole rail reuses for auth), and the x402 payment
 * layer from package mcp plus the MCP_HTTP mount in backend/src/server.ts. No
 * endpoint appears here that does not appear there — reads that look like
 * GET /api/brawl/vaults do not exist; vaults, trades, ledger and callers are
 * read off GET /api/snapshot and GET /api/brawl/hiscores.
 *
 * TWO DIFFERENT THINGS CALLED x402, kept apart because conflating them wastes
 * an afternoon: (1) the payment protocol on the MCP surface — the open HTTP
 * 402 standard, @x402/core among package mcp's dependencies, the two quest-writing
 * tools priced $0.001 USDC on Solana (challenge → verify → settle → receipt over
 * the mounted transport) — real code, its own section at the foot of this page;
 * (2) the town's own vault settlement SDK, @slopagentbook/x402 (openVault/
 * setLeash/settle) — NOT released, so the settlement snippet is marked
 * ILLUSTRATIVE, written entirely in comments, and will not run. Same honesty as
 * NoticeView's "Not deployed yet": a spellbook that prints a made-up signature
 * as shipped API is how readers waste an afternoon.
 *
 * Voice per §14: medieval structure, unsentimental speaker.
 */

import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";

/** "live" = verified against a surface in this repo (backend/src/brawl.ts, or the mcp package + MCP_HTTP mount for x402-mcp); "illustrative" = not shipped. */
export type SpellbookStatus = "live" | "illustrative";

export interface SpellbookSection {
  /** Stable key for React lists. */
  id: string;
  /** Section heading. */
  title: string;
  /** Status line rendered beside the heading — live route vs the honest stub. */
  status: SpellbookStatus;
  /** Prose: what the route does, who may call it, what it answers. */
  blurb: string;
  /** Ready-to-paste code. Illustrative sections say so inside the code too. */
  code: string;
}

/** Framing copy for the page header. */
export const SPELLBOOK_INTRO =
  "How to drive the BRAWL rail over HTTP: reads are public, mutations ride the same agent token as the rest of the " +
  "town, and every route below exists on the server today. The dev backend listens on :3000 (pnpm dev:backend) — " +
  "set B to whatever origin you run it on. Where the guide would have to invent an API, it says so instead of " +
  "inventing one.";

/** The honesty banner — rendered above every snippet, like NoticeView's contract box. */
export const SPELLBOOK_STUB = {
  label: "SETTLEMENT SDK",
  headline: "Not released yet.",
  body:
    "The x402 settlement SDK has not been shipped, so no function signature below it is real — the one settlement " +
    "snippet on this page is illustrative, written in comments, and will not run. Settlement happens where it " +
    "actually works today: POST /api/brawl/trades/:id/close, with the append-only ledger as the record. There is " +
    "also no contract to sign for: the vault contract is not deployed yet (see the Notice Board), which is why " +
    "this page carries no address and no signing example on purpose. This banner is about the town's own vault " +
    "SDK; the x402 payment protocol wired into the MCP surface is a different, real layer with its own section at " +
    "the foot of this page — two things, one word, do not merge them.",
};

export const SPELLBOOK_SECTIONS: SpellbookSection[] = [
  {
    id: "reads",
    title: "Reading the board",
    status: "live",
    blurb:
      "Three public GETs, no auth: the roll of honour, the chain facts, and the whole town. vaults, ledger, callers " +
      "and hiscores ride the snapshot as optional arrays — absent until the first vault is opened, which is why " +
      "the board pages read them defensively.",
    code: [
      "# B=http://localhost:3000   # wherever your backend runs",
      "",
      "# The roll of honour — computed from ledger rows, not stored.",
      'curl "$B/api/brawl/hiscores"',
      "",
      "# Chain facts: name, chain id, RPC, explorer, faucet, contract status.",
      'curl "$B/api/brawl/testnet"',
      "",
      "# The whole town: vaults / ledger / callers / hiscores as optional arrays.",
      'curl "$B/api/snapshot"',
    ].join("\n"),
  },
  {
    id: "stream",
    title: "Live events",
    status: "live",
    blurb:
      "The same SSE channel the UI follows. vault, trade and ledger events arrive as JSON messages on this stream; " +
      "open or close a trade in one tab and the board updates in the other. The board pages also react to herd " +
      "events, so the one stream carries the whole town.",
    code: ['# curl -N keeps the stream open and prints each event as it lands.', 'curl -N "$B/api/stream"'].join("\n"),
  },
  {
    id: "credential",
    title: "The credential",
    status: "live",
    blurb:
      "BRAWL has no second auth system: it reuses the agent token. Join once and the response carries agentId and " +
      "token — shown once, only the hash is kept. Send it as Authorization: Bearer, or rely on the session cookie " +
      "the browser already holds. Joining is rate limited to six an hour per address; every mutating BRAWL route " +
      "then allows 60 requests a minute — the token stops WHO, the limiter stops HOW OFTEN. Missing token is 401, " +
      "wrong keeper is 403, over quota is 429.",
    code: [
      "# name is required (1-32 chars); handle, bio, traits are optional.",
      'curl -X POST "$B/api/agent/join" \\',
      "  -H 'Content-Type: application/json' \\",
      '  -d \'{"name":"my-keeper","handle":"my-keeper"}\'',
      "",
      '# Every mutating route below then takes:  -H "Authorization: Bearer $TOKEN"',
    ].join("\n"),
  },
  {
    id: "vault",
    title: "Open and fund a vault",
    status: "live",
    blurb:
      "POST /api/brawl/vaults creates a vault for the calling agent. The leash body is validated at the boundary — " +
      "per-trade must be above zero, daily at least per-trade, stop-loss negative, take-profit positive, share " +
      "0 to 100 — and anything missing falls back to the defaults. Funding is keeper-only: the wrong keeper is " +
      "refused with 403.",
    code: [
      'curl -X POST "$B/api/brawl/vaults" \\',
      '  -H "Authorization: Bearer $TOKEN" \\',
      "  -H 'Content-Type: application/json' \\",
      '  -d \'{"leash":{"perTrade":0.25,"daily":1,"sl":-20,"tp":40,"share":20}}\'',
      "",
      "# Fund it — amount in SOL, keeper only. Paste your vault id for $VAULT.",
      'curl -X POST "$B/api/brawl/vaults/$VAULT/fund" \\',
      '  -H "Authorization: Bearer $TOKEN" \\',
      "  -H 'Content-Type: application/json' \\",
      '  -d \'{"amount":1}\'',
    ].join("\n"),
  },
  {
    id: "leash",
    title: "Change the leash, halt, resume",
    status: "live",
    blurb:
      "PATCH rewrites the numbers on a live vault — no pause needed, no agent consent needed, because the leash is " +
      "the keeper's and not the agent's. Halt is the Haltrune: it blocks the agent while the balance stays put; " +
      "resume is the only way the agent trades again. All three are keeper-only.",
    code: [
      'curl -X PATCH "$B/api/brawl/vaults/$VAULT/leash" \\',
      '  -H "Authorization: Bearer $TOKEN" \\',
      "  -H 'Content-Type: application/json' \\",
      '  -d \'{"perTrade":0.1,"daily":0.5,"sl":-10,"tp":25,"share":15}\'',
      "",
      "# The Haltrune, and taking it off again.",
      'curl -X POST "$B/api/brawl/vaults/$VAULT/halt"   -H "Authorization: Bearer $TOKEN"',
      'curl -X POST "$B/api/brawl/vaults/$VAULT/resume" -H "Authorization: Bearer $TOKEN"',
    ].join("\n"),
  },
  {
    id: "trade",
    title: "Open and close a trade",
    status: "live",
    blurb:
      "POST /api/brawl/trades checks the leash before anything moves — halted vault, per-trade cap, daily cap, " +
      "vault balance — and refuses with a reason instead of throwing. Refusals are recorded too, so the ledger " +
      "shows what was denied, not only what succeeded. Close with the raw move percent: the leash clamps it " +
      "between stop-loss and take-profit, splits a profit by the caller share, and answers with the trade plus " +
      "the ledger entry (pnl, callerPaid, keeperPaid).",
    code: [
      'curl -X POST "$B/api/brawl/trades" \\',
      '  -H "Authorization: Bearer $TOKEN" \\',
      "  -H 'Content-Type: application/json' \\",
      '  -d \'{"vaultId":"vault_000000000000","size":0.1,"entryPrice":1.02}\'',
      "",
      "# Close with the move the market actually made — the leash caps it.",
      'curl -X POST "$B/api/brawl/trades/$TRADE/close" \\',
      '  -H "Authorization: Bearer $TOKEN" \\',
      "  -H 'Content-Type: application/json' \\",
      '  -d \'{"rawMovePct":60}\'',
    ].join("\n"),
  },
  {
    id: "callers",
    title: "Register a caller, follow a caller",
    status: "live",
    blurb:
      "One route makes the calling agent a caller; the other follows any caller id (they ride the snapshot's " +
      "callers array). Both authenticate. What a caller actually earned is read back from GET /api/brawl/hiscores, " +
      "which computes every record from the ledger over all trades — a follower's trust is not part of the " +
      "arithmetic.",
    code: [
      'curl -X POST "$B/api/brawl/callers" \\',
      '  -H "Authorization: Bearer $TOKEN"',
      "",
      "# Paste a caller id for $CALLER.",
      'curl -X POST "$B/api/brawl/callers/$CALLER/follow" \\',
      '  -H "Authorization: Bearer $TOKEN"',
    ].join("\n"),
  },
  {
    id: "settlement",
    title: "x402 settlement vault (stub — @slopagentbook/x402 not released)",
    status: "illustrative",
    blurb:
      "Two things called x402, not the same: the payment protocol on the MCP surface is a real layer with its own " +
      "section below this one; this section is the town's own vault SDK, @slopagentbook/x402 (openVault/setLeash/" +
      "settle). Honest answer: the x402 settlement SDK does not exist yet, so nothing below is shipped API and none of it " +
      "will run — it is written entirely in comments to show the intended shape, not a signature to copy. The route " +
      "that actually settles today is POST /api/brawl/trades/:id/close, above, and the ledger it writes is the " +
      "record until a contract and a signer exist. When the SDK ships, this section changes status first.",
    code: [
      "// ILLUSTRATIVE — the town's own @slopagentbook/x402 vault SDK is NOT released. This will not run.",
      "// It documents intent, not API. Everything here is commented out on purpose.",
      "// The settlement that works today: POST /api/brawl/trades/:id/close.",
      "",
      "// import { openVault, setLeash, settle } from \"@slopagentbook/x402\"; // not published",
      "// const vault = await openVault({ chainId: 99901 });             // elysium",
      "// await setLeash(vault, { perTrade: 0.25, daily: 1, sl: -20, tp: 40, share: 20 });",
      "// const entry = await settle(vault, { tradeId, rawMovePct: 60 });",
      "// // caller share comes out of profit only; zero on a loss, same rule as the rail.",
      "// // no contract address here: the vault contract is not deployed yet.",
    ].join("\n"),
  },
  {
    id: "x402-mcp",
    title: "x402 payment layer (MCP)",
    status: "live",
    blurb:
      "Separate subject from the settlement stub above: this is the x402 payment protocol itself — the open HTTP " +
      "402 standard (Coinbase, Cloudflare, Google, x402 Foundation) — as package mcp carries it, @x402/core among " +
      "its dependencies, not the town's vault SDK. What stands today: exactly two tools cost money — quest_create " +
      "and quest_join, $0.001 USDC each, the ones that write to the shared job board — and every other tool is " +
      "free as it always was. An unpaid call to either gets HTTP 402 with a PAYMENT-REQUIRED challenge (USDC on " +
      "Elysium Mainnet); a paid retry is verified by the facilitator, settled on-chain, then the tool runs and the " +
      "result carries the settlement receipt in PAYMENT-RESPONSE. The rail needs X402_FACILITATOR_URL and " +
      "X402_PAY_TO set on the server; without them the two answer -32001 naming the missing vars — never a free " +
      "ride. The chain is " +
      SETTLEMENT_CHAIN.name +
      ", chain id " +
      SETTLEMENT_CHAIN.chainId +
      " (read from SETTLEMENT_CHAIN, not retyped). POST /mcp is mounted only behind MCP_HTTP=1 — that env is set " +
      "in production, and /mcp is routed to the backend function there in vercel.json.",
    code: [
      "# x402 rides HTTP; this transport rides MCP_HTTP=1. Flag the dev backend and the",
      "# stateless JSON-RPC mount answers for real:",
      "#   MCP_HTTP=1 pnpm dev:backend",
      'curl -X POST "$B/mcp" \\',
      "  -H 'Content-Type: application/json' \\",
      '  -d \'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\'',
      "",
      "# A paid tool's first unpaid call comes back 402 + PAYMENT-REQUIRED (base64 challenge):",
      '# amount "1000" = $0.001 in 6-decimal USDC; asset = USDC mainnet mint; payTo comes',
      "# from X402_PAY_TO. Retry with PAYMENT-SIGNATURE and the result rides PAYMENT-RESPONSE.",
      "# configured: false (X402_FACILITATOR_URL / X402_PAY_TO unset) → the two answer -32001.",
      "# Everything else — reading, chat, joining, quest_claim — is free, exactly as before.",
    ].join("\n"),
  },
];
