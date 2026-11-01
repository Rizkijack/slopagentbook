import type { x402ResourceServer } from "@x402/core/server";
import type { AssetAmount, Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { ExactSvmScheme } from "@x402/svm/exact/server";
import { SERVER_INFO } from "./protocol.js";
import { TOOL_NAMES } from "./tools.js";

/**
 * x402 (HTTP 402) payment layer for the MCP transport — the header rail.
 *
 * `x402Gate` (http.ts) runs BEFORE the dispatcher: a tool priced above 0 needs a
 * payment the facilitator confirms; without one it answers 402 + `PAYMENT-REQUIRED`,
 * or, while `X402_FACILITATOR_URL` / `X402_PAY_TO` are unset, a `-32001` error
 * naming the misconfiguration instead of a free ride. Verification (`verifyPayment`)
 * and settlement (`settlePayment`, the receipt that becomes `PAYMENT-RESPONSE`)
 * are both delegated to `@x402/core`; this module never inspects a signature itself.
 *
 * Copies of the obsolete-era facts below, kept because they were the reason two
 * layers exist at all:
 *
 * - Nothing here runs at boot: `@x402/svm` drags in `@solana/kit`, so the SDK is
 *   imported dynamically and only after configuration exists. A town that never
 *   configures x402 loads no chain code and makes no network call.
 * - Once, every tool was priced 0 and this header layer was the only rail — but
 *   the (removed) in-band layer carried a `paidHandler` on the paid tools whose
 *   charge shape only worked over BOTH transports. TODAY'S RAIL IS HEADER-ONLY:
 *   the in-band layer is gone (no `paidHandler` anywhere), so one invariant is
 *   simple again — the priced pair (`quest_create`, `quest_join`, $0.001) is
 *   charged here, on HTTP, and answers the -32001 refusal everywhere else.
 */

/**
 * The x402 payment rail keys on Solana mainnet — the SVM scheme this SDK
 * carries, and the USDC mint its own default-asset table resolves. The town's
 * SETTLEMENT_CHAIN has since moved to Elysium Mainnet (an EVM chain, chain id
 * 99901), and this rail cannot follow it yet: no EVM scheme is wired here, no
 * USDC contract on Elysium exists in any default-asset table, and typing one in
 * would fabricate an address. So the payment rail carries its own chain
 * identity — the two rails are separate layers, and each names its own chain.
 * The day an EVM facilitator lands, this constant retires with the rest of the
 * SVM wiring.
 */
const X402_SOLANA_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/**
 * TWO SOLANA IDS FOR ONE CLUSTER, both derived from X402_SOLANA_GENESIS, one
 * owner (the comment above):
 *
 * - X402_NETWORK — the FULL id `solana:<genesis hash>` (49+ chars). This is the
 *   id this rail NAMES ITSELF by in every PaymentRequired, every error, and in
 *   the /api surface: unambiguous, verifiable on-chain, and it reads identical
 *   to the genesis hash the live probe reports.
 * - X402_SVM_CAIP2 — the id @x402/svm/facilitators REGISTRABLE form: CAIP-2 caps
 *   the chain id at 32 chars, so the wire form everyone settles on is
 *   `solana:` + genesis-hash[0..32] (== SOLANA_MAINNET_CAIP2, asserted by test).
 *   The facilitator's /supported advertises the truncated form; registering the
 *   full id made matches fail live (“does not support exact…”), so registration
 *   and asset lookup use the truncated id and the requirements carry it on the
 *   wire with the SAME amount of chain identity.
 */
const X402_NETWORK_ID: Network = `solana:${X402_SOLANA_GENESIS}`; // the rail's own name (full genesis)
export const X402_NETWORK: string = X402_NETWORK_ID;

/** The CAIP-2 (≤32-char chain id) form the SDK + facilitators key on. */
const SVM_MAINNET_CAIP2: Network = `solana:${X402_SOLANA_GENESIS.slice(0, 32)}`;
export const X402_SVM_CAIP2: string = SVM_MAINNET_CAIP2;

/**
 * Header names, read from `@x402/core` (x402HTTPResourceServer / x402HTTPClient),
 * not guessed. `PAYMENT-RESPONSE` carries the SettleResponse — the receipt a
 * facilitator signs after the money moved — and is written by `settlePayment`
 * below, which is wired: verify through the facilitator, run the handler, settle
 * through the same facilitator, attach the receipt.
 */
export const X402_HEADERS = {
  /** 402 response → base64 PaymentRequired. */
  required: "PAYMENT-REQUIRED",
  /** Paid request → base64 PaymentPayload (v2; v1 clients send `X-PAYMENT`). */
  signature: "PAYMENT-SIGNATURE",
  /** Successful paid result → base64 SettleResponse (the settlement receipt). */
  response: "PAYMENT-RESPONSE",
  v1Signature: "X-PAYMENT",
} as const;

/**
 * Price of one call, in USD, per tool. Every tool is free today; the table exists
 * because `x402Facts().unconfigured` needs somewhere for a price to be > 0 while
 * the facilitator is still missing, and because a future price should be one line
 * in one place instead of a check scattered through the transport.
 */
export const X402_PRICES: Record<string, number> = {
  // The two quest-writing tools are the priced surface — everything else in the
  // town stays free: reading, chatting, joining, even claiming a quest's reward
  // (quest_claim). Writing to the SHARED job board is what costs.
  quest_create: 0.001,
  quest_join: 0.001,
} as Record<string, number>;
// every tool not listed above is free — keep this literal out of call sites
for (const name of TOOL_NAMES) if (!(name in X402_PRICES)) X402_PRICES[name] = 0;

export interface X402Facts {
  /** `X402_FACILITATOR_URL` and `X402_PAY_TO` are both set. */
  configured: boolean;
  network: string;
  payTo: string | null;
  facilitator: string | null;
  /** tools priced above 0 */
  priced: string[];
  /** priced above 0 while `configured === false` — the misconfiguration surface */
  unconfigured: string[];
  free: number;
  total: number;
}

const FACILITATOR_ENV = "X402_FACILITATOR_URL";
const PAY_TO_ENV = "X402_PAY_TO";

/**
 * Facilitator calls are on the interactive path of an MCP request, so the SDK's
 * 90s default deadline is too generous to leave a caller hanging on a dead URL.
 */
const FACILITATOR_TIMEOUT_MS = 10_000;

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** Price of one call for `tool` in USD; unknown tools cost 0 (the dispatcher owns its own error). */
export function priceOf(tool: string): number {
  return X402_PRICES[tool] ?? 0;
}

/** Whether a call to `tool` has to be paid for. Configuration is a separate question — see `x402Facts`. */
export function needsPayment(tool: string): boolean {
  return priceOf(tool) > 0;
}

export function x402Facts(): X402Facts {
  const payTo = env(PAY_TO_ENV);
  const facilitator = env(FACILITATOR_ENV);
  const configured = payTo !== null && facilitator !== null;
  const priced = TOOL_NAMES.filter((name) => priceOf(name) > 0);
  return {
    configured,
    network: X402_NETWORK,
    payTo,
    facilitator,
    priced,
    // A priced tool with no facilitator is a broken deployment, not a free tool.
    unconfigured: configured ? [] : priced.slice(),
    free: TOOL_NAMES.filter((name) => priceOf(name) === 0).length,
    total: TOOL_NAMES.length,
  };
}

function requireConfigured(): { payTo: string; facilitator: string } {
  const { payTo, facilitator } = x402Facts();
  if (!payTo || !facilitator) {
    throw new Error(
      `x402 is not configured: ${PAY_TO_ENV} and ${FACILITATOR_ENV} must both be set before a payment can be required, verified, or collected.`,
    );
  }
  return { payTo, facilitator };
}

interface Prepared {
  facilitator: string;
  server: x402ResourceServer;
  scheme: ExactSvmScheme;
  /** the network id requirements were built for (the CAIP-2 form) */
  networkId: Network;
}

/**
 * Lazily build (and cache) the resource server: registration plus
 * `initialize()`, which is the only network call here — `GET <facilitator>/supported`.
 * The promise is cached per facilitator URL so concurrent tool calls share one
 * handshake, and a failed handshake is not cached as success.
 */
let preparedResource: { facilitator: string; promise: Promise<Prepared> } | null = null;

async function preparedServer(): Promise<Prepared> {
  const { facilitator } = requireConfigured();
  if (preparedResource?.facilitator === facilitator) return preparedResource.promise;
  const promise = buildResourceServer(facilitator);
  preparedResource = { facilitator, promise };
  try {
    return await promise;
  } catch (e) {
    preparedResource = null;
    throw e;
  }
}

async function buildResourceServer(facilitator: string): Promise<Prepared> {
  const [{ x402ResourceServer }, { HTTPFacilitatorClient }, { ExactSvmScheme }] = await Promise.all([
    import("@x402/core/server"),
    import("@x402/core/http"),
    import("@x402/svm/exact/server"),
  ]);
  // No rpcUrl on purpose: ExactSvmScheme embeds a recent blockhash only when it
  // has an RPC endpoint, and a 402 challenge must not touch a mainnet node.
  const scheme = new ExactSvmScheme();
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitator, timeoutMs: FACILITATOR_TIMEOUT_MS }));
  // registered under the CAIP-2 (≤32) form — the one the facilitator's /supported
  // advertises and the one `requirement` matching keys on. Registered under the
  // full genesis id the match failed live: the facilitator truncates (CAIP-2 cap).
  server.register(SVM_MAINNET_CAIP2, scheme);
  await server.initialize();
  // requirements are built for the SAME id, so the accepted rows on the wire and
  // the rows we match incoming payloads against share one identity
  return { facilitator, server, scheme, networkId: SVM_MAINNET_CAIP2 };
}

