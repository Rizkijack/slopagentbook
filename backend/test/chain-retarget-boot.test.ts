import { describe, it, expect } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { defaultConfig } from "@slopagentbook/shared";
import { createInitialWorld } from "../src/world.js";

// The unit suite in chain-retarget.test.ts proves applyChainRetarget does the
// right thing to a config OBJECT. It cannot prove the boot actually calls it —
// and until this file existed, deleting the entire boot block, its log and its
// save left all 13 unit tests green. That block is the only part of this change
// that writes to persisted production state, so it is the part that has to be
// covered here.
//
// Isolated exactly like rebrand.test.ts: a private DATA_PATH, so importing the
// server never touches the repo's data/town.json. This file differs in one
// respect that matters — it seeds that path with a Base-era town BEFORE the
// import, which is the only way to make the boot path see a save it has to
// migrate rather than create a fresh town already on the new defaults.
const DATA_PATH = path.join(os.tmpdir(), `agentbook-chain-boot-${process.pid}-${Date.now()}.json`);
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = DATA_PATH;

// A real, schema-valid town from createInitialWorld rather than a hand-built
// object, so loadWithRecovery sees something it would actually accept, then put
// its config back to the Base-era values the live save carried. `nativeSymbol`
// and `tokenDeployed` are absent, as they are on every save predating them.
const seeded = createInitialWorld();
seeded.config = {
  ...defaultConfig,
  chainName: "Base",
  network: "mainnet",
  rpcUrl: "https://mainnet.base.org",
  explorer: "https://basescan.org/token/TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj",
  dexUrl: "https://dexscreener.com/base/",
  nativeSymbol: undefined,
  tokenDeployed: undefined,
  tokenAddress: "TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj",
} as typeof defaultConfig;
fs.writeFileSync(DATA_PATH, JSON.stringify(seeded));

const { world } = await import("../src/server.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

/**
 * Read what actually landed on disk.
 *
 * Waits for the debounced save to produce a config that DIFFERS from the one
 * seeded, then returns it. It deliberately does not poll for "Solana" — that
 * would be circular, since it would assert the very condition it waited for.
 * What is being established is "a save happened"; what is then asserted, by the
 * caller, is what that save actually contained.
 *
 * The deadline is generous on purpose. It was 5s and the two tests that call
 * this both hit it during a full `pnpm test`, where four packages run their
 * suites concurrently on a 4-core box with low free RAM — the signature was the
 * file taking ~10045ms, i.e. two 5s windows expiring. Run alone it passes in
 * 40ms, so the deadline is what was wrong, not the reconciliation. A save that
 * never lands still fails; it just gets 15s to land.
 */
async function readPersistedConfig(): Promise<Record<string, unknown>> {
  const seededAs = JSON.stringify(seeded.config);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) as { config?: Record<string, unknown> };
      if (parsed.config && JSON.stringify(parsed.config) !== seededAs) return parsed.config;
    } catch {
      // not written yet, or mid-atomic-write
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the retarget never reached disk");
}

describe("booting a town whose save still carries the Base chain", () => {
  it("brings it up on Solana, on every field the move changed", () => {
    // The load itself is what makes this test able to fail: without the boot
    // reconciliation, world.config is exactly the Base-era config seeded above.
    expect(world.config.chainName).toBe("Solana");
    expect(world.config.network).toBe("mainnet-beta");
    expect(world.config.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(world.config.explorer).toBe("https://explorer.solana.com");
    expect(world.config.nativeSymbol).toBe("SOL");
  });

  it("persists the retarget, so the next boot starts from the new chain", async () => {
    const onDisk = await readPersistedConfig();
    expect(onDisk.chainName).toBe("Solana");
    expect(onDisk.network).toBe("mainnet-beta");
    expect(onDisk.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
  });

  it("does not touch the treasury surface on the way through", async () => {
    // The placeholder is invisible in the UI because `tokenDeployed` is absent,
    // not because the boot blanked or edited it. An operator's real address must
    // survive this boot for exactly the same reason, so it is asserted here on a
    // real boot rather than only on a unit-level config object.
    const onDisk = await readPersistedConfig();
    expect(onDisk.tokenAddress).toBe("TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj");
    expect("tokenDeployed" in onDisk).toBe(false);
    expect(world.config.tokenAddress).toBe("TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj");
  });
});