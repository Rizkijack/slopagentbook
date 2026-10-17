import { SlopAgentbookClient } from "./client.js";
import { McpDispatcher, INTERNAL_ERROR, type JsonRpcMessage, type JsonRpcResponse } from "./protocol.js";
import { challengeFor, needsPayment, priceOf, settlePayment, verifyPayment, x402Facts, X402_HEADERS, X402_NETWORK } from "./x402.js";

/**
 * MCP Streamable HTTP transport (stateless): `POST /mcp` with a JSON-RPC payload,
 * answered with `application/json`. GET/DELETE streams are not implemented, so the
 * server never opens an SSE channel back to the client.
 *
 * Token discipline: the transport is stateless, so a client may never outlive the
 * request that proved ownership of it. Every POST gets a fresh SlopAgentbookClient —
 * precedence `Authorization: Bearer <token>` header of THIS call > env
 * SLOPAGENTBOOK_TOKEN — and `join_town` only shares its token with the rest of the
 * same request (a JSON-RPC batch). The gateway token is returned once; the caller
 * sends it back as the Authorization header on the next call. A single shared
 * client would let caller A's `join_town` token authenticate caller B's `act`.
 * Pass `createClient` to inject — tests do exactly that.
 *
 * x402 layer: `tools/call` is gated before the dispatcher (see `x402Gate`). A tool
 * with price 0 — every tool except the two quest-writing ones — takes the exact
 * path it took before this layer existed. A priced tool needs a payment the
 * facilitator confirms; the flow is challenge → pay → verify → RUN → settle →
 * receipt on the result (`PAYMENT-RESPONSE`). Without a payment it gets HTTP 402
 * + `PAYMENT-REQUIRED`, or, while `X402_FACILITATOR_URL` / `X402_PAY_TO` are unset,
 * an explicit JSON-RPC error naming the misconfiguration instead of a free ride.
 * Settlement failure refuses the tool — a charge that did not complete must not
 * buy work.
 */

export interface HttpReqLike {
  method?: string;
  body?: unknown;
  /** Express/Node headers — optional so bare test stubs keep compiling. */
  headers?: Record<string, string | string[] | undefined>;
}

export interface HttpResLike {
  status(code: number): HttpResLike;
  set(field: string, value: string): HttpResLike;
  json(body: unknown): unknown;
  end(): unknown;
}

export type McpHttpHandler = (req: HttpReqLike, res: HttpResLike) => Promise<void>;

const CONTENT_TYPE = "Content-Type";

/**
 * JSON-RPC server-error codes (the reserved −32000…−32099 range) for the two ways a
 * paid tool can be refused without a challenge. The HTTP status still carries the
 * real answer: a challenge goes out as HTTP 402 with the `PAYMENT-REQUIRED` header.
 */
export const X402_NOT_CONFIGURED = -32001;
export const X402_PAYMENT_REQUIRED = -32002;
/** verify passed but the on-chain settle did not — the tool must not have run. */
export const X402_SETTLE_FAILED = -32003;

type X402Gate =
  /** price 0 (every tool today) or a payment the facilitator confirmed — run it */
  | { kind: "allowed" }
  /** paid-only path that cannot answer (a notification has nowhere to put a 402) */
  | { kind: "drop" }
  | { kind: "error"; id: number | string | null; error: { code: number; message: string; data?: unknown } }
  | { kind: "challenge"; id: number | string | null; tool: string; headers: Record<string, string> };

/**
 * Decide whether a JSON-RPC message may reach the dispatcher. Runs BEFORE the tool:
 * a priced tool is never dispatched unpaid, and a tool that is priced while x402 is
 * unconfigured is refused out loud rather than quietly served for free.
 */
