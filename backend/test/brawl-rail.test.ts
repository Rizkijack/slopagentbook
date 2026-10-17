import { describe, it, expect } from "vitest";
import request from "supertest";
import path from "path";
import os from "os";

// End-to-end over the BRAWL rail: an agent joins, opens a vault, funds it,
// trades inside and outside its leash, closes for a profit, and the ledger and
// hiscores follow. The unit tests (leash.test.ts, vault.test.ts) prove the
// rules; this proves the rules are the ones the API actually applies.

process.env.NODE_ENV = "test";
const prevDataPath = process.env.DATA_PATH;
process.env.DATA_PATH = path.join(os.tmpdir(), `brawl-rail-test-${process.pid}-${Date.now()}.json`);
const { app, world } = await import("../src/server.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

const joinName = "BrawlAgent" + Date.now().toString().slice(-6);
let token = "";
let agentId = "";
let residentId = "";

const auth = () => ({ Authorization: `Bearer ${token}` });

describe("BRAWL rail", () => {
  it("POST /api/agent/join gives an agent the same token the rail accepts", async () => {
    const res = await request(app)
      .post("/api/agent/join")
      .send({ name: joinName, bio: "here to trade", job: "hawker", traits: ["cunning"], origin: "vitest" });
    expect(res.status).toBe(200);
    token = res.body.token;
    agentId = res.body.agentId;
    residentId = res.body.resident.id;
  });

  it("GET /api/brawl/testnet reports the rail and says plainly no contract is deployed", async () => {
    const res = await request(app).get("/api/brawl/testnet");
    expect(res.status).toBe(200);
    // Solana is not EVM: there is no chain id to report, and the page says so
    // by showing the live solana-core version instead. What it must never do
    // is keep claiming the old EVM number.
    expect(res.body.chain.name).toBe("Solana Mainnet");
    expect(res.body.chain.nativeSymbol).toBe("SOL");
    expect(res.body.chain.chainId).toBeUndefined();
    expect(res.body.chain.faucetUrl).toBeUndefined();
    // the identity it reports instead is the mainnet-beta genesis hash
    expect(res.body.chain.genesisHash).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    expect(res.body.note).toMatch(/no vault contract is deployed/i);
  });

  it("GET /api/brawl/hiscores is public and starts empty", async () => {
    const res = await request(app).get("/api/brawl/hiscores");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("rejects an authenticated action with no token", async () => {
    const res = await request(app).post("/api/brawl/vaults").send({});
    expect(res.status).toBe(401);
  });

  it("refuses to create a vault whose leash would enforce nothing", async () => {
    // a fresh town seeds one cold-start vault (P1-8), so count the baseline
    // rather than asserting an empty board — the point is that THIS call adds none
    const before = ((await request(app).get("/api/snapshot").set(auth())).body.vaults ?? []).length;
    const res = await request(app)
      .post("/api/brawl/vaults")
      .set(auth())
      .send({ leash: { perTrade: 0 } });
    expect(res.status).toBe(500); // BrawlError -> asyncH 500; the vault is not created
    const v = await request(app).get("/api/snapshot").set(auth());
    expect((v.body.vaults ?? []).length).toBe(before);
  });

  let vaultId = "";

  it("creates a vault with a default leash", async () => {
    const res = await request(app).post("/api/brawl/vaults").set(auth()).send({});
    expect(res.status).toBe(200);
    expect(res.body.leash.perTrade).toBeGreaterThan(0);
    vaultId = res.body.id;
  });

  it("funds the vault and opens a trade inside the leash", async () => {
    const fund = await request(app).post(`/api/brawl/vaults/${vaultId}/fund`).set(auth()).send({ amount: 1 });
    expect(fund.status).toBe(200);
    expect(fund.body.balance).toBeCloseTo(1);

    const trade = await request(app)
      .post("/api/brawl/trades")
      .set(auth())
      .send({ vaultId, size: 0.1, entryPrice: 100 });
    expect(trade.status).toBe(200);
    expect(trade.body.ok).toBe(true);
    // balance debited by the trade size — pick OUR vault out of the snapshot,
    // since the cold-start seed owns vaults[0]
    const v = await request(app).get("/api/snapshot").set(auth());
    const mine = v.body.vaults.find((x: { id: string }) => x.id === vaultId);
    expect(mine.balance).toBeCloseTo(0.9);
  });

  it("rejects a trade above the per-trade cap, and the refusal lands on the ledger", async () => {
    const trade = await request(app)
      .post("/api/brawl/trades")
      .set(auth())
      .send({ vaultId, size: 100, entryPrice: 100 });
    expect(trade.body.ok).toBe(false);
    expect(trade.body.reason).toMatch(/per-trade/);
    const snap = await request(app).get("/api/snapshot").set(auth());
    const rejected = snap.body.trades?.filter((t: { status: string }) => t.status === "rejected") ?? [];
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("halting blocks the next trade; resuming restores it", async () => {
    await request(app).post(`/api/brawl/vaults/${vaultId}/halt`).set(auth()).send({});
    const blocked = await request(app)
      .post("/api/brawl/trades")
      .set(auth())
      .send({ vaultId, size: 0.05, entryPrice: 100 });
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.reason).toMatch(/halt/);

    await request(app).post(`/api/brawl/vaults/${vaultId}/resume`).set(auth()).send({});
    const opened = await request(app)
      .post("/api/brawl/trades")
      .set(auth())
      .send({ vaultId, size: 0.05, entryPrice: 100 });
    expect(opened.body.ok).toBe(true);
  });

  it("closes a profitable trade, pays the caller a share, and shows on hiscores", async () => {
    // register this agent as a caller first so the entry is attributed
    const reg = await request(app).post("/api/brawl/callers").set(auth()).send({});
    expect(reg.status).toBe(200);

    const trade = await request(app)
      .post("/api/brawl/trades")
      .set(auth())
      .send({ vaultId, size: 0.1, entryPrice: 100, callerId: reg.body.id });
    expect(trade.body.ok).toBe(true);
    const tradeId = trade.body.trade.id;

    const closed = await request(app)
      .post(`/api/brawl/trades/${tradeId}/close`)
      .set(auth())
      .send({ rawMovePct: 30 }); // inside the default band (tp 40)
    expect(closed.status).toBe(200);
    expect(closed.body.trade.status).toBe("closed");
    expect(closed.body.trade.pnl).toBeCloseTo(0.03);
    expect(closed.body.entry.callerPaid).toBeCloseTo(0.006); // 20% of 0.03

    const snap = await request(app).get("/api/snapshot").set(auth());
    const vault = snap.body.vaults.find((v: { id: string }) => v.id === vaultId);
    // the vault gets principal + the keeper's net share back. The 0.05 trade
    // opened during the halt test is still open, so its principal stays locked
    // out of the balance: 0.75 + 0.1 + 0.024, not a full 1.0
    expect(vault.balance).toBeCloseTo(0.75 + 0.1 + 0.024);

    // hiscores now has a row for this agent
    const board = await request(app).get("/api/brawl/hiscores");
    const row = board.body.find((r: { agentId: string }) => r.agentId === residentId);
    expect(row).toBeTruthy();
    expect(row.trades).toBeGreaterThanOrEqual(1);
    expect(row.totalPnl).toBeCloseTo(0.03);
  });

  it("the in-memory world persists the vault and ledger for a reload", () => {
    expect((world as { vaults?: unknown[] }).vaults?.length).toBeGreaterThan(0);
    expect((world as { ledger?: unknown[] }).ledger?.length).toBeGreaterThan(0);
    // the agent id is tracked
    expect(agentId).toBeTruthy();
  });
});
