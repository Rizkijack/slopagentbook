import { describe, it, expect } from "vitest";
import request from "supertest";
import path from "path";
import os from "os";

// BRAWL auth (§4.3.1, V5). The blueprint's original "no auth" was a downgrade:
// /api/brawl/vaults/:id/halt with no guard lets any resident kill anyone's
// vault. This locks the property down: mutating vault routes are keeper-only
// (401 unauthenticated, 403 wrong keeper), content routes stay public, and
// every mutating route is rate-limited per IP.

process.env.NODE_ENV = "test";
const prevDataPath = process.env.DATA_PATH;
process.env.DATA_PATH = path.join(os.tmpdir(), `brawl-auth-test-${process.pid}-${Date.now()}.json`);
const { app } = await import("../src/server.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

// Two agents. Agent A owns the vault; agent B must be refused on it.
async function join(name: string) {
  const res = await request(app)
    .post("/api/agent/join")
    .send({ name, bio: "auth test", job: "keeper", traits: ["careful"], origin: "vitest" });
  expect(res.status).toBe(200);
  return { token: res.body.token as string, residentId: res.body.resident.id as string };
}

const A = await join("BrawlKeeperA" + Date.now().toString().slice(-5));
const B = await join("BrawlOtherB" + Date.now().toString().slice(-5));

const authA = () => ({ Authorization: `Bearer ${A.token}` });
const authB = () => ({ Authorization: `Bearer ${B.token}` });

let vaultId = "";
let tradeId = "";

describe("BRAWL auth", () => {
  it("agent A creates a vault it owns", async () => {
    const res = await request(app).post("/api/brawl/vaults").set(authA()).send({});
    expect(res.status).toBe(200);
    vaultId = res.body.id;
    expect(res.body.keeperId).toBe(A.residentId);
  });

  it("a mutating route with no token is 401, not 200", async () => {
    for (const route of [
      ["post", `/api/brawl/vaults/${vaultId}/fund`, { amount: 1 }],
      ["patch", `/api/brawl/vaults/${vaultId}/leash`, { perTrade: 0.1 }],
      ["post", `/api/brawl/vaults/${vaultId}/halt`, {}],
      ["post", `/api/brawl/vaults/${vaultId}/resume`, {}],
      ["post", "/api/brawl/trades", { vaultId, size: 0.1, entryPrice: 100 }],
      ["post", "/api/brawl/callers", {}],
    ] as const) {
      const [verb, url, body] = route;
      const res = await (request(app) as any)[verb](url).send(body);
      expect(res.status, `${verb} ${url} must require auth`).toBe(401);
    }
  });

  it("agent B (authenticated, not the keeper) is 403 on the keeper's vault", async () => {
    const fund = await request(app)
      .post(`/api/brawl/vaults/${vaultId}/fund`)
      .set(authB())
      .send({ amount: 1 });
    expect(fund.status).toBe(403);
    expect(fund.body.error).toMatch(/keeper/i);

    const halt = await request(app).post(`/api/brawl/vaults/${vaultId}/halt`).set(authB()).send({});
    expect(halt.status).toBe(403);

    const leash = await request(app)
      .patch(`/api/brawl/vaults/${vaultId}/leash`)
      .set(authB())
      .send({ perTrade: 0.1 });
    expect(leash.status).toBe(403);
  });

  it("agent A, the keeper, passes the same routes", async () => {
    const fund = await request(app)
      .post(`/api/brawl/vaults/${vaultId}/fund`)
      .set(authA())
      .send({ amount: 1 });
    expect(fund.status).toBe(200);

    const leash = await request(app)
      .patch(`/api/brawl/vaults/${vaultId}/leash`)
      .set(authA())
      .send({ perTrade: 0.2 });
    expect(leash.status).toBe(200);

    const halt = await request(app).post(`/api/brawl/vaults/${vaultId}/halt`).set(authA()).send({});
    expect(halt.status).toBe(200);
    expect(halt.body.paused).toBe(true);

    const resume = await request(app).post(`/api/brawl/vaults/${vaultId}/resume`).set(authA()).send({});
    expect(resume.status).toBe(200);
    expect(resume.body.paused).toBe(false);
  });

  it("a bad token is 401, not a silent pass", async () => {
    const res = await request(app)
      .post(`/api/brawl/vaults/${vaultId}/fund`)
      .set({ Authorization: "Bearer not-a-real-token" })
      .send({ amount: 1 });
    expect(res.status).toBe(401);
  });

  // Trade ownership is a SEPARATE guard from keeper ownership: `open` moves the
  // authorised AGENT's money (`vault.agentId`), `close` settles it and is
  // already documented as a keeper action in brawl.ts's requireKeeper comment.
  // Without either, any authenticated resident could open against someone else's
  // vault and close it at a move they chose, minting `balance += size + keeperPaid`.
  it("agent B cannot open a trade against the keeper's vault", async () => {
    const res = await request(app)
      .post("/api/brawl/trades")
      .set(authB())
      .send({ vaultId, size: 0.1, entryPrice: 100 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/agent/i);
  });

  it("agent A, the authorised agent, can open on its own vault", async () => {
    const res = await request(app)
      .post("/api/brawl/trades")
      .set(authA())
      .send({ vaultId, size: 0.1, entryPrice: 100 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    tradeId = res.body.trade.id;
    expect(tradeId).toBeTruthy();
  });

  it("agent B cannot close a trade on the keeper's vault", async () => {
    const res = await request(app)
      .post(`/api/brawl/trades/${tradeId}/close`)
      .set(authB())
      .send({ rawMovePct: 100 }); // the maximum the leash allows

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/keeper/i);
  });

  it("agent A, the keeper, closes its own trade and the balance is credited", async () => {
    const res = await request(app)
      .post(`/api/brawl/trades/${tradeId}/close`)
      .set(authA())
      .send({ rawMovePct: 40 });

    expect(res.status).toBe(200);
    expect(res.body.trade.status).toBe("closed");
    expect(res.body.entry.tradeId).toBe(tradeId);
  });

  it("refuses a non-finite rawMovePct instead of writing NaN into the balance", async () => {
    // `settle` caps the move to [sl, tp], but NaN passes straight through
    // Math.min/Math.max, so a missing rawMovePct would make `vault.balance`
    // NaN — and now that money is persisted, that NaN would be written to the row.
    const open = await request(app)
      .post("/api/brawl/trades")
      .set(authA())
      .send({ vaultId, size: 0.1, entryPrice: 100 });
    expect(open.status).toBe(200);

    const res = await request(app)
      .post(`/api/brawl/trades/${open.body.trade.id}/close`)
      .set(authA())
      .send({}); // no rawMovePct at all

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rawMovePct/i);
  });

  it("refuses a non-finite size rather than debiting NaN from the balance", async () => {
    const res = await request(app)
      .post("/api/brawl/trades")
      .set(authA())
      .send({ vaultId, entryPrice: 100 }); // no size

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/size/i);
  });

  it("content routes stay public — no token, no capital at stake", async () => {
    const bestiary = await request(app).get("/api/brawl/bestiary");
    expect(bestiary.status).toBe(200);
    expect(bestiary.body.length).toBe(6);

    const monster = await request(app).get("/api/brawl/bestiary/gap");
    expect(monster.status).toBe(200);
    expect(monster.body.name).toBeTruthy();

    const missing = await request(app).get("/api/brawl/bestiary/nope");
    expect(missing.status).toBe(404);

    const elder = await request(app).get("/api/brawl/elder");
    expect(elder.status).toBe(200);
    expect(elder.body.next?.length).toBeGreaterThan(0);

    const node = await request(app).get(`/api/brawl/elder/${elder.body.next[0]}`);
    expect(node.status).toBe(200);
    expect(node.body.text).toBeTruthy();

    const unknown = await request(app).get("/api/brawl/elder/does-not-exist");
    expect(unknown.status).toBe(404);
  });
});
