import { describe, it, expect } from "vitest";
import request from "supertest";
import path from "path";
import os from "os";
import { signedJoinBody, TEST_OWNER, OTHER_OWNER } from "./helpers/join.js";

// Isolate persistence: load the server against a temp data file (pattern from
// gateway.test.ts) so this suite never reads or writes the repo's data/town.json.
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = path.join(os.tmpdir(), `agentbook-register-test-${process.pid}-${Date.now()}.json`);
const { app, world } = await import("../src/server.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

/**
 * Registration page (`#/register`) contract for POST /api/agent/join: the
 * owner/handle payload introduced with the page, its validation ordering, the
 * REQUIRED wallet proof (ownerWallet + signature + signedAt — joinWorld
 * recovers the signer), and the snapshot redaction that keeps the registry
 * (and everything on it) off the wire.
 *
 * The join limiter (6/hour/IP) is module-level state shared by every join in
 * this file, so each test that joins brings its own X-Forwarded-For address —
 * quotas never bleed between tests. Only the rate-limit test reuses one address,
 * deliberately.
 */
const RUN = Date.now().toString().slice(-7);
const OWNER_NAME = `RegOwner${RUN}`;
/** Unique marker: must never appear in GET /api/snapshot (registry is redacted). */
const OWNER_HANDLE = `@owner${RUN}`;
const AGENT_HANDLE = `@reg${RUN}`;
/** The wallet the tests sign with — a throwaway identity, never a real holder. */
const OWNER_WALLET = TEST_OWNER.address;

const IP_OWNER = "198.51.100.11";
const IP_BAD_OWNER = "198.51.100.12";
const IP_PROOF = "198.51.100.13";
const IP_WALLET = "198.51.100.18";
const IP_BAD_WALLET = "198.51.100.19";
const IP_GEN_WALLET = "198.51.100.20";
/** owner-wallet case needs its own address: IP_BAD_WALLET's 6/hour budget is
 *  spent by the invalid-agent-wallet loop above. */
const IP_BAD_OWNER_WALLET = "198.51.100.21";
const IP_HANDLE = "198.51.100.14";
const IP_DUP = "198.51.100.16";
const IP_CTRL = "198.51.100.17";
const IP_RATE = "198.51.100.15";

let seq = 0;
/** Unique agent name per call — well under the 32-char gateway limit. */
const uname = (tag: string) => `Rg${tag}${RUN}${seq++}`;

describe("agent registration (POST /api/agent/join with owner)", () => {
  it("persists owner + handle + owner wallet and echoes them, never the token hash", async () => {
    const res = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_OWNER)
      .send(
        await signedJoinBody({
          name: uname("A"),
          job: "scribe",
          origin: "test:register",
          handle: AGENT_HANDLE,
          owner: { name: OWNER_NAME, handle: OWNER_HANDLE },
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.agentId).toBeTruthy();
    expect(res.body.token).toMatch(/^sabk_[0-9a-f]{48}$/);
    expect(res.body.resident.name).toBeTruthy();
    expect(res.body.resident.job).toBe("scribe");
    // the typed agent account handle lands on the resident
    expect(res.body.resident.handle).toBe(AGENT_HANDLE);
    // owner is echoed so the registration card shows what got persisted
    expect(res.body.owner).toEqual({ name: OWNER_NAME, handle: OWNER_HANDLE });
    expect(res.body.ownerWallet).toBe(OWNER_WALLET);
    expect(res.body).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(res.body)).not.toContain("tokenHash");

    // registry: owner persisted on the first record of this file's world,
    // and only the sha256 hash of the token is stored
    const rec = world.agents![0]!;
    expect(rec.owner).toEqual({ name: OWNER_NAME, handle: OWNER_HANDLE });
    expect(rec.ownerWallet).toBe(OWNER_WALLET);
    expect(rec.residentId).toBe(res.body.resident.id);
    expect(rec.tokenHash).not.toBe(res.body.token);

    const resident = world.herd.find((h) => h.id === res.body.resident.id)!;
    expect(resident.handle).toBe(AGENT_HANDLE);

    // GET /api/agent/me carries the same owner back
    const me = await request(app).get("/api/agent/me").set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.owner).toEqual({ name: OWNER_NAME, handle: OWNER_HANDLE });
  });

  it("an invalid owner answers 400 before the world is touched", async () => {
    const herdBefore = world.herd.length;
    const agentsBefore = world.agents!.length;

    const cases: Array<{ label: string; owner: unknown }> = [
      { label: "owner name empty", owner: { name: "", handle: "@h" } },
      { label: "owner name > 64 chars", owner: { name: "x".repeat(65), handle: "@h" } },
      { label: "owner handle > 64 chars", owner: { name: "Ok", handle: "@h".repeat(40) } },
      { label: "owner name holds a control char", owner: { name: "Bad\u0007Name", handle: "@h" } },
      { label: "owner without handle (zod requires both)", owner: { name: "OnlyName" } },
    ];
    for (const c of cases) {
      const res = await request(app)
        .post("/api/agent/join")
        .set("X-Forwarded-For", IP_BAD_OWNER)
        .send(await signedJoinBody({ name: uname("B"), origin: "test:register", owner: c.owner }));
      expect(res.status, c.label).toBe(400);
      expect(typeof res.body.error, c.label).toBe("string");
    }

    // validation runs before any mutation: neither the herd nor the registry moved
    expect(world.herd.length).toBe(herdBefore);
    expect(world.agents!.length).toBe(agentsBefore);
  });

  it("a join without the wallet proof answers 400 — the web gate is no longer the only lock", async () => {
    const herdBefore = world.herd.length;
    const agentsBefore = world.agents!.length;

    // ownerWallet without signature/signedAt: the schema refuses it
    const unsigned = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_PROOF)
      .send(await signedJoinBody({ name: uname("C1"), origin: "test:register" }, { omitProof: true }));
    expect(unsigned.status).toBe(400);
    expect(unsigned.body.error).toBe("invalid payload");
    expect(JSON.stringify(unsigned.body.details)).toContain("signature");

    // a valid shape with the signature simply missing on the body
    const bare = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_PROOF)
      .send({ name: uname("C2"), origin: "test:register", ownerWallet: OWNER_WALLET });
    expect(bare.status).toBe(400);
    expect(bare.body.error).toBe("invalid payload");

    // a well-formed signature that recovers to a DIFFERENT address
    const wrongSigner = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_PROOF)
      .send(await signedJoinBody({ name: uname("C3"), origin: "test:register" }, { signer: OTHER_OWNER }));
    expect(wrongSigner.status).toBe(400);
    expect(wrongSigner.body.error).toBe("signature does not match the owner wallet");

    // the signature is over a message carrying signedAt — a stale one is expired
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const expired = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_PROOF)
      .send(await signedJoinBody({ name: uname("C4"), origin: "test:register" }, { signedAt: stale }));
    expect(expired.status).toBe(400);
    expect(expired.body.error).toBe("registration signature expired — sign again and resubmit");

    // the claimed ownerWallet is not the one that signed
    const other = "0x33f2cc7e06a7bc654c574d3c8c9e0f1a2b3c4d5e";
    const mismatch = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_PROOF)
      .send(await signedJoinBody({ name: uname("C5"), origin: "test:register" }, { ownerWallet: other }));
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe("signature does not match the owner wallet");

    // malformed signature shape / garbage signedAt die at the schema
    const badShape = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_PROOF)
      .send(await signedJoinBody({ name: uname("C6"), origin: "test:register" }, { signedAt: "not-a-date" }));
    expect(badShape.status).toBe(400);
    expect(badShape.body.error).toBe("invalid payload");

    // every refusal happened before any mutation: nothing was added
    expect(world.herd.length).toBe(herdBefore);
    expect(world.agents!.length).toBe(agentsBefore);
  });

  // operator decisions 2026-11-06: the raw token AND the agent wallet live on
  // the record; a GENERATED wallet also carries its private key server-side.
  it("persists a custom agent wallet with no key, and records the signing owner wallet", async () => {
    // NOT the treasury address: that one legitimately rides the snapshot's
    // config, which would confound the redaction assertion below.
    const AGENT_WALLET = "0x11f0aa5ce4e5fa432a35b2a1b6b7c8d9e0f1a2b3";
    const res = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_WALLET)
      .send(
        await signedJoinBody({
          name: uname("F"),
          origin: "test:register",
          owner: { name: OWNER_NAME, handle: OWNER_HANDLE },
          wallet: AGENT_WALLET,
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^sabk_[0-9a-f]{48}$/);
    expect(res.body.wallet).toBe(AGENT_WALLET); // echoed like owner, so the card shows what got persisted
    expect(res.body.ownerWallet).toBe(OWNER_WALLET);
    expect(res.body).not.toHaveProperty("walletKey"); // custom address → nothing was generated

    const rec = world.agents!.find((a) => a.id === res.body.agentId)!;
    expect(rec.wallet).toBe(AGENT_WALLET);
    expect(rec.ownerWallet).toBe(OWNER_WALLET);
    expect(rec.walletKey).toBeUndefined(); // a custom address carries no key
    // the raw token lives on the record; the hash stays the auth path
    expect(rec.token).toBe(res.body.token);
    expect(rec.tokenHash).not.toBe(res.body.token);
    expect(rec.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // the persisted snapshot still redacts the registry: neither the token nor
    // either wallet may leak through GET /api/snapshot
    const snap = await request(app).get("/api/snapshot");
    expect(snap.status).toBe(200);
    const snapText = JSON.stringify(snap.body);
    expect(snapText).not.toContain(res.body.token);
    expect(snapText).not.toContain(AGENT_WALLET);
    expect(snapText).not.toContain(OWNER_WALLET);
    expect(snapText).not.toContain("tokenHash");
  });

  it("a generated agent wallet is stored with its private key, shown once in the response", async () => {
    const res = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_GEN_WALLET)
      .send(await signedJoinBody({ name: uname("H"), origin: "test:register" }));

    expect(res.status).toBe(200);
    expect(res.body.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(res.body.walletKey).toMatch(/^0x[0-9a-f]{64}$/);

    const rec = world.agents!.find((a) => a.id === res.body.agentId)!;
    expect(rec.wallet).toBe(res.body.wallet);
    expect(rec.walletKey).toBe(res.body.walletKey); // custodial copy on the record
    expect(rec.walletKey).not.toBe(rec.wallet);

    // the key never leaks through the snapshot either
    const snap = await request(app).get("/api/snapshot");
    expect(JSON.stringify(snap.body)).not.toContain(res.body.walletKey!);
  });

  it("an invalid wallet answers 400 before the world is touched", async () => {
    const herdBefore = world.herd.length;
    const agentsBefore = world.agents!.length;

    const cases: Array<{ label: string; wallet: string }> = [
      { label: "no 0x prefix", wallet: "8237a546ab643b444450d168a24842F27Fe75fC6" },
      { label: "too short", wallet: "0x8237" },
      { label: "39 hex chars", wallet: "0x" + "a".repeat(39) },
      { label: "41 hex chars", wallet: "0x" + "a".repeat(41) },
      { label: "non-hex character", wallet: "0x8237a546ab643b444450d168a24842F27Fe75fG6" },
      { label: "base58 solana-looking string", wallet: "Ercx6eTdujr7co8YnVRCnW5OTBAmMfSAqB2E4tQVJkvS" },
    ];
    for (const c of cases) {
      const res = await request(app)
        .post("/api/agent/join")
        .set("X-Forwarded-For", IP_BAD_WALLET)
        .send(await signedJoinBody({ name: uname("G"), origin: "test:register", wallet: c.wallet }));
      expect(res.status, c.label).toBe(400);
      expect(JSON.stringify(res.body), c.label).toContain("wallet must be an EVM address");
    }

    const badOwner = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_BAD_OWNER_WALLET)
      .send(await signedJoinBody({ name: uname("G2"), origin: "test:register" }, { ownerWallet: "not-an-address", omitProof: true }));
    expect(badOwner.status).toBe(400);
    expect(JSON.stringify(badOwner.body)).toContain("owner wallet must be an EVM address");

    // validation runs before any mutation: neither the herd nor the registry moved
    expect(world.herd.length).toBe(herdBefore);
    expect(world.agents!.length).toBe(agentsBefore);
  });

  it("an invalid handle answers 400 (too long, control chars)", async () => {
    const herdBefore = world.herd.length;

    const tooLong = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_HANDLE)
      .send(await signedJoinBody({ name: uname("D1"), origin: "test:register", handle: "h".repeat(33) }));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe("invalid payload"); // zod: handle ≤ 32

    const ctrl = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_HANDLE)
      .send(await signedJoinBody({ name: uname("D2"), origin: "test:register", handle: "ok\u0007h" }));
    expect(ctrl.status).toBe(400);
    expect(ctrl.body.error).toBe("invalid characters"); // joinWorld: CONTROL_CHARS

    expect(world.herd.length).toBe(herdBefore);
  });

  it("a duplicate agent handle answers 400, case-insensitively, before any mutation", async () => {
    const taken = `@dupe${RUN}`;
    const first = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_DUP)
      .send(await signedJoinBody({ name: uname("E1"), origin: "test:register", handle: taken }));
    expect(first.status).toBe(200);

    const herdAfter = world.herd.length;
    const agentsAfter = world.agents!.length;
    const second = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_DUP)
      .send(await signedJoinBody({ name: uname("E2"), origin: "test:register", handle: taken.toUpperCase() }));
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("handle already taken");
    expect(world.herd.length).toBe(herdAfter);
    expect(world.agents!.length).toBe(agentsAfter);
  });

  it("control chars in job/origin and a newline in the owner name answer 400", async () => {
    const herdBefore = world.herd.length;

    // job/origin flow into the herd broadcast — rejected like name/bio
    const jobCtrl = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_CTRL)
      .send(await signedJoinBody({ name: uname("F1"), job: "scri\u001bbe", origin: "test:register" }));
    expect(jobCtrl.status).toBe(400);
    expect(jobCtrl.body.error).toBe("invalid characters");

    const originCtrl = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_CTRL)
      .send(await signedJoinBody({ name: uname("F2"), origin: "test\u001b[31m:register" }));
    expect(originCtrl.status).toBe(400);
    expect(originCtrl.body.error).toBe("invalid characters");

    // handle/owner are single-line fields: \n would break feed rows and the HUD card
    const ownerNewline = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_CTRL)
      .send(
        await signedJoinBody({
          name: uname("F3"),
          origin: "test:register",
          owner: { name: "New\nline", handle: "@nl" },
        }),
      );
    expect(ownerNewline.status).toBe(400);
    expect(ownerNewline.body.error).toBe("invalid characters");

    const handleNewline = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_CTRL)
      .send(await signedJoinBody({ name: uname("F4"), origin: "test:register", handle: "line\nbreak" }));
    expect(handleNewline.status).toBe(400);
    expect(handleNewline.body.error).toBe("invalid characters");

    expect(world.herd.length).toBe(herdBefore);
  });

  it("GET /api/snapshot redacts the agent registry, owner data and tokens", async () => {
    const res = await request(app).get("/api/snapshot");
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeUndefined();
    expect(Array.isArray(res.body.herd)).toBe(true); // still a usable snapshot

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("sabk_");
    expect(raw).not.toContain(OWNER_HANDLE); // unique owner handle: registry-only value
    expect(raw).not.toContain(OWNER_NAME);
  });

  it("POST /api/agent/join answers 429 on the 7th join from one IP", async () => {
    // distinct client, seen via x-forwarded-for: 6 joins burn the hourly quota
    for (let i = 0; i < 6; i++) {
      const r = await request(app)
        .post("/api/agent/join")
        .set("X-Forwarded-For", IP_RATE)
        .send(await signedJoinBody({ name: uname(`R${i}`), origin: "test:register" }));
      expect(r.status, `join #${i + 1}`).toBe(200);
    }
    const herdAfterQuota = world.herd.length;

    const blocked = await request(app)
      .post("/api/agent/join")
      .set("X-Forwarded-For", IP_RATE)
      .send(await signedJoinBody({ name: uname("R6"), origin: "test:register" }));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/rate limited/);
    // the limiter runs before validation/mutation: nothing was added
    expect(world.herd.length).toBe(herdAfterQuota);
  });
});