async function x402Gate(message: JsonRpcMessage, headers?: Record<string, string | string[] | undefined>): Promise<X402Gate> {
  if (message.method !== "tools/call") return { kind: "allowed" };
  const tool = typeof message.params?.name === "string" ? message.params.name : "";
  // Free tool → byte-identical old path: no env read, no SDK import, no await.
  if (!needsPayment(tool)) return { kind: "allowed" };

  const id = (message.id ?? null) as number | string | null;
  const isRequest = message.id !== undefined && message.id !== null;
  const price = priceOf(tool);

  if (!x402Facts().configured) {
    return isRequest
      ? {
          kind: "error",
          id,
          error: {
            code: X402_NOT_CONFIGURED,
            message:
              `x402 is not configured: "${tool}" is priced at $${price} USD, but X402_FACILITATOR_URL and X402_PAY_TO are unset, ` +
              `so this server cannot collect a payment. The call was refused — not served for free.`,
            data: { tool, price, network: X402_NETWORK, configured: false },
          },
        }
      : { kind: "drop" };
  }

  const payment = paymentHeader(headers);
  if (payment !== undefined && (await verifyPayment(tool, payment))) return { kind: "allowed" };
  if (!isRequest) return { kind: "drop" }; // a notification can neither pay nor answer

  try {
    const challenge = await challengeFor(tool);
    return { kind: "challenge", id, tool, headers: challenge.headers };
  } catch (e) {
    // Priced and configured, but no challenge could be built (e.g. the facilitator
    // is unreachable). Say that instead of handing out a 402 nobody can answer.
    return {
      kind: "error",
      id,
      error: {
        code: INTERNAL_ERROR,
        message: `x402 challenge for "${tool}" could not be built: ${e instanceof Error ? e.message : String(e)}`,
        data: { tool, price, network: X402_NETWORK },
      },
    };
  }
}

function send402(res: HttpResLike, gate: Extract<X402Gate, { kind: "challenge" }>): void {
  res.status(402);
  for (const [field, value] of Object.entries(gate.headers)) res.set(field, value);
  res.json({
    jsonrpc: "2.0",
    id: gate.id,
    error: {
      code: X402_PAYMENT_REQUIRED,
      message:
        `payment required: "${gate.tool}" costs $${priceOf(gate.tool)} USD — ` +
        `pay against the ${X402_HEADERS.required} challenge and retry with the ${X402_HEADERS.signature} header`,
      data: { tool: gate.tool, price: priceOf(gate.tool), network: X402_NETWORK, header: X402_HEADERS.signature },
    },
  });
}

/** base64 payment payload from this request, if the caller presented one. */
function paymentHeader(headers?: Record<string, string | string[] | undefined>): string | undefined {
  if (!headers) return undefined;
  const wanted = [X402_HEADERS.signature.toLowerCase(), X402_HEADERS.v1Signature.toLowerCase()];
  for (const [field, value] of Object.entries(headers)) {
    if (!wanted.includes(field.toLowerCase())) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw && raw.trim()) return raw.trim();
  }
  return undefined;
}

export function createMcpHttpHandler(createClient: () => SlopAgentbookClient = () => new SlopAgentbookClient()): McpHttpHandler {
  return mcpHttp(createClient);
}

async function handleWithSettlement(
  dispatcher: McpDispatcher,
  message: JsonRpcMessage,
  payment: string | undefined,
): Promise<JsonRpcResponse | null> {
  const receipt: unknown =
    payment !== undefined &&
    message.method === "tools/call" &&
    typeof message.params?.name === "string" &&
    needsPayment(message.params.name)
      ? await settleOrRefuse(message.params.name, payment, message.id ?? null)
      : undefined;
  if (receipt && typeof receipt === "object" && RESPONSE_SHAPE in receipt) {
    return receipt as JsonRpcResponse; // settle refused — pre-shaped error
  }
  const out = await safeHandle(dispatcher, message);
  if (out && receipt && out.result && typeof out.result === "object") {
    (out.result as Record<string, unknown>)._meta = { [X402_HEADERS.response.toLowerCase()]: receipt };
  }
  return out;
}

/** marker key on a pre-shaped settle-failure response (a real receipt never has it) */
const RESPONSE_SHAPE = "error";