/**
 * Convert the USD price into the AssetAmount the scheme pays in.
 *
 * A plain `"$0.01"` price would be parsed by `@x402/svm` through `normalizeNetwork`,
 * which only knows CAIP-2 ids and throws on `X402_NETWORK` — the full genesis hash
 * this repo names its rail by. Supplying the asset amount directly keeps the network
 * we advertise and the asset we price in independent of that lookup; both still come
 * from the SDK's own default-asset table, never from a typed-in mint address.
 */
async function priceAmount(tool: string): Promise<AssetAmount> {
  const [{ getDefaultAsset }, { convertToTokenAmount }] = await Promise.all([
    import("@x402/svm"),
    import("@x402/core/utils"),
  ]);
  const usdc = getDefaultAsset(SVM_MAINNET_CAIP2, "USDC");
  const amount = convertToTokenAmount(String(priceOf(tool)), usdc.decimals);
  if (amount === "0") {
    // Cheaper than one atomic unit would silently mean "free" — say so instead.
    throw new Error(
      `price ${priceOf(tool)} USD for "${tool}" is below one ${usdc.symbol} atomic unit (${usdc.decimals} decimals).`,
    );
  }
  return { asset: usdc.asset, amount, extra: {} };
}

async function requirementsFor(tool: string): Promise<PaymentRequirements[]> {
  const { payTo } = requireConfigured();
  const { server, scheme, networkId } = await preparedServer();
  return server.buildPaymentRequirements({
    scheme: scheme.scheme,
    payTo,
    price: await priceAmount(tool),
    network: networkId,
  });
}

/**
 * Build the 402 challenge for a priced tool: the encoded `PAYMENT-REQUIRED` header
 * (base64 PaymentRequired, per the x402 spec) plus the decoded object as `body`.
 * Throws when the tool is free (a challenge for nothing would be a lie) or when
 * x402 is not configured.
 */
export async function challengeFor(tool: string): Promise<{ headers: Record<string, string>; body: unknown }> {
  if (!needsPayment(tool)) {
    throw new Error(`"${tool}" is priced at 0 USD — there is nothing to charge for it, so a 402 challenge would be a lie.`);
  }
  requireConfigured();
  const { server } = await preparedServer();
  const requirements = await requirementsFor(tool);
  const { encodePaymentRequiredHeader, PAYMENT_REQUIRED_CACHE_CONTROL } = await import("@x402/core/http");
  const paymentRequired = await server.createPaymentRequiredResponse(
    requirements,
    {
      url: `mcp:tools/call/${tool}`,
      description: `SlopAgentbook MCP tool "${tool}"`,
      serviceName: SERVER_INFO.name,
    },
    // Same wording the SDK's own HTTP layer uses for an unpaid request.
    "Payment required",
  );
  return {
    headers: {
      [X402_HEADERS.required]: encodePaymentRequiredHeader(paymentRequired),
      "Cache-Control": PAYMENT_REQUIRED_CACHE_CONTROL,
    },
    body: paymentRequired,
  };
}

function looksLikePaymentPayload(value: unknown): value is PaymentPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PaymentPayload>;
  return (
    typeof candidate.x402Version === "number" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}

/**
 * Settle a payment that already passed verification, for a `tools/call`.
 *
 * Delegated to `@x402/core`, which asks the facilitator's `/settle`; the receipt
 * (`SettleResponse`) is the caller's proof on the wire — `encodePaymentResponseHeader`
 * turns it into the `PAYMENT-RESPONSE` header the transport attaches to the 200.
 * A failed or dropped settle throws: the caller must send the failure to the
 * client, never run the tool and never write a receipt for it.
 */
export async function settlePayment(tool: string, paymentHeader: string): Promise<unknown> {
  if (!needsPayment(tool)) {
    throw new Error(`"${tool}" is priced at 0 USD — there is nothing to settle for it.`);
  }
  requireConfigured();
  const { decodePaymentSignatureHeader } = await import("@x402/core/http");
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(paymentHeader.trim());
  } catch {
    throw new Error("payment header did not decode into a PaymentPayload — nothing settled");
  }
  if (!looksLikePaymentPayload(payload)) {
    throw new Error("payment header is not a recognizable PaymentPayload — nothing settled");
  }
  const { server } = await preparedServer();
  const requirements = await requirementsFor(tool);
  const matched = server.findMatchingRequirements(requirements, payload);
  if (!matched) {
    throw new Error(
      `payment payload does not match this tool's requirements (another tool's, another price, or stale) — nothing settled`,
    );
  }
  const settle = await server.settlePayment(payload, matched);
  if (!settle.success) {
    // Indeterminate outcomes (timeout etc.) also land here — the honest answer to
    // the client is "not settled", and the tool does not run.
    throw new Error(`settlement failed: ${settle.errorReason ?? settle.errorMessage ?? "unknown facilitator error"}`);
  }
  return settle;
}

/**
 * Verify a payment presented for a `tools/call`.
 *
 * Returns true when nothing is owed (price 0) or when the facilitator confirms the
 * payment. Everything else is false: no header, undecodable header, a payload that
 * does not match the requirements we would issue, an unconfigured facilitator, or a
 * facilitator call that failed. Verification is delegated to `@x402/core`, which asks
 * the facilitator — this module never inspects a signature itself.
 */
export async function verifyPayment(tool: string, paymentHeader: string | undefined): Promise<boolean> {
  if (!needsPayment(tool)) return true; // nothing owed → nothing to verify
  if (!paymentHeader || !x402Facts().configured) return false;

  const { decodePaymentSignatureHeader } = await import("@x402/core/http");
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(paymentHeader.trim());
  } catch {
    return false; // not base64/JSON → not a payment
  }
  if (!looksLikePaymentPayload(payload)) return false;

  try {
    const { server } = await preparedServer();
    const [requirements] = await requirementsFor(tool);
    if (!requirements) return false;
    // The SDK's own matcher: a payload echoed against different requirements
    // (another tool, another price) is not this tool's payment.
    if (!server.findMatchingRequirements([requirements], payload)) return false;
    const result = await server.verifyPayment(payload, requirements);
    return result.isValid === true;
  } catch (e) {
    // Fail closed and say why: an unreachable facilitator must never read as "paid".
    console.error(`[x402] verify failed for "${tool}":`, e instanceof Error ? e.message : String(e));
    return false;
  }
}
