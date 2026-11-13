import type { SettlementChain } from "./types.js";

// The settlement rail's identity, in the one place the whole repo reads it from.
// Backend `testnet.ts` probes it and re-exports the constant so its own importers
// do not move; the frontend imports it directly for the unit labels (vault
// balances, trade sizes, leash caps) rather than re-typing "ETH" in twenty files.
//
// Zero is an EVM chain (a ZK Stack rollup), so the identity is a chain id: 543210,
// the fact a reader can check once an RPC exists. Both `rpcUrl` and `explorer`
// are deliberately empty: the operator has not published endpoints yet, and a
// placeholder URL would be a claim this rail cannot support. The probe treats an
// empty RPC as "not configured" rather than an unreachable node.
//
// The Solana era named the chain by its genesis hash because Solana has no chain
// id; that field stays optional on the type for the history of saves, and is no
// longer set.
//
// There is no faucet on mainnet, so `faucetUrl` is absent rather than left
// pointing at a testnet that no longer applies.
//
// Honest about what is not real: no vault contract is deployed on this chain
// and no signer is configured. This names the chain; it claims nothing is live
// on it.
export const SETTLEMENT_CHAIN: SettlementChain = {
  name: "Zero Mainnet",
  rpcUrl: "",
  explorer: "",
  nativeSymbol: "ETH",
  chainId: 543210,
};
