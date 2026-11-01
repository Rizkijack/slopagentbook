import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_CACHE_CONTROL,
} from "@x402/core/http";
import { SOLANA_MAINNET_CAIP2, USDC_MAINNET_ADDRESS } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { SlopAgentbookClient } from "../src/client.js";
import {
  createMcpHttpHandler,
  X402_NOT_CONFIGURED,
  X402_PAYMENT_REQUIRED,
  type HttpReqLike,
  type HttpResLike,
} from "../src/http.js";
import { TOOL_NAMES } from "../src/tools.js";
import {
  challengeFor,
  needsPayment,
  priceOf,
  verifyPayment,
  x402Facts,
  X402_HEADERS,
  X402_NETWORK,
  X402_PRICES,
  X402_SVM_CAIP2,
} from "../src/x402.js";

// ---------------------------------------------------------------------------
// transport stubs (same shape as http.test.ts, so the assertions read the same)
// ---------------------------------------------------------------------------

function fakeRes() {
  let statusCode = 0;
  let headers: Record<string, string> = {};
  let body: unknown = undefined;
  const res = {
    get statusCode() {
      return statusCode;
    },
    status(v: number) {
      statusCode = v;
      return res;
    },
    set(field: string, value: string) {
      headers[field] = value;
      return res;
    },
    get headers() {
      return headers;
    },
    json(b: unknown) {
      body = b;
      return res;
    },
    end() {
      return res;
    },
    get body() {
      return body;
    },
  };
  return res as unknown as HttpResLike & { statusCode: number; headers: Record<string, string>; body: unknown };
}

function posted(payload: unknown, headers?: Record<string, string>): HttpReqLike {
  return { method: "POST", body: JSON.stringify(payload), headers };
}

