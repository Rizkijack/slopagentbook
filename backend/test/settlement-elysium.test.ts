import { describe, it, expect, afterEach } from "vitest";
import { SETTLEMENT_CHAIN, settlementStatus } from "../src/testnet.js";

// The settlement rail moved from Solana Mainnet to Elysium Mainnet (an
// Arbitrum Nitro EVM chain). The probe is back on `eth_chainId` — the one fact
// that answers "is this really 99901" — plus `web3_clientVersion` for the live
// client string.
//
// These matter more than they look: the Notice Board and the rail page both
// tell a reader to verify the chain themselves. A probe that silently reported
// nothing would leave those pages asserting a chain they had not checked.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stand in for the EVM JSON-RPC. Records what was asked. */
function evmRpc(responses: Record<string, unknown>, calls: string[] = []): typeof fetch {
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
  it("is Elysium Mainnet, with nothing Solana-shaped left on it", () => {
    expect(SETTLEMENT_CHAIN.name).toBe("Elysium Mainnet");
    expect(SETTLEMENT_CHAIN.nativeSymbol).toBe("HYPE");
    expect(SETTLEMENT_CHAIN.rpcUrl).toBe("https://rpc-live.boxa.club");
    expect(SETTLEMENT_CHAIN.explorer).toBe("https://boxa.club/explorer");
    // The fields that only meant something in a previous era are absent rather
    // than carried over with stale values.
    expect(SETTLEMENT_CHAIN.genesisHash).toBeUndefined();
    expect(SETTLEMENT_CHAIN.faucetUrl).toBeUndefined();
  });

  it("pins chain id 99901, which is the one checkable fact about it", () => {
    // Read live from https://rpc-live.boxa.club at retarget time: eth_chainId
    // answered 0x1863d. The chain id is what the Notice board tells a reader
    // to verify.
    expect(SETTLEMENT_CHAIN.chainId).toBe(99901);
    expect(SETTLEMENT_CHAIN.chainId).toBe(0x1863d);
  });
});

describe("settlementStatus", () => {
  it("reports the live client version and chain id when the RPC answers", async () => {
    const calls: string[] = [];
    globalThis.fetch = evmRpc({
      eth_chainId: "0x1863d",
      web3_clientVersion: "nitro/v3.12.1+70fa99a-20260929T140226Z/linux-amd64/go1.25.12",
    }, calls);

    const status = await settlementStatus();
    expect(status.reachable).toBe(true);
    expect(status.chainId).toBe(99901);
    expect(status.chainIdMatched).toBe(true);
    expect(status.clientVersion).toContain("nitro/");
    // and it asked the EVM methods, never the Solana ones
    expect(calls).toEqual(["eth_chainId", "web3_clientVersion"]);
    expect(calls).not.toContain("getHealth");
  });

  it("says plainly when the RPC it reached is not Elysium", async () => {
    // The chain id is the whole safety argument on the Notice board: an
    // endpoint that answers but reports the wrong chain is worse than one that
    // is unreachable, because it looks alive. The probe must not let that pass.
    globalThis.fetch = evmRpc({
      eth_chainId: "0x1", // Ethereum mainnet — not this rail
      web3_clientVersion: "geth/v1.13.0",
    });

    const status = await settlementStatus();
    expect(status.reachable).toBe(true);
    expect(status.chainId).toBe(1);
    expect(status.chainIdMatched).toBe(false);
    expect(status.note).toContain("not 99901");
  });

  it("stays honest about the missing contract even when the chain is up", async () => {
    globalThis.fetch = evmRpc({
      eth_chainId: "0x1863d",
      web3_clientVersion: "nitro/v3.12.1",
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
    expect(status.clientVersion).toBeUndefined();
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
