import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";
import type { SettlementChain } from "@slopagentbook/shared";

// Re-exported so existing importers (`brawl.ts`, the rail tests) keep reading the
// same constant through the module that probes it. The owner is the shared
// contract — see shared/src/settlement.ts.
export { SETTLEMENT_CHAIN };

// Elysium Mainnet settlement rail (an Arbitrum Nitro EVM chain, chain id 99901).
// This module is deliberately honest about what is and is not real: the RPC and
// explorer are the published mainnet endpoints, but no vault contract is deployed
// and no keys exist. Every function here either reads public chain state or
// returns an explicit "not configured" — nothing fabricates a signature or
// pretends a deploy happened.
//
// EVM shapes the whole file: the probe asks eth_chainId — the one fact that
// answers "is this really 99901" — and web3_clientVersion for the client
// string. There is no faucet on mainnet, so that field is simply absent rather
// than left pointing at a testnet.
//
// The previous rail was Solana Mainnet, which named itself by its genesis hash
// because it has no chain id; before that, Robinhood Chain Testnet 46630. Both
// have been removed rather than kept as options.

export interface ChainStatus {
  configured: boolean;
  chain: SettlementChain;
  /** Live client version read from the RPC, when reachable. */
  clientVersion?: string;
  /** Live chain id read from the RPC, when reachable. */
  chainId?: number;
  /** Whether the live chain id is the 99901 this rail claims. */
  chainIdMatched?: boolean;
  reachable?: boolean;
  note: string;
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(SETTLEMENT_CHAIN.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

/**
 * Probe the settlement rail. Returns the live client version and chain id when
 * the RPC answers, and always states plainly that no contract is deployed. A
 * caller showing this on the Notice board gets the truth: the rail is real, the
 * vault is not yet on-chain.
 *
 * The chain id is the reason this probes at all — it is the one fact that
 * answers "is this really 99901", which is exactly the question the Notice
 * board tells a reader to check.
 */
export async function settlementStatus(): Promise<ChainStatus> {
  const base: ChainStatus = {
    configured: false,
    chain: SETTLEMENT_CHAIN,
    note: "No vault contract is deployed and no signer is configured. Settlement is simulated locally until a contract and key exist.",
  };
  try {
    const raw = await rpc<string>("eth_chainId");
    const client = await rpc<string>("web3_clientVersion");
    const live = typeof raw === "string" ? parseInt(raw, 16) : NaN;
    const matched = live === SETTLEMENT_CHAIN.chainId;
    return {
      ...base,
      reachable: true,
      clientVersion: client,
      chainId: live,
      chainIdMatched: matched,
      note: matched
        ? base.note
        : `${base.note} The chain id the RPC reports is not 99901 — do not trust this endpoint.`,
    };
  } catch (e) {
    return { ...base, reachable: false, note: `${base.note} (RPC unreachable: ${e instanceof Error ? e.message : String(e)})` };
  }
}
