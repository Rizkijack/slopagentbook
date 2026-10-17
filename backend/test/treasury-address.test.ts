import { describe, it, expect } from "vitest";
import { defaultConfig } from "@slopagentbook/shared";
import { applyTreasuryAddress } from "../src/server.js";

/**
 * The treasury address field never existed before, so there is no previous value
 * to match on — the only signal available is whether the key is there at all.
 *
 * That is a weaker guarantee than the brand, chain and brain reconciliations get
 * from matching an exact previous value, and it deserves to be pinned for exactly
 * that reason: absence has to mean "a save predates this field" and never "an
 * operator blanked it on purpose". The distinction is the whole test.
 */
describe("applyTreasuryAddress", () => {
  const REAL = "5wwSxR2Yttu3RieEEmKHmRq34EudDbMY42j9RLJfjMKs";

  it("fills a save that has never carried the field", () => {
    // the live production save: written before the field existed
    const config: Record<string, unknown> = {
      ...defaultConfig,
      tokenAddress: "",
      tokenDeployed: undefined,
    };
    delete config.treasuryAddress;

    expect(applyTreasuryAddress(config)).toEqual(["treasuryAddress"]);
    expect(config.treasuryAddress).toBe(defaultConfig.treasuryAddress);
  });

  it("is a real, well-formed Solana address and not a placeholder", () => {
    // The previous value this field's sibling held resolved to no account on
    // mainnet. Whatever lands here should at least be base58 of the right length,
    // so an empty or truncated string cannot be mistaken for an address.
    expect(defaultConfig.treasuryAddress).toBe(REAL);
    expect(REAL).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(REAL.length).toBeGreaterThanOrEqual(32);
    expect(REAL.length).toBeLessThanOrEqual(44);
  });

  it("leaves a config that already names an address alone", () => {
    const other = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const config = { ...defaultConfig, treasuryAddress: other };
    const before = { ...config };

    expect(applyTreasuryAddress(config)).toEqual([]);
    expect(config.treasuryAddress).toBe(other);
    for (const k of Object.keys(before)) expect(config[k], `${k} must not change`).toBe(before[k]);
  });

  it("leaves an address someone blanked BY HAND alone", () => {
    // The distinction this whole rule rests on. A blanked key is present and
    // empty; an absent key was never written. Only the second is filled, so an
    // operator who deliberately clears the field gets exactly what they asked
    // for rather than having a default rewritten over it on the next boot.
    const config: Record<string, unknown> = { ...defaultConfig, treasuryAddress: "" };

    expect(applyTreasuryAddress(config as Record<string, unknown>)).toEqual([]);
    expect(config.treasuryAddress).toBe("");
  });

  it("is idempotent, so a second boot has nothing to do", () => {
    // A reconciler that fires every boot rewrites the save on every boot, which
    // is the failure mode this pattern exists to avoid.
    const config: Record<string, unknown> = { ...defaultConfig };
    delete config.treasuryAddress;
    expect(applyTreasuryAddress(config)).toEqual(["treasuryAddress"]);
    expect(applyTreasuryAddress(config)).toEqual([]);
  });

  it("does nothing when the default itself is empty", () => {
    // A town with no address configured anywhere must stay addressless rather
    // than gain a blank string that reads as a stated one.
    const config: Record<string, unknown> = { tokenAddress: "" };
    const noDefault = () => {
      // simulate a build where the field ships empty
      const saved = defaultConfig.treasuryAddress;
      (defaultConfig as { treasuryAddress?: string }).treasuryAddress = undefined;
      try {
        return applyTreasuryAddress(config);
      } finally {
        (defaultConfig as { treasuryAddress?: string }).treasuryAddress = saved;
      }
    };
    expect(noDefault()).toEqual([]);
    expect("treasuryAddress" in config).toBe(false);
  });

  it("touches no other key on the way through", () => {
    const config: Record<string, unknown> = {
      ...defaultConfig,
      name: "SlopAgentbook",
      ticker: "SLB",
      tokenAddress: "So11111111111111111111111111111111111111112",
      brain: "sim",
      maxHerd: 200,
    };
    delete config.treasuryAddress;
    const before = { ...config };
    applyTreasuryAddress(config);
    for (const k of Object.keys(before)) {
      if (k === "treasuryAddress") continue;
      expect(config[k], `${k} must not change`).toBe(before[k]);
    }
  });
});