/**
 * Settle, or refuse with a shaped JSON-RPC error. Returns the settlement receipt,
 * or — when the settle failed — a response object carrying `error`, which the
 * caller forwards verbatim instead of running the tool.
 */
async function settleOrRefuse(
  tool: string,
  payment: string,
  id: number | string | null,
): Promise<unknown> {
  try {
    return await settlePayment(tool, payment);
  } catch (e) {
    return {
      jsonrpc: "2.0" as const,
      id,
      error: {
        code: X402_SETTLE_FAILED,
        message: `settlement failed for "${tool}" — the tool did not run: ${e instanceof Error ? e.message : String(e)}`,
        data: { tool, price: priceOf(tool), network: X402_NETWORK },
      },
    };
  }
}

function mcpHttp(createClient: () => SlopAgentbookClient): McpHttpHandler {
  return async function mcpHttpInternal(req: HttpReqLike, res: HttpResLike): Promise<void> {
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      res.status(405).set("Allow", "POST").json({
        error: "method not allowed — MCP Streamable HTTP uses POST /mcp",
      });
      return;
    }

    let payload: unknown;
    try {
      payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      sendJsonRpc(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }

    if (payload === undefined || payload === null) {
      sendJsonRpc(res, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "missing body" } });
      return;
    }

    // Fresh client per request: no token may outlive the call that carried it
    // (see the file header). Bearer header of THIS call wins over the env default.
    const client = createClient();
    const bearer = bearerToken(req.headers);
    if (bearer) client.token = bearer;

    // each request gets a fresh dispatcher (stateless): initialize is not required
    // before tools/list, and no session id is negotiated.
    const dispatcher = new McpDispatcher(client);

    if (Array.isArray(payload)) {
      const replies: JsonRpcResponse[] = [];
      for (const item of payload as JsonRpcMessage[]) {
        const gate = await x402Gate(item, req.headers);
        if (gate.kind === "challenge") {
          // one payment answer per HTTP response: the whole batch pays or none runs
          send402(res, gate);
          return;
        }
        if (gate.kind === "drop") continue;
        if (gate.kind === "error") {
          replies.push({ jsonrpc: "2.0", id: gate.id, error: gate.error });
          continue;
        }
        const out = await handleWithSettlement(dispatcher, item, paymentHeader(req.headers));
        if (out) replies.push(out);
      }
      if (replies.length === 0) {
        // batch of notifications only — accepted, no body
        res.status(202).set(CONTENT_TYPE, "text/plain").end();
        return;
      }
      sendJsonRpc(res, replies);
      return;
    }

    const single = payload as JsonRpcMessage;
    const gate = await x402Gate(single, req.headers);
    if (gate.kind === "challenge") {
      send402(res, gate);
      return;
    }
    if (gate.kind === "drop") {
      res.status(202).set(CONTENT_TYPE, "text/plain").end();
      return;
    }
    if (gate.kind === "error") {
      sendJsonRpc(res, { jsonrpc: "2.0", id: gate.id, error: gate.error });
      return;
    }

    const out = await handleWithSettlement(dispatcher, single, paymentHeader(req.headers));
    if (!out) {
      // notification (e.g. notifications/initialized) — 202, no content
      res.status(202).set(CONTENT_TYPE, "text/plain").end();
      return;
    }
    sendJsonRpc(res, out);
  };
}

async function safeHandle(dispatcher: McpDispatcher, message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  try {
    return await dispatcher.handle(message);
  } catch (e) {
    return {
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
    };
  }
}

function sendJsonRpc(res: HttpResLike, body: JsonRpcResponse | JsonRpcResponse[]): void {
  res.status(200).set(CONTENT_TYPE, "application/json; charset=utf-8").json(body);
}

/** `Authorization: Bearer <token>` from this request's headers, if present. */
function bearerToken(headers?: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers?.authorization ?? headers?.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const m = /^Bearer\s+(.+)$/i.exec((value ?? "").trim());
  return m ? m[1]!.trim() : undefined;
}
