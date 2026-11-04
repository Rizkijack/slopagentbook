import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { app, world } from "../src/server.js";

/**
 * POST /api/quests/reset — the owner-only progress reset.
 *
 * It is the only route in this app that destroys player progress on purpose, so
 * the credential is the subject of most of this file: unset `OWNER_KEY` means
 * the route does not exist (503, never an unauthenticated reset), a wrong key
 * is 403, and only the right key replaces the board. The generation stamp is
 * checked too, because that field is what stops a stale instance from undoing
 * the reset on its next save (pinned in pgstore-cache.test.ts).
 */

const KEY = "test-owner-key-7f3a";
const resetAuth = (key = KEY) => request(app).post("/api/quests/reset").set("x-owner-key", key);

let previousKey: string | undefined;

beforeEach(() => {
  previousKey = process.env.OWNER_KEY;
  process.env.OWNER_KEY = KEY;
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.OWNER_KEY;
  else process.env.OWNER_KEY = previousKey;
});

describe("POST /api/quests/reset authorization", () => {
  it("refuses to exist without OWNER_KEY — never an unauthenticated reset", async () => {
    delete process.env.OWNER_KEY;
    const before = world.quests;
    const res = await resetAuth();
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/disabled/i);
    expect(world.quests).toBe(before); // untouched, by reference
  });

  it("rejects a missing or wrong key with 403 and leaves the board alone", async () => {
    const before = world.quests;
    expect((await request(app).post("/api/quests/reset")).status).toBe(403);
    expect((await resetAuth("wrong-key")).status).toBe(403);
    expect(world.quests).toBe(before);
  });
});

describe("POST /api/quests/reset behavior", () => {
  it("replaces the whole board with a fresh generation and persists it", async () => {
    // give the board something to lose: a claimed quest with progress
    world.quests = [
      { id: "q-reset-old", status: "claimed", progress: 99, claimedBy: "someone" },
    ] as unknown as typeof world.quests;

    const res = await resetAuth();

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.before).toBe(1);
    expect(res.body.after).toBe(8); // createInitialQuests' fresh board
    expect(res.body.quests.map((q: { id: string }) => q.id)).not.toContain("q-reset-old");
    // every fresh quest starts at the bottom of its lifecycle
    for (const q of res.body.quests as { status: string; progress?: number }[]) {
      expect(q.status).toBe("available");
      expect(q.progress ?? 0).toBe(0);
    }
    // the generation is stamped on the live world and travels to the response
    expect(world.questEpoch).toBe(res.body.epoch);
    expect(typeof res.body.epoch).toBe("number");

    // and it is on disk, not merely in memory: a reset that only lived in the
    // instance would silently undo itself on the next boot
    const saved = JSON.parse(readFileSync(process.env.DATA_PATH!, "utf8")) as {
      questEpoch?: number;
      quests: { id: string }[];
    };
    expect(saved.questEpoch).toBe(res.body.epoch);
    expect(saved.quests.map((q) => q.id)).toEqual(
      (res.body.quests as { id: string }[]).map((q) => q.id),
    );
  });

  it("a second reset rolls the generation forward and issues another board", async () => {
    const first = await resetAuth();
    expect(first.status).toBe(200);
    const firstIds = (first.body.quests as { id: string }[]).map((q) => q.id);

    const second = await resetAuth();
    expect(second.status).toBe(200);
    expect(second.body.epoch).toBeGreaterThan(first.body.epoch);
    expect(second.body.quests.map((q: { id: string }) => q.id)).not.toEqual(firstIds);
  });
});
