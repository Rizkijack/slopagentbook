import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import path from "path";
import os from "os";

// Isolate persistence (same harness as gateway.test.ts): never touch data/town.json.
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = path.join(os.tmpdir(), `agentbook-agent-quests-test-${process.pid}-${Date.now()}.json`);
const { app, world, DATA_PATH } = await import("../src/server.js");
const { createGatewayRouter } = await import("../src/gateway.js");
const { LOCATION_BY_ID } = await import("../src/locations.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

// Second router over the SAME world, with a broadcast spy — lets tests assert
// the SSE payload the new endpoints emit.
const broadcasts: Array<Record<string, unknown>> = [];
const spyApp = express();
spyApp.use(express.json({ limit: "64kb" }));
spyApp.use(
  createGatewayRouter({
    world,
    broadcast: (m) => {
      broadcasts.push(m as Record<string, unknown>);
    },
    DATA_PATH,
  }),
);

const anyPlace = LOCATION_BY_ID.keys().next().value as string; // LOCATION_BY_ID is a Map
const joinName = "QAgent" + Date.now().toString().slice(-6);
let token = "";
let residentId = "";

async function join(): Promise<void> {
  const res = await request(app)
    .post("/api/agent/join")
    .send({ name: joinName, bio: "here to take a job", job: "hand", origin: "vitest" });
  expect(res.status).toBe(200);
  token = res.body.token;
  residentId = res.body.resident.id;
}

/** a fresh available quest in the shared world (seeded by createInitialWorld) */
function availableQuestId(): string {
  const q = world.quests.find((x) => x.status === "available" && !x.claimedBy);
  if (!q) throw new Error("no available quest in the seeded world");
  return q.id;
}

describe("agent quest join", () => {
  it("401 without a token", async () => {
    const res = await request(spyApp).post(`/api/agent/quests/${availableQuestId()}/join`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("joins an available quest: claimedBy is the token's resident, SSE broadcasts it", async () => {
    await join();
    const questId = availableQuestId();
    const res = await request(spyApp)
      .post(`/api/agent/quests/${questId}/join`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.quest.id).toBe(questId);
    expect(res.body.quest.status).toBe("active");
    expect(res.body.quest.claimedBy).toBe(residentId);

    const quest = world.quests.find((q) => q.id === questId)!;
    expect(quest.claimedBy).toBe(residentId);

    const evt = broadcasts.find((b) => b.type === "quest" && (b.quest as { id: string }).id === questId);
    expect(evt).toBeTruthy();
  });

  it("400 when the same quest is joined twice (already claimed)", async () => {
    const questId = availableQuestId(); // a different one — the previous test took its own
    await request(spyApp).post(`/api/agent/quests/${questId}/join`).set("Authorization", `Bearer ${token}`);
    const second = await request(spyApp)
      .post(`/api/agent/quests/${questId}/join`)
      .set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(400);
    // claimQuestFor checks status before claimant, and a successful join already
    // flipped status to "active" — so the refusal reads "not available" rather
    // than "already claimed". Either way the second join changes nothing.
    expect(second.body.error).toBe("quest not available");
  });

  it("400 for an unknown quest id", async () => {
    const res = await request(spyApp)
      .post("/api/agent/quests/qnope999/join")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("quest not found");
  });
});

describe("agent quest create", () => {
  it("401 without a token", async () => {
    const res = await request(spyApp)
      .post("/api/agent/quests")
      .send({ title: "A job worth posting", description: "do the thing", type: "talk" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("creates a place-gated quest and broadcasts it", async () => {
    // token/residentId already established by the join describe above —
    // joining again would register a second resident under the same name
    const res = await request(spyApp)
      .post("/api/agent/quests")
      .set("Authorization", `Bearer ${token}`)
      .send({
        title: "Sweep the square",
        description: "The square needs sweeping before market day.",
        type: "visit",
        targetPlace: anyPlace,
        required: 2,
        spirits: 0.3,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const quest = res.body.quest;
    expect(quest.status).toBe("available");
    expect(quest.giver).toBe(residentId);
    expect(quest.giverName).toBeTruthy();
    expect(quest.reward.spirits).toBe(0.3);
    expect(quest.required).toBe(2);

    expect(world.quests.some((q) => q.id === quest.id)).toBe(true);
    const evt = broadcasts.find((b) => b.type === "quest" && (b.quest as { id: string }).id === quest.id);
    expect(evt).toBeTruthy();
  });

  it("rejects a place-gated type with no place (would match anywhere)", async () => {
    const res = await request(spyApp)
      .post("/api/agent/quests")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Vague errand", description: "no building named here", type: "visit" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("targetPlace");
  });

  it("rejects an unknown place", async () => {
    const res = await request(spyApp)
      .post("/api/agent/quests")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Nowhere errand", description: "a place that does not exist", type: "visit", targetPlace: "nopeville" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("unknown place");
  });

  it("caps reward spirits (anti-inflation: the leaderboard sums reward.spirits)", async () => {
    const res = await request(spyApp)
      .post("/api/agent/quests")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Generous job", description: "too rich for the board", type: "talk", spirits: 5 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details)).toContain("spirits");
  });

  it("drops the place on an action-axis quest (those advance by act, not location)", async () => {
    const res = await request(spyApp)
      .post("/api/agent/quests")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Tie a leash", description: "set a leash rule on a vault", type: "configure", targetPlace: anyPlace });
    expect(res.status).toBe(200);
    expect(res.body.quest.targetPlace).toBeUndefined();
    expect(res.body.quest.targetPlaces).toBeUndefined();
  });

  it("caps open quests per giver at 3 (the board is shared, trimmed to 12)", async () => {
    // this token already has 2 open (the broadcast one + the action-axis one),
    // so the third is accepted and the fourth is refused
    const third = await request(spyApp)
      .post("/api/agent/quests")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Third job", description: "the last one allowed", type: "talk" });
    expect(third.status).toBe(200);

    const fourth = await request(spyApp)
      .post("/api/agent/quests")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Fourth job", description: "one job too many", type: "talk" });
    expect(fourth.status).toBe(400);
    expect(fourth.body.error).toContain("open quests");
  });
});
