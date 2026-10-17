import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";
import type { SettlementChain } from "@slopagentbook/shared";

// Re-exported so existing importers (`brawl.ts`, the rail tests) keep reading the
// same constant through the module that probes it. The owner is the shared
// contract — see shared/src/settlement.ts.
export { SETTLEMENT_CHAIN };

// Solana Mainnet settlement rail. This module is deliberately honest about what
// is and is not real: the RPC and explorer are the published mainnet endpoints,
// but no vault contract is deployed and no keys exist. Every function here
// either reads public chain state or returns an explicit "not configured" —
// nothing fabricates a signature or pretends a deploy happened.
//
// Solana is not EVM, and that shapes the whole file. There is no eth_chainId,
// so the probe asks getHealth/getVersion/getGenesisHash instead; the cluster is
// named by its genesis hash rather than a number; there is no faucet on mainnet,
// so that field is simply absent rather than left pointing at a testnet.
//
// The previous rail was Robinhood Chain Testnet 46630, an Arbitrum L2. It has
// been removed rather than kept as an option.

export interface ChainStatus {
  configured: boolean;
  chain: SettlementChain;
  /** Live solana-core version read from the RPC, when reachable. */
  coreVersion?: string;
  /** Live genesis hash read from the RPC, when reachable. */
  genesisHash?: string;
  /** Whether the live genesis hash is the mainnet-beta one this rail claims. */
  genesisMatched?: boolean;
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
 * Probe the settlement rail. Returns the live core version and genesis hash when
 * the RPC answers, and always states plainly that no contract is deployed. A
 * caller showing this on the Notice board gets the truth: the rail is real, the
 * vault is not yet on-chain.
 *
 * The genesis hash is the reason this probes at all — it is the one fact that
 * answers "is this really mainnet-beta", which is exactly the question the
 * Notice board tells a reader to check.
 */
export async function settlementStatus(): Promise<ChainStatus> {
  const base: ChainStatus = {
    configured: false,
    chain: SETTLEMENT_CHAIN,
    note: "No vault contract is deployed and no signer is configured. Settlement is simulated locally until a contract and key exist.",
  };
  try {
    // getHealth is Solana's liveness check; there is no eth_chainId to ask for.
    await rpc<string>("getHealth");
    const version = await rpc<{ "solana-core": string }>("getVersion");
    const hash = await rpc<string>("getGenesisHash");
    const matched = typeof hash === "string" && hash === SETTLEMENT_CHAIN.genesisHash;
    return {
      ...base,
      reachable: true,
      coreVersion: version?.["solana-core"],
      genesisHash: hash,
      genesisMatched: matched,
      note: matched
        ? base.note
        : `${base.note} The genesis hash the RPC reports is not mainnet-beta's — do not trust this endpoint.`,
    };
  } catch (e) {
    return { ...base, reachable: false, note: `${base.note} (RPC unreachable: ${e instanceof Error ? e.message : String(e)})` };
  }
}