function toolCall(id: number, name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

interface RecordedCall {
  url: string;
  body: string | undefined;
}

/**
 * Gateway stub that leaves every other URL (the facilitator) on the REAL fetch:
 * replacing fetch wholesale would turn the "facilitator called over HTTP" proof
 * into a proof about this stub.
 */
function stubGateway(router: (url: string) => unknown): RecordedCall[] {
  const realFetch = globalThis.fetch.bind(globalThis);
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("http://gw.test")) return realFetch(input as never, init);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    return new Response(JSON.stringify(router(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

const GATEWAY_ROUTES: Record<string, unknown> = {
  "/api/status": { brain: "sim", herd: 3, feed: 3, llm: null },
  "/api/quests": [],
  "/api/snapshot": { now: 1, herd: [], feed: [], events: [], quests: [], factions: [] },
};

function gatewayOk(url: string): unknown {
  const path = new URL(url).pathname;
  if (path in GATEWAY_ROUTES) return GATEWAY_ROUTES[path];
  throw new Error(`unexpected gateway url ${url}`);
}

// ---------------------------------------------------------------------------
// a real HTTP facilitator on the loopback — the SDK talks to it over the wire
// ---------------------------------------------------------------------------

interface MockFacilitator {
  url: string;
  requests: { path?: string; method?: string; body?: Record<string, unknown> }[];
  setVerifyResult(isValid: boolean): void;
  setSettleResult(success: boolean): void;
  close(): Promise<void>;
}

const servers: Server[] = [];

async function startFacilitator(): Promise<MockFacilitator> {
  const requests: MockFacilitator["requests"] = [];
  let isValid = true;
  let settleSuccess = false;
  // The scheme name comes from the SDK instance, never typed in here.
  const scheme = new ExactSvmScheme().scheme;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ path: req.url, method: req.method, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/supported") {
        // The SDK matches its supported kinds against the network id EXACTLY
        // (getSupportedKind), so this mock advertises the id the server asks for.
        res.end(
          JSON.stringify({
            kinds: [
              {
                x402Version: 2,
                scheme,
                // the CAIP-2 (≤32) form — the id facilitators advertise /supported by
                network: X402_SVM_CAIP2,
                extra: { feePayer: "11111111111111111111111111111111" },
              },
            ],
            extensions: [],
            signers: {},
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/verify") {
        res.end(JSON.stringify({ isValid, payer: "11111111111111111111111111111111" }));
        return;
      }
      if (req.method === "POST" && req.url === "/settle") {
        // default off: a settle receipt must only ever come from a settle the
        // test explicitly flipped on — never from luck
        res.end(
          JSON.stringify(
            settleSuccess
              ? { success: true, transaction: "mock-settle-tx", network: X402_SVM_CAIP2, payer: "11111111111111111111111111111111" }
              : { success: false, errorReason: "not_wired", transaction: "", network: X402_SVM_CAIP2 },
          ),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "unknown facilitator route" }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setVerifyResult(v: boolean) {
      isValid = v;
    },
    setSettleResult(v: boolean) {
      settleSuccess = v;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/**
 * What a real x402 client echoes back: the `accepts` row from the challenge,
 * wrapped as a PaymentPayload. The transaction bytes are placeholders — signature
 * validation belongs to a facilitator, which is exactly where this server sends
 * the payload instead of checking it itself.
 */
async function paymentHeaderFor(tool: string): Promise<string> {
  const challenge = await challengeFor(tool);
  const paymentRequired = decodePaymentRequiredHeader(challenge.headers[X402_HEADERS.required]);
  return encodePaymentSignatureHeader({
    x402Version: paymentRequired.x402Version,
    accepted: paymentRequired.accepts[0],
    payload: { kind: "exact", transaction: "mock-transaction", signature: "mock-signature" },
  });
}

// ---------------------------------------------------------------------------

const originalPrices = { ...X402_PRICES };
let facilitators: MockFacilitator[] = [];

function cleanX402Env(): void {
  delete process.env.X402_FACILITATOR_URL;
  delete process.env.X402_PAY_TO;
}

function configureX402(url: string, payTo = "PayTo111111111111111111111111111111111111"): void {
  process.env.X402_FACILITATOR_URL = url;
  process.env.X402_PAY_TO = payTo;
}

async function facilitator(): Promise<MockFacilitator> {
  const mock = await startFacilitator();
  facilitators.push(mock);
  configureX402(mock.url);
  return mock;
}

beforeEach(() => {
  cleanX402Env();
  Object.assign(X402_PRICES, originalPrices);
});

afterEach(async () => {
  Object.assign(X402_PRICES, originalPrices);
  cleanX402Env();
  vi.unstubAllGlobals();
  await Promise.all(facilitators.map((f) => f.close()));
  facilitators = [];
});

describe("x402 facts and network identity", () => {
  it("exactly the two quest-writing tools are priced; everything else is free", () => {
    const facts = x402Facts();
    expect(facts.priced).toEqual(["quest_create", "quest_join"]);
    // $0.001 per call — the decision of 12 Okt 2026 (one-tenth of a cent)
    expect(priceOf("quest_create")).toBe(0.001);
    expect(priceOf("quest_join")).toBe(0.001);
    for (const tool of TOOL_NAMES.filter((t) => t !== "quest_create" && t !== "quest_join")) {
      expect(priceOf(tool)).toBe(0);
      expect(needsPayment(tool)).toBe(false);
    }
    expect(facts.free).toBe(TOOL_NAMES.length - 2);
  });

  it("an unconfigured rail refuses the priced tools; still no free ride", () => {
    const facts = x402Facts();
    expect(facts).toEqual({
      configured: false,
      network: X402_NETWORK,
      payTo: null,
      facilitator: null,
      priced: ["quest_create", "quest_join"],
      // priced while unconfigured = a broken deployment, listed honestly
      unconfigured: ["quest_create", "quest_join"],
      free: TOOL_NAMES.length - 2,
      total: TOOL_NAMES.length,
    });
  });

  it("X402_NETWORK carries the payment rail's own Solana identity, and its CAIP-2 form is the SDK's own", () => {
    // The x402 rail keys on Solana — the SVM scheme it speaks — independently of
    // the town's settlement chain (Elysium, an EVM chain with no USDC contract
    // this rail can name). See the comment above X402_SOLANA_GENESIS in x402.ts.
    expect(X402_NETWORK).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
    // The 32-char CAIP-2 used for the asset lookup must be @x402/svm's constant,
    // not a second table: same cluster, same id, one owner.
    expect(X402_SVM_CAIP2).toBe(SOLANA_MAINNET_CAIP2);
  });
});

describe("free tools keep the behavior they had before this layer existed", () => {
  it("a free tools/call answers 200 with no payment headers and reaches the gateway", async () => {
    const calls = stubGateway(gatewayOk);
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));

    const res = fakeRes();
    await handler(posted(toolCall(1, "world_status")), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers[X402_HEADERS.required]).toBeUndefined();
    expect(res.headers["Cache-Control"]).toBeUndefined();
    const body = res.body as { result?: { content: { text: string }[] }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(JSON.parse(body.result!.content[0]!.text).herd).toBe(3);
    expect(calls).toHaveLength(2); // status + quests, exactly as before
  });
});

describe("a price without a facilitator is a misconfiguration, not a free ride", () => {
  it("facts list the priced tools and the transport refuses them explicitly, out loud", async () => {
    const calls = stubGateway(gatewayOk); // must stay untouched
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));

    const facts = x402Facts();
    expect(facts.configured).toBe(false);
    // the two quest-writing tools are priced by the contract, no test-needled price
    expect(facts.priced).toEqual(["quest_create", "quest_join"]);
    expect(facts.unconfigured).toEqual(["quest_create", "quest_join"]);
    expect(facts.free).toBe(TOOL_NAMES.length - 2);

    const res = fakeRes();
    await handler(posted(toolCall(7, "quest_create")), res);

    const body = res.body as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    expect(body.result).toBeUndefined(); // never served
    expect(body.error?.code).toBe(X402_NOT_CONFIGURED);
    expect(body.error?.message).toMatch(/not configured/);
    expect(body.error?.message).toMatch(/not served for free/);
    expect(body.error?.data).toMatchObject({ tool: "quest_create", configured: false });
    expect(res.headers[X402_HEADERS.required]).toBeUndefined();
    expect(calls).toHaveLength(0); // no fetch at all: no network, no free dispatch
  });

  it("challengeFor refuses to build a challenge while unconfigured", async () => {
    await expect(challengeFor("quest_create")).rejects.toThrow(/not configured/);
    await expect(verifyPayment("quest_create", undefined)).resolves.toBe(false);
  });

  it("a free tool is never charged for a challenge", async () => {
    await expect(challengeFor("world_status")).rejects.toThrow(/priced at 0 USD/);
    expect(needsPayment("world_status")).toBe(false);
  });
});

describe("402 challenge built by the real x402 SDK", () => {
  it("challengeFor encodes a PaymentRequired that decodes into real requirements", async () => {
    const mock = await facilitator();
    X402_PRICES["world_status"] = 0.01;

    const { headers, body } = await challengeFor("world_status");

    const encoded = headers[X402_HEADERS.required];
    expect(typeof encoded).toBe("string");
    expect(headers["Cache-Control"]).toBe(PAYMENT_REQUIRED_CACHE_CONTROL); // "no-store"

    const decoded = decodePaymentRequiredHeader(encoded);
    expect(decoded).toEqual(body);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.resource).toMatchObject({ url: "mcp:tools/call/world_status" });
    expect(decoded.accepts).toHaveLength(1);
    expect(X402_SVM_CAIP2).toBe(SOLANA_MAINNET_CAIP2); // the SDK's own constant, not a second table
    expect(X402_SVM_CAIP2).not.toBe(X402_NETWORK); // two ids, one cluster — see the table in x402.ts
    expect(decoded.accepts[0]).toMatchObject({
      scheme: new ExactSvmScheme().scheme,
      network: X402_SVM_CAIP2, // the wire form everyone keys on
      payTo: process.env.X402_PAY_TO,
      asset: USDC_MAINNET_ADDRESS, // from @x402/svm's own default-asset table
      amount: "10000", // $0.01 in 6-decimal USDC
      maxTimeoutSeconds: 300,
    });

    // The handshake with the facilitator is a real GET /supported over HTTP.
    expect(mock.requests.filter((r) => r.path === "/supported" && r.method === "GET")).toHaveLength(1);
  });

  it("the transport answers HTTP 402 with PAYMENT-REQUIRED instead of dispatching", async () => {
    await facilitator();
    X402_PRICES["world_status"] = 0.01;
    const calls = stubGateway(gatewayOk);
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));

    const res = fakeRes();
    await handler(posted(toolCall(3, "world_status")), res);

    expect(res.statusCode).toBe(402);
    const challenge = decodePaymentRequiredHeader(res.headers[X402_HEADERS.required]);
    expect(challenge.accepts[0]).toMatchObject({ network: X402_SVM_CAIP2, amount: "10000" });
    const body = res.body as { id: number; error: { code: number; message: string; data?: unknown } };
    expect(body.id).toBe(3);
    expect(body.error.code).toBe(X402_PAYMENT_REQUIRED);
    expect(body.error.message).toMatch(/PAYMENT-REQUIRED/);
    expect(body.error.data).toMatchObject({ tool: "world_status", price: 0.01, network: X402_NETWORK });
    expect(calls).toHaveLength(0); // the tool did not run unpaid
  });
});

describe("verification goes through a real facilitator, never through this module", () => {
  it("verifyPayment posts to the facilitator's /verify and honors its verdict", async () => {
    const mock = await facilitator();
    X402_PRICES["world_status"] = 0.01;
    const header = await paymentHeaderFor("world_status");

    mock.setVerifyResult(true);
    await expect(verifyPayment("world_status", header)).resolves.toBe(true);

    const verify = mock.requests.find((r) => r.path === "/verify");
    expect(verify).toBeDefined();
    expect(verify!.method).toBe("POST");
    // The payload this server received is the one this server forwarded.
    expect(verify!.body).toMatchObject({
      x402Version: 2,
      paymentPayload: { payload: { transaction: "mock-transaction" } },
      paymentRequirements: { network: X402_SVM_CAIP2, amount: "10000" },
    });

    mock.setVerifyResult(false);
    await expect(verifyPayment("world_status", header)).resolves.toBe(false);
  });

  it("no header, junk header, or a free tool resolve the way the transport needs", async () => {
    await facilitator();
    X402_PRICES["world_status"] = 0.01;

    await expect(verifyPayment("world_status", undefined)).resolves.toBe(false);
    await expect(verifyPayment("world_status", "not a payment")).resolves.toBe(false);
    await expect(verifyPayment("world_status", btoa(JSON.stringify({ nonsense: true })))).resolves.toBe(false);
    // nothing owed → nothing to verify, and it must not consult a facilitator
    await expect(verifyPayment("chat_history", undefined)).resolves.toBe(true);
  });

  it("a settle that fails refuses the tool (no charge → no work), and the answer names the settle", async () => {
    const mock = await facilitator();
    X402_PRICES["world_status"] = 0.01;
    const calls = stubGateway(gatewayOk);
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));
    const header = await paymentHeaderFor("world_status");

    const settled = fakeRes();
    await handler(posted(toolCall(4, "world_status"), { "PAYMENT-SIGNATURE": header }), settled);
    expect(settled.statusCode).toBe(200); // an answered refusal is still a normal HTTP answer
    const settledBody = settled.body as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    // the mock settle answers success:false (its /settle is off by default), so
    // the transport refuses the dispatch — no gateway hit, no tool result.
    expect(settledBody.result).toBeUndefined();
    expect(settledBody.error?.code).toBe(-32003); // X402_SETTLE_FAILED
    expect(settledBody.error?.message).toMatch(/settlement failed/);
    expect(settledBody.error?.data).toMatchObject({ tool: "world_status" });
    expect(calls).toHaveLength(0);
    const paid = settled;
    const paidBody = settledBody;
    const settleBody = paidBody.error as { code: number; message: string } | undefined;
    expect(settleBody?.code).toBe(-32003); // X402_SETTLE_FAILED
    expect(settleBody?.message).toMatch(/settlement failed/);

    // a successful settle must leave a receipt: flip the mock to success
    mock.setSettleResult(true);
    const header2 = await paymentHeaderFor("world_status");
    const paid2 = fakeRes();
    await handler(posted(toolCall(9, "world_status"), { "PAYMENT-SIGNATURE": header2 }), paid2);
    const ok2 = paid2.body as { result?: { content: { text: string }[]; _meta?: Record<string, unknown> }; error?: unknown };
    expect(ok2.error).toBeUndefined();
    expect(JSON.parse(ok2.result!.content[0]!.text).herd).toBe(3); // the tool's real content
    expect((ok2.result!._meta as Record<string, unknown>)["payment-response"]).toMatchObject({
      success: true,
      transaction: "mock-settle-tx",
    });
    expect(calls).toHaveLength(2); // now the tool ran

    // a priced call with no verifiable payment is challenged again, unchanged
    const bogus = fakeRes();
    await handler(posted(toolCall(5, "world_status"), { "PAYMENT-SIGNATURE": "not a payment" }), bogus);
    expect(bogus.statusCode).toBe(402);
    expect(bogus.headers[X402_HEADERS.required]).toBeDefined();
    expect(calls).toHaveLength(2); // still only the paid run
  });
});
