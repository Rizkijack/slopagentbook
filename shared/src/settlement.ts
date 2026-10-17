import type { SettlementChain } from "./types.js";

// The settlement rail's identity, in the one place the whole repo reads it from.
// Backend `testnet.ts` probes it and re-exports the constant so its own importers
// do not move; the frontend imports it directly for the unit labels (vault
// balances, trade sizes, leash caps) rather than re-typing "SOL" in twenty files.
//
// Solana is not EVM, and that decides every field. The cluster is named by its
// genesis hash instead of a chain id — mainnet-beta is
// `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, which is the single most
// checkable fact about this rail and is read live by the probe. There is no
// faucet on mainnet, so `faucetUrl` is absent rather than left pointing at a
// testnet that no longer applies.
//
// Honest about what is not real: no vault contract is deployed on this cluster
// and no signer is configured. This names the chain; it claims nothing is live
// on it.
export const SETTLEMENT_CHAIN: SettlementChain = {
  name: "Solana Mainnet",
  rpcUrl: "https://api.mainnet-beta.solana.com",
  explorer: "https://explorer.solana.com",
  nativeSymbol: "SOL",
  genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};
