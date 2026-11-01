import { describe, it, expect } from "vitest";
import path from "path";
import os from "os";
import { defaultConfig } from "@slopagentbook/shared";

// Isolate persistence exactly like rebrand.test.ts does, so importing the
// server never touches the repo's data/town.json.
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = path.join(os.tmpdir(), `agentbook-chain-retarget-test-${process.pid}-${Date.now()}.json`);
const { applyChainRetarget, world } = await import("../src/server.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

/**
 * The exact config the production save carried before the chain move, lifted
 * field for field from the live town: Base, mainnet, mainnet.base.org, a
 * basescan explorer with the placeholder mint already appended, the base dex,
 * and no `nativeSymbol` at all (the field postdates the save).
 */
function baseEraSave(): Record<string, unknown> {
  return {
    name: "SlopAgentbook",
    ticker: "SLB",
    tokenAddress: "TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj",
    chainName: "Base",
    network: "mainnet",
    rpcUrl: "https://mainnet.base.org",
    explorer: "https://basescan.org/token/TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj",
    dexUrl: "https://dexscreener.com/base/",
    xUrl: "https://x.com/slopagentbook",
    maxHerd: 64,
  };
}

/**
 * A save's config wins over `defaultConfig`, so the chain move is invisible on
 * every town that already has one unless it is reconciled at boot. These pin
 * both halves: a Base-era or Solana-era save must be carried onto Elysium, and
 * a town that is already there — or that someone pointed somewhere by hand —
 * must not be.
 */

/**
 * The exact config the Solana-era save carried, lifted field for field from the
 * chain this migration just replaced.
 */
function solanaEraSave(): Record<string, unknown> {
  return {
    name: "SlopAgentbook",
    ticker: "SLB",
    tokenAddress: "",
    chainName: "Solana",
    network: "mainnet-beta",
    nativeSymbol: "SOL",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    explorer: "https://explorer.solana.com",
    dexUrl: "https://dexscreener.com/solana",
    xUrl: "https://x.com/slopagentbook",
    maxHerd: 200,
  };
}

describe("applyChainRetarget", () => {
  it("carries a Base-era town onto Elysium, changing exactly five fields", () => {
    const config = baseEraSave();
    const changed = applyChainRetarget(config);
    // `network` is not among them: the Base-era town already carried "mainnet",
    // which is exactly what Elysium's default is — nothing to change there.
    expect(changed.sort()).toEqual(["chainName", "dexUrl", "explorer", "nativeSymbol", "rpcUrl"]);
    expect(config.network).toBe("mainnet");
    expect(config.chainName).toBe("Elysium");
    expect(config.rpcUrl).toBe("https://rpc-live.boxa.club");
    expect(config.explorer).toBe("https://boxa.club/explorer");
    expect(config.dexUrl).toBe("https://dexscreener.com");
    expect(config.nativeSymbol).toBe("HYPE");
  });

  it("carries the Solana-era town onto Elysium — the move this migration exists for", () => {
    const config = solanaEraSave();
    const changed = applyChainRetarget(config);
    expect(changed.sort()).toEqual(["chainName", "dexUrl", "explorer", "nativeSymbol", "network", "rpcUrl"]);
    expect(config.chainName).toBe("Elysium");
    expect(config.network).toBe("mainnet");
    expect(config.rpcUrl).toBe("https://rpc-live.boxa.club");
    expect(config.explorer).toBe("https://boxa.club/explorer");
    expect(config.dexUrl).toBe("https://dexscreener.com");
    expect(config.nativeSymbol).toBe("HYPE");
  });

  it("returns exactly the keys it changed", () => {
    // A half-migrated town: every chain key already on the Elysium value except
    // the explorer, which still carries the Solana-era form. The returned list
    // is what the caller logs and persists, so a key that did not change
    // appearing in it would be a false "migrated" claim, and a changed key
    // missing from it would be a silent edit that never reaches the save.
    const config = {
      ...solanaEraSave(),
      chainName: "Elysium",
      network: "mainnet",
      rpcUrl: "https://rpc-live.boxa.club",
      dexUrl: "https://dexscreener.com",
    };
    expect(applyChainRetarget(config)).toEqual(["explorer", "nativeSymbol"]);
    expect(config.explorer).toBe("https://boxa.club/explorer");
    expect(config.nativeSymbol).toBe("HYPE");
  });

  it("carries a save written before the mint was appended to the explorer", () => {
    // The bare basescan URL is also a value this migration produced, so a town
    // that saved it earlier must not be left pointing at a dead explorer.
    const config = baseEraSave();
    config.explorer = "https://basescan.org";
    const changed = applyChainRetarget(config);
    expect(changed).toContain("explorer");
    expect(config.explorer).toBe("https://boxa.club/explorer");
  });

  it("leaves a town already on Elysium alone", () => {
    const config = {
      ...defaultConfig,
      tokenAddress: "So11111111111111111111111111111111111111112",
    };
    const before = { ...config };
    expect(applyChainRetarget(config)).toEqual([]);
    for (const key of Object.keys(before)) {
      expect(config[key], `${key} must not change`).toBe(before[key]);
    }
  });

  it("leaves a chain someone pointed elsewhere by hand alone", () => {
    // The rule is "matches a value the migration produced", not "differs from
    // the new default". An operator running a private fork on Arbitrum must not
    // be dragged to Solana by a branding-style reconciliation.
    const config = {
      ...baseEraSave(),
      nativeSymbol: "ETH",
      chainName: "Arbitrum",
      network: "arbitrum-one",
      rpcUrl: "https://arb1.arbitrum.io/rpc",
      explorer: "https://arbiscan.io/token/0xdead",
      dexUrl: "https://dexscreener.com/arbitrum",
    };
    const before = { ...config };
    expect(applyChainRetarget(config)).toEqual([]);
    for (const key of Object.keys(before)) {
      expect(config[key], `${key} must not change`).toBe(before[key]);
    }
  });

  it("never touches tokenAddress or tokenDeployed", () => {
    // The treasury surface. `applyRebrand` excludes it for exactly this reason:
    // a placeholder address resolves to nothing, but an operator's real address
    // points at real funds, and no default may rewrite it. The placeholder is
    // left to be invisible through `tokenDeployed` in the UI, not to be edited —
    // so the flag must not be set here either, or the UI would start rendering
    // an address that resolves to nothing.
    for (const config of [
      baseEraSave(),
      { ...defaultConfig, tokenAddress: "So11111111111111111111111111111111111111112" },
      { ...baseEraSave(), chainName: "Arbitrum" },
    ]) {
      const before = { ...config };
      applyChainRetarget(config as Record<string, unknown>);
      expect(config.tokenAddress, "tokenAddress must not change").toBe(before.tokenAddress);
      expect(config.tokenDeployed, "tokenDeployed must not change").toBe(before.tokenDeployed);
      expect("tokenDeployed" in config, "the flag must never be added").toBe("tokenDeployed" in before);
    }
  });

  it("does not clear a town that HAS deployed its mint", () => {
    // Distinct from the two above, and the one that matters most. An operator who
    // really has deployed a token carries a real address and `tokenDeployed:
    // true`. The retarget moves their chain to Elysium and must leave every bit of
    // that alone — in particular it must not "helpfully" reset the flag to
    // false, which would hide a genuinely deployed mint behind "No mint deployed
    // yet" and make a live token look like it never existed.
    const config = {
      ...baseEraSave(),
      tokenAddress: "So11111111111111111111111111111111111111112",
      tokenDeployed: true,
    };
    const changed = applyChainRetarget(config);
    expect(changed).toContain("chainName");
    expect(config.tokenAddress).toBe("So11111111111111111111111111111111111111112");
    expect(config.tokenDeployed).toBe(true);
  });

  it("refuses the whole town when one field names a chain it cannot account for", () => {
    // The mixed-config guard. An operator on their own Base node holds a
    // Base-era chainName but a hand-set rpcUrl and explorer. Retargeting only
    // the keys that match would leave them claiming Elysium while pointing at a
    // Base RPC — the corruption this function exists to prevent, and one nothing
    // downstream can detect. So: refuse, leaving a consistent stale town.
    const config = {
      ...baseEraSave(),
      rpcUrl: "https://rpc.mynode.io/base",
      explorer: "https://basescan.org/token/0xMyMint",
    };
    const before = { ...config };
    expect(applyChainRetarget(config)).toEqual([]);
    for (const key of Object.keys(before)) {
      expect(config[key], `${key} must not change`).toBe(before[key]);
    }
  });

  it("fills nativeSymbol on a save that never had the field", () => {
    // `nativeSymbol` is optional and postdates every old save, so there is no
    // previous value to match — absent is the whole test. Isolated on an
    // already-migrated config so the assertion is about this field alone.
    const config = { ...defaultConfig } as Record<string, unknown>;
    delete config.nativeSymbol;
    expect(applyChainRetarget(config)).toEqual(["nativeSymbol"]);
    expect(config.nativeSymbol).toBe("HYPE");
  });

  it("retargets the Solana-era nativeSymbol but leaves a hand-set one alone", () => {
    // "SOL" is the exact value the previous default wrote, so it retargets with
    // the rest. Anything else was set by an operator and survives untouched —
    // and the whole retarget is gated on isOurs, so a foreign town keeps its
    // symbol even when it happens to read "SOL".
    const ours = solanaEraSave();
    expect(applyChainRetarget(ours)).toContain("nativeSymbol");
    expect(ours.nativeSymbol).toBe("HYPE");

    const foreign = { ...defaultConfig, chainName: "Arbitrum" };
    delete (foreign as Record<string, unknown>).rpcUrl;
    delete (foreign as Record<string, unknown>).explorer;
    delete (foreign as Record<string, unknown>).dexUrl;
    (foreign as Record<string, unknown>).nativeSymbol = "SOL";
    const before = { ...foreign };
    expect(applyChainRetarget(foreign as Record<string, unknown>)).toEqual([]);
    expect((foreign as Record<string, unknown>).nativeSymbol).toBe(before.nativeSymbol);
  });

  it("does not crash on a config with the chain keys missing", () => {
    expect(() => applyChainRetarget({})).not.toThrow();
    // Every chain key is absent rather than stale, so nothing matches — and
    // `nativeSymbol` is NOT filled either. A config that names no chain at all
    // has not been recognized as ours, so asserting "SOL" on it would be a
    // claim this function cannot support. Filling it was the behaviour before
    // the isOurs gate; the crash-safety intent of this test is unchanged.
    expect(applyChainRetarget({})).toEqual([]);
  });

  it("will not drag a town on another chain by the word 'mainnet' alone", () => {
    // "mainnet" is not an Elysium value, it is the ordinary word for every
    // production EVM chain. Matched on its own it would rewrite `network` while
    // `chainName` still said Ethereum — the mixed config this whole function
    // exists to prevent. Only `network` and `nativeSymbol` are exposed here,
    // because only those two fail to identify a chain.
    const ethereum = {
      chainName: "Ethereum",
      network: "mainnet",
      rpcUrl: "https://eth.llamarpc.com",
      explorer: "https://etherscan.io/token/0xdead",
      dexUrl: "https://dexscreener.com/ethereum",
    };
    const before = { ...ethereum };
    expect(applyChainRetarget(ethereum)).toEqual([]);
    for (const key of Object.keys(before)) {
      expect(ethereum[key], `${key} must not change`).toBe(before[key]);
    }
    // the specific corruption, stated directly
    expect(ethereum.network).toBe("mainnet");
    expect("nativeSymbol" in ethereum).toBe(false);
  });

  it("heals a town half-migrated by hand — chain already Elysium, rpc still Solana's", () => {
    // Somebody pointed the town at Elysium themselves and missed one field. Any
    // field already on the Elysium value — or still on a value an earlier era of
    // this migration produced — identifies the town as ours, so the stale ones
    // heal rather than stranding the town in a mixed config.
    const config = { ...defaultConfig, rpcUrl: "https://api.mainnet-beta.solana.com" };
    expect(applyChainRetarget(config)).toEqual(["rpcUrl"]);
    expect(config.rpcUrl).toBe("https://rpc-live.boxa.club");
  });

  it("is idempotent — a second boot has nothing left to do", () => {
    const config = baseEraSave();
    expect(applyChainRetarget(config)).toHaveLength(5);
    expect(applyChainRetarget(config)).toEqual([]);
  });
});

describe("boot applies the chain retarget", () => {
  it("does not disturb a town that boots fresh on the current defaults", () => {
    // Deliberately narrow. The town this file boots from is a fresh
    // createInitialWorld(), so its config already IS defaultConfig and every
    // assertion below would hold with the boot block deleted outright — which is
    // exactly what made the old version of this test worthless.
    //
    // The boot path that CAN fail, seeded from a real Base-era save and checked
    // against the file on disk, lives in chain-retarget-boot.test.ts. What is
    // worth pinning here is only that booting does not disturb a town that is
    // already correct.
    expect(world.config.chainName).toBe(defaultConfig.chainName);
    expect(world.config.network).toBe(defaultConfig.network);
    expect(world.config.tokenAddress).toBe(defaultConfig.tokenAddress);
  });
});