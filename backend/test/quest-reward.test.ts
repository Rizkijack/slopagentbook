import { describe, it, expect } from "vitest";
import type { TownSnapshot } from "@slopagentbook/shared";
import { QUEST_REWARD_USD, QUEST_REWARD_MOCK, QUEST_REWARD_CURRENCY } from "@slopagentbook/shared";
import { questRewardInfo, QUEST_TEMPLATES } from "../src/quests.js";

const baseConfig = {
  tokenAddress: "",
  tokenDeployed: false,
  treasuryAddress: "0x8237a546ab643b444450d168a24842F27Fe75fC6",
} as TownSnapshot["config"];

describe("quest mock reward (1$ per 1 quest, token not launched)", () => {
  it("questRewardInfo carries usd=1, mock=true, currency USD", () => {
    const info = questRewardInfo(baseConfig);
    expect(info.usd).toBe(1);
    expect(info.usd).toBe(QUEST_REWARD_USD);
    expect(info.mock).toBe(true);
    expect(info.mock).toBe(QUEST_REWARD_MOCK);
    expect(info.currency).toBe("USD");
    expect(info.currency).toBe(QUEST_REWARD_CURRENCY);
    expect(info.mockUsd).toEqual({ usd: 1, currency: "USD", mock: true });
  });

  it("stays mock even once a mint is deployed (additive, spirits untouched)", () => {
    const info = questRewardInfo({ ...baseConfig, tokenAddress: "0xabc", tokenDeployed: true } as TownSnapshot["config"]);
    expect(info.spirits).toBe(true);
    expect(info.usd).toBe(1);
    expect(info.mock).toBe(true);
    expect(info.token.deployed).toBe(true);
  });

  it("the template pool is covered: every template draws the same reward contract", () => {
    // Templates themselves carry no rewardToken (it's response metadata); the
    // contract is global, so the pool needs no per-template USD value.
    expect(QUEST_TEMPLATES.length).toBeGreaterThan(0);
    const info = questRewardInfo(baseConfig);
    for (const tpl of QUEST_TEMPLATES) {
      expect(tpl.reward.text).toBeTruthy();
      expect(info.usd).toBe(1);
    }
  });
});
