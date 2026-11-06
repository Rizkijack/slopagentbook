import { defineChain, type Chain } from "viem";
import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";

// AppKit and wagmi both need the rail as a viem Chain. Every field is read from
// shared/src/settlement.ts — id, RPC, explorer, symbol — never re-typed here: a
// copied chain table is the exact class of bug this repo has already paid for
// (AGENTS.md, "One table, read from its source"). The assertion on chainId is
// safe because the constant sets it; the field stays optional only so saves
// written during the Solana era still parse.
// The explicit `Chain` annotation is not decoration: without it the composite
// project can't name viem's inferred chain type portably (TS2742).
export const townChain: Chain = defineChain({
  id: SETTLEMENT_CHAIN.chainId!,
  name: SETTLEMENT_CHAIN.name,
  nativeCurrency: {
    name: SETTLEMENT_CHAIN.nativeSymbol,
    symbol: SETTLEMENT_CHAIN.nativeSymbol,
    decimals: 18,
  },
  rpcUrls: { default: { http: [SETTLEMENT_CHAIN.rpcUrl] } },
  blockExplorers: {
    default: { name: `${SETTLEMENT_CHAIN.name} explorer`, url: SETTLEMENT_CHAIN.explorer },
  },
});
