import { describe, it, expect, afterEach } from "vitest";
import { SETTLEMENT_CHAIN, settlementStatus } from "../src/testnet.js";

// The settlement rail moved from Robinhood Chain Testnet 46630 to Solana Mainnet,
// and Solana is not EVM. The probe used to ask `eth_chainId` and report the
// number back; there is no equivalent on Solana, so it asks getHealth and
// getVersion instead and reports the live core version.
//
// These matter more than they look: the Notice Board and the rail page both
// tell a reader to verify the chain themselves. A probe that silently reported
// nothing would leave those pages asserting a chain they had not checked.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stand in for the Solana JSON-RPC. Records what was asked. */
function solanaRpc(responses: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    calls.push(body.method);
    const result = responses[body.method];
    return {
      ok: true,
      status: 200,
      json: async () => (result === undefined
        ? { error: { message: `unknown method ${body.method}` } }
        : { result }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("the settlement rail", () => {
  it("is Solana Mainnet, with nothing EVM-shaped left on it", () => {
    expect(SETTLEMENT_CHAIN.name).toBe("Solana Mainnet");
    expect(SETTLEMENT_CHAIN.nativeSymbol).toBe("SOL");
    expect(SETTLEMENT_CHAIN.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    // The two fields that only mean something on an EVM testnet are absent
    // rather than carried over with stale values.
    expect(SETTLEMENT_CHAIN.chainId).toBeUndefined();
    expect(SETTLEMENT_CHAIN.faucetUrl).toBeUndefined();
  });

  it("pins the mainnet-beta genesis hash, which is the one checkable fact about it", () => {
    // Read live from https://api.mainnet-beta.solana.com on 12 Oct 2026. A chain
    // id was never going to work here; the genesis hash is Solana's equivalent
    // and it is what the Notice board tells a reader to verify.
    expect(SETTLEMENT_CHAIN.genesisHash).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  });
});

describe("settlementStatus", () => {
  const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

  it("reports the live core version when the RPC answers", async () => {
    const calls: string[] = [];
    globalThis.fetch = solanaRpc({
      getHealth: "ok",
      getVersion: { "solana-core": "2.2.14" },
      getGenesisHash: MAINNET_GENESIS,
    }, calls);

    const status = await settlementStatus();
    expect(status.reachable).toBe(true);
    expect(status.coreVersion).toBe("2.2.14");
    expect(status.genesisHash).toBe(MAINNET_GENESIS);
    expect(status.genesisMatched).toBe(true);
    // and it asked Solana's own methods, never the EVM one
    expect(calls).toEqual(["getHealth", "getVersion", "getGenesisHash"]);
    expect(calls).not.toContain("eth_chainId");
  });

  it("says plainly when the RPC it reached is not mainnet-beta", async () => {
    // The hash is the whole safety argument on the Notice board: an endpoint
    // that answers but reports the wrong cluster is worse than one that is
    // unreachable, because it looks alive. The probe must not let that pass.
    globalThis.fetch = solanaRpc({
      getHealth: "ok",
      getVersion: { "solana-core": "2.2.14" },
      getGenesisHash: "TestnetGenesisHashThatIsNotMainnetBetaXXXXXXXXXXXX",
    });

    const status = await settlementStatus();
    expect(status.reachable).toBe(true);
    expect(status.genesisMatched).toBe(false);
    expect(status.note).toContain("not mainnet-beta's");
  });

  it("stays honest about the missing contract even when the chain is up", async () => {
    globalThis.fetch = solanaRpc({
      getHealth: "ok",
      getVersion: { "solana-core": "2.2.14" },
      getGenesisHash: MAINNET_GENESIS,
    });
    const status = await settlementStatus();

    // Reachable chain is not a deployed vault. This is the line the Notice
    // Board's whole safety argument rests on, so it is asserted directly.
    expect(status.configured).toBe(false);
    expect(status.note).toMatch(/no vault contract is deployed/i);
    expect(status.note).toMatch(/no signer is configured/i);
  });

  it("says the rail is unreachable rather than pretending otherwise", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const status = await settlementStatus();

    expect(status.reachable).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.coreVersion).toBeUndefined();
    expect(status.note).toMatch(/unreachable/i);
    expect(status.note).toContain("ECONNREFUSED");
  });

  it("treats an RPC-level error as unreachable, not as a healthy chain", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { message: "node is behind" } }),
    } as unknown as Response)) as unknown as typeof fetch;

    const status = await settlementStatus();
    expect(status.reachable).toBe(false);
    expect(status.note).toContain("node is behind");
  });
});