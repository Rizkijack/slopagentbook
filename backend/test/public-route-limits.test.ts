import { describe, it, expect } from "vitest";
import request from "supertest";
import http from "node:http";
import path from "path";
import os from "os";

/**
 * Public-surface limits, found by the whole-project audit (2026-10-22).
 *
 * Three holes, all reachable without a credential:
 *
 *  1. `POST /api/quests/refresh` mutated the town (generated a quest, wrote
 *     the row) and was neither authenticated nor metered.
 *  2. `POST /api/quests/:id/claim` is unauthenticated BY DESIGN (anyone may
 *     claim a completed quest) but it also writes the row, so it needed a
 *     ceiling like every other mutating route.
 *  3. `GET /api/stream` accepted an unbounded number of concurrent SSE
 *     clients, each holding a socket and a 25 s ping interval.
 *
 * Plus one money hole: `fundVault` rejects NaN (it is not `> 0`) but Infinity
 * IS `> 0`, so an amount of Infinity would make a balance that can never be
 * drawn down again - and that balance now persists through the merge.
 *
 * Every limit here is per-instance memory (the shared caveat in agents.ts), so
 * behind N instances the effective ceiling is N x the number below. That is a
 * property of the deployment, not of these routes.
 */

process.env.NODE_ENV = "test";
const prevDataPath = process.env.DATA_PATH;
process.env.DATA_PATH = path.join(os.tmpdir(), `public-limits-test-${process.pid}-${Date.now()}.json`);
const { app, world } = await import("../src/server.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

const ip = (n: number) => `203.0.113.${n}`;

describe("public mutating routes are metered", () => {
  it("POST /api/quests/refresh answers 429 after 10 requests/minute/IP", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post("/api/quests/refresh").set("X-Forwarded-For", ip(10));
      expect(r.status, `call ${i + 1} must be served`).toBe(200);
    }
    const blocked = await request(app).post("/api/quests/refresh").set("X-Forwarded-For", ip(10));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/rate limited/i);
  });

  it("POST /api/quests/:id/claim answers 429 after 30 requests/minute/IP", async () => {
    // The quest id is bogus on purpose: the limiter runs BEFORE the claim, so
    // this measures the ceiling, not the quest logic.
    for (let i = 0; i < 30; i++) {
      const r = await request(app)
        .post("/api/quests/does-not-exist/claim")
        .set("X-Forwarded-For", ip(11));
      expect(r.status, `call ${i + 1} must reach the handler`).toBe(400);
    }
    const blocked = await request(app)
      .post("/api/quests/does-not-exist/claim")
      .set("X-Forwarded-For", ip(11));
    expect(blocked.status).toBe(429);
  });

  it("a different IP is not affected by another IP's quota", async () => {
    const r = await request(app).post("/api/quests/refresh").set("X-Forwarded-For", ip(12));
    expect(r.status).toBe(200);
  });
});

describe("SSE client ceiling", () => {
  it("GET /api/stream refuses the connection past the ceiling", async () => {
    const prev = process.env.MAX_SSE_CLIENTS;
    process.env.MAX_SSE_CLIENTS = "1";
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    const open = () =>
      new Promise<number>((resolve, reject) => {
        const req = http.get({ port, path: "/api/stream" }, (res) => {
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
      });

    try {
      const first = await open();
      expect(first).toBe(200);
      const second = await open();
      expect(second).toBe(503);
    } finally {
      server.close();
      if (prev === undefined) delete process.env.MAX_SSE_CLIENTS;
      else process.env.MAX_SSE_CLIENTS = prev;
    }
  });
});

describe("fund amount must be finite", () => {
  it("refuses an Infinity amount instead of poisoning the balance", async () => {
    const joined = await request(app)
      .post("/api/agent/join")
      .send({ name: "FundProbe" + Date.now().toString().slice(-6), origin: "vitest" });
    expect(joined.status).toBe(200);
    const auth = { Authorization: `Bearer ${joined.body.token}` };

    const created = await request(app).post("/api/brawl/vaults").set(auth).send({});
    expect(created.status).toBe(200);
    const vaultId = created.body.id as string;

    const infinity = await request(app)
      .post(`/api/brawl/vaults/${vaultId}/fund`)
      .set(auth)
      .send({ amount: "Infinity" });
    expect(infinity.status).toBe(400);
    expect(String(infinity.body.error)).toMatch(/finite/i);

    const missing = await request(app).post(`/api/brawl/vaults/${vaultId}/fund`).set(auth).send({});
    expect(missing.status).toBe(400);

    const vault = (world.vaults ?? []).find((v) => v.id === vaultId);
    expect(vault, "the vault must still exist").toBeDefined();
    expect(Number.isFinite(vault!.balance), `balance must be finite, got ${vault!.balance}`).toBe(true);
    expect(vault!.balance).toBe(0);

    // the honest path still works
    const ok = await request(app)
      .post(`/api/brawl/vaults/${vaultId}/fund`)
      .set(auth)
      .send({ amount: 2.5 });
    expect(ok.status).toBe(200);
    expect(ok.body.balance).toBe(2.5);
  });
});
