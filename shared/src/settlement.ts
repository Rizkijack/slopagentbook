import type { SettlementChain } from "./types.js";

// The settlement rail's identity, in the one place the whole repo reads it from.
// Backend `testnet.ts` probes it and re-exports the constant so its own importers
// do not move; the frontend imports it directly for the unit labels (vault
// balances, trade sizes, leash caps) rather than re-typing "HYPE" in twenty files.
//
// Elysium is an EVM chain (an Arbitrum Nitro rollup), so the identity is a chain
// id again: 99901, the single most checkable fact about this rail, read live by
// the probe with `eth_chainId`. The RPC answers it — verified at retarget time —
// and so does `web3_clientVersion` (nitro/v3.x). The Solana era named the chain
// by its genesis hash because Solana has no chain id; that field stays optional
// on the type for the history of saves, and is no longer set.
//
// There is no faucet on mainnet, so `faucetUrl` is absent rather than left
// pointing at a testnet that no longer applies.
//
// Honest about what is not real: no vault contract is deployed on this chain
// and no signer is configured. This names the chain; it claims nothing is live
// on it.
export const SETTLEMENT_CHAIN: SettlementChain = {
  name: "Elysium Mainnet",
  rpcUrl: "https://rpc-live.boxa.club",
  explorer: "https://boxa.club/explorer",
  nativeSymbol: "HYPE",
  chainId: 99901,
};
