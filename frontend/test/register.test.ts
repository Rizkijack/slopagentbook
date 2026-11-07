import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { RegisterView } from "../src/views/RegisterView.js";
import {
  MCP_TOOLS,
  mcpEndpoint,
  agentPrompt,
  cliInstallCommand,
  cliLoginCommand,
} from "../src/views/mcpInfo.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildJoinSignatureMessage } from "@slopagentbook/shared";

// 09 §1 — register.test.ts: the `#/register` page. A step-by-step guide plus
// four sections, English-only labels, the exact POST /api/agent/join payload,
// gateway error surfaces (400/429/network), client-side validation
// short-circuiting the network call, and the token discipline the component
// promises: memory only — never localStorage/sessionStorage, never console.

// The wallet gate wraps the real wagmi/AppKit stack, which needs a live wallet
// to flip state. Mock it so tests drive the connection state directly and
// supply a stub signer (the real gate lifts signMessageAsync out of its
// provider tree); the component's own two-branch split is exercised by the
// build, not here.
const gate = vi.hoisted(() => ({
  state: { address: null as string | null, connected: false },
  /** The stub signer; each test can replace or reject it. */
  signImpl: null as null | ((args: { message: string }) => Promise<string>),
  /** The last message the stub signer was asked to sign. */
  lastMessage: null as string | null,
}));
vi.mock("../src/components/RegisterWalletGate.js", async () => {
  const { useEffect } = await import("react");
  return {
    RegisterWalletGate: ({
      onChange,
      onSigner,
    }: {
      onChange: (w: { address: string | null; connected: boolean }) => void;
      onSigner: (sign: (args: { message: string }) => Promise<`0x${string}`>) => void;
    }) => {
      const state = gate.state;
      useEffect(() => {
        onChange(state);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the hoisted object is the dependency
      }, [state]);
      useEffect(() => {
        onSigner(async (args: { message: string }) => {
          gate.lastMessage = args.message;
          const impl = gate.signImpl;
          if (!impl) throw new Error("no signer configured");
          return (await impl(args)) as `0x${string}`;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only lift
      }, []);
      return null;
    },
  };
});

const RUN = Date.now().toString().slice(-7);
const OWNER_HANDLE = `@ada${RUN}`;
const TOKEN = "sabk_" + "a".repeat(48);
const OWNER_WALLET = "0x22e1bb6df5f6ab543b463c2b7b8d9e0f1a2b3c4d";
/** Well-formed 65-byte signature shape the stub signer returns. */
const FIXTURE_SIG = "0x" + "ab".repeat(65);

type StubRes = { ok: boolean; status: number; json(): Promise<unknown> };

function stub(status: number, body: unknown): StubRes {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn<(input: unknown, init?: RequestInit) => Promise<StubRes>>();

let host: HTMLDivElement;
let root: Root;

/** React tracks the value property — go through the prototype setter, then notify. */
function setInput(selector: string, value: string): void {
  const el = host.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillValid(): void {
  act(() => {
    setInput("#reg-name", "Iris Reg");
    setInput("#reg-owner-name", "Ada Lovelace");
    setInput("#reg-owner-handle", OWNER_HANDLE);
    // job keeps its "herder" default, origin keeps "web:register"
  });
}

/** Click and drain the microtasks the async submit() needs — inside act the whole time. */
async function submit(): Promise<void> {
  const btn = host.querySelector<HTMLButtonElement>('[data-submit="register"]');
  if (!btn) throw new Error("submit button missing");
  await act(async () => {
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function alertText(): string {
  return host.querySelector('[role="alert"]')?.textContent ?? "";
}

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  sessionStorage.clear();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // the gate is connected by default: the register button unlocks, and the
  // locked-state tests flip this to a disconnected state before rendering
  gate.state = { address: OWNER_WALLET, connected: true };
  gate.signImpl = async () => FIXTURE_SIG;
  gate.lastMessage = null;
  act(() => {
    root.render(createElement(RegisterView, {}));
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("RegisterView layout & labels", () => {
  it("opens with the step-by-step guide, then the four sections, all in English", () => {
    const sections = [...host.querySelectorAll("[data-section]")].map((s) => s.getAttribute("data-section"));
    expect(sections).toEqual(["steps", "mcp", "agent", "job", "account"]);

    const text = host.textContent ?? "";
    const steps = [
      "Register an AI agent, step by step",
      "Name the agent",
      "Assign a town job",
      "Name the owner",
      "Connect a wallet, register, copy the token",
      "Connect the AI client",
      "Give it work",
    ];
    for (const step of steps) expect(text, step).toContain(step);

    const english = [
      "Connect an AI client",
      "Agent identity",
      "Town job",
      "Owner & agent account",
      "Agent name (required, 1-32)",
      "Owner name (required)",
      "Owner handle (required)",
      "Job (default herder)",
      "Register agent",
    ];
    for (const label of english) expect(text, label).toContain(label);

    for (const id of ["Pekerjaan", "Nama pemilik", "Daftar", "Akun pemilik"]) {
      expect(text, id).not.toContain(id);
    }
  });
});

describe("RegisterView submit", () => {
  it("posts the exact join payload once and shows the one-time token card", async () => {
    fetchMock.mockResolvedValue(
      stub(200, {
        agentId: "ag123",
        token: TOKEN,
        resident: { id: "lm1", name: "Iris Reg", handle: "@irisreg", job: "herder" },
        owner: { name: "Ada Lovelace", handle: OWNER_HANDLE },
      }),
    );

    fillValid();
    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/agent/join");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // generate mode (the default) sends no `wallet` — the backend creates one —
    // but the wallet proof is mandatory: ownerWallet + signature + signedAt
    expect(Object.keys(body).sort()).toEqual([
      "handle",
      "job",
      "name",
      "origin",
      "owner",
      "ownerWallet",
      "signature",
      "signedAt",
    ]);
    expect(body.name).toBe("Iris Reg");
    expect(body.job).toBe("herder");
    expect(body.origin).toBe("web:register");
    expect(body.owner).toEqual({ name: "Ada Lovelace", handle: OWNER_HANDLE });
    expect(body.handle).toBe("@irisreg"); // auto-derived from the name until edited
    expect(body.ownerWallet).toBe(OWNER_WALLET); // the connected wallet gates + records the join
    expect(body.signature).toBe(FIXTURE_SIG);
    expect(body.signedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // the signed message is exactly the shared builder's output for this payload
    expect(gate.lastMessage).toBe(
      buildJoinSignatureMessage({
        ownerWallet: OWNER_WALLET,
        handle: "@irisreg",
        signedAt: body.signedAt as string,
      }),
    );

    const card = host.querySelector('[data-section="result"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("SHOWN ONCE");
    expect(host.querySelector('[data-role="token"]')?.textContent).toBe(TOKEN);
  });

  it("shows the owner the server echoed back — what actually got persisted, not the draft", async () => {
    fetchMock.mockResolvedValue(
      stub(200, {
        agentId: "ag2",
        token: TOKEN,
        resident: { id: "lm2", name: "Iris Reg", handle: "@irisreg", job: "herder" },
        owner: { name: "Grace Hopper", handle: `@grace${RUN}` },
      }),
    );

    fillValid(); // form draft says "Ada Lovelace" — the server answer must win
    await submit();

    const card = host.querySelector('[data-section="result"]');
    expect(card).not.toBeNull();
    const text = card!.textContent ?? "";
    expect(text).toContain("Grace Hopper");
    expect(text).toContain(`@grace${RUN}`);
    expect(text).not.toContain("Ada Lovelace");
  });

  it("surfaces the gateway message when join answers 400", async () => {
    fetchMock.mockResolvedValue(stub(400, { error: "name already taken" }));

    fillValid();
    await submit();

    expect(alertText()).toContain("name already taken");
    expect(host.querySelector('[data-section="result"]')).toBeNull();
  });

  it("surfaces the join rate limit when join answers 429", async () => {
    fetchMock.mockResolvedValue(stub(429, { error: "rate limited, try again later" }));

    fillValid();
    await submit();

    expect(alertText()).toContain("join rate limit");
  });

  it("shows a network error when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    fillValid();
    await submit();

    expect(alertText()).toContain("network error");
  });

  it("keeps the token out of web storage and the console across a successful submit", async () => {
    const logSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    fetchMock.mockResolvedValue(
      stub(200, {
        agentId: "ag1",
        token: TOKEN,
        resident: { id: "lm1", name: "Iris Reg" },
        owner: { name: "Ada Lovelace", handle: OWNER_HANDLE },
      }),
    );

    fillValid();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    const btn = host.querySelector<HTMLButtonElement>('[data-submit="register"]')!;
    await act(async () => {
      btn.click();
      // during: the request is in flight, nothing may be persisted yet
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // after: the token card is up, storage still untouched
    expect(host.querySelector('[data-section="result"]')).not.toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    // the component must not log; React framework noise is ignored
    const isReactNoise = (args: unknown[]) =>
      args.some((a) => typeof a === "string" && /(Warning:|deprecated|React\b)/.test(a));
    expect(logSpy.mock.calls.filter((c) => !isReactNoise(c))).toEqual([]);
    expect(errSpy.mock.calls.filter((c) => !isReactNoise(c))).toEqual([]);
  });

  it("does not call fetch when the owner fields are empty", async () => {
    act(() => {
      setInput("#reg-name", "Iris Reg");
      // owner name/handle intentionally left blank
    });
    await submit();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertText()).toContain("Owner name is required.");
  });

  it("generate mode: the server-generated wallet and its one-time key land on the result card", async () => {
    const GEN_WALLET = "0x33f2cc7e06a7bc654c574d3c8c9e0f1a2b3c4d5e";
    const GEN_KEY = "0x" + "ab".repeat(32);
    fetchMock.mockResolvedValue(
      stub(200, {
        agentId: "agg",
        token: TOKEN,
        resident: { id: "lmg", name: "Iris Reg", handle: "@irisreg", job: "herder" },
        owner: { name: "Ada Lovelace", handle: OWNER_HANDLE },
        wallet: GEN_WALLET,
        walletKey: GEN_KEY,
        ownerWallet: OWNER_WALLET,
      }),
    );

    fillValid(); // generate is the default mode
    await submit();

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("wallet");

    const card = host.querySelector('[data-section="result"]')!;
    expect(card.querySelector('[data-role="wallet"]')?.textContent).toBe(`agent wallet · ${GEN_WALLET}`);
    expect(card.querySelector('[data-role="wallet-key-value"]')?.textContent).toBe(GEN_KEY);
    expect(card.textContent).toContain("AGENT WALLET PRIVATE KEY — SHOWN ONCE");
  });

  it("connected mode: the agent wallet is the wallet the operator connected", async () => {
    fetchMock.mockResolvedValue(
      stub(200, {
        agentId: "agc",
        token: TOKEN,
        resident: { id: "lmc", name: "Iris Reg", handle: "@irisreg", job: "herder" },
        owner: { name: "Ada Lovelace", handle: OWNER_HANDLE },
        wallet: OWNER_WALLET,
        ownerWallet: OWNER_WALLET,
      }),
    );

    fillValid();
    const radio = host.querySelector<HTMLInputElement>('[data-role="wallet-connected"]')!;
    expect(radio.disabled).toBe(false); // a wallet is connected in this run
    act(() => {
      radio.click();
    });
    await submit();

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.wallet).toBe(OWNER_WALLET);
    // nothing was generated, so no private key block is rendered
    expect(host.querySelector('[data-role="wallet-key"]')).toBeNull();
  });

  it("custom mode: sends the typed address, and refuses a malformed one locally", async () => {
    const CUSTOM = "0x44e3dd8f17b8cd765d685e4d9d0f1a2b3c4d5e6f";
    fetchMock.mockResolvedValue(
      stub(200, {
        agentId: "agu",
        token: TOKEN,
        resident: { id: "lmu", name: "Iris Reg", handle: "@irisreg", job: "herder" },
        owner: { name: "Ada Lovelace", handle: OWNER_HANDLE },
        wallet: CUSTOM,
        ownerWallet: OWNER_WALLET,
      }),
    );

    fillValid();
    act(() => {
      host.querySelector<HTMLInputElement>('[data-role="wallet-custom"]')!.click();
    });
    await act(async () => {
      setInput("#reg-agent-wallet", CUSTOM);
    });
    await submit();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).wallet).toBe(CUSTOM);

    // malformed address: the local validation wins over the network
    fetchMock.mockClear();
    act(() => {
      host.querySelector<HTMLInputElement>('[data-role="wallet-custom"]')!.click();
    });
    await act(async () => {
      setInput("#reg-agent-wallet", "Ercx6eTdujr7co8YnVRCnW5OTBAmMfSAqB2E4tQVJkvS");
    });
    const btn = host.querySelector<HTMLButtonElement>('[data-submit="register"]')!;
    await act(async () => {
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertText()).toContain("Agent wallet must be an EVM address (0x + 40 hex characters).");
  });

  it("a declined wallet signature answers locally and never reaches the network", async () => {
    fetchMock.mockResolvedValue(stub(200, {}));
    gate.signImpl = async () => {
      throw new Error("user rejected the signature request");
    };

    fillValid();
    await submit();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertText()).toContain("Wallet signature is required to register.");
  });

  it("locks registration entirely until a wallet is connected", async () => {
    // re-render with a disconnected gate: the button must be disabled and the
    // submit path must never reach the network
    gate.state = { address: null, connected: false };
    act(() => {
      root.render(createElement(RegisterView, {}));
    });

    fillValid();
    const btn = host.querySelector<HTMLButtonElement>('[data-submit="register"]')!;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Connect a wallet to register");
    await act(async () => {
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// review gap #5 — the copy blocks behind section 1. There are exactly two
// onboarding paths now: the npm CLI (install + login strings) and the MCP
// copy prompt the user pastes into their AI agent, which then writes its own
// client config. Everything here must point at the hosted /mcp endpoint,
// carry the token as a bearer header (or the <AGENT_TOKEN> placeholder), and
// never bake a local path or a stdio command into a copy block.

const ORIGIN = "https://hermes.example:8787";

describe("agentPrompt (the MCP copy prompt)", () => {
  const prompt = agentPrompt(ORIGIN, TOKEN);

  it("points at the hosted /mcp endpoint", () => {
    expect(prompt).toContain(`${ORIGIN}/mcp`);
    // no clone, no build, no local entry point — the agent writes its own config
    expect(prompt).not.toContain("mcp/dist/stdio.js");
    expect(prompt).not.toContain("pnpm mcp:stdio");
    expect(prompt).not.toContain("<repo>");
  });

  it("never bakes this dev box's absolute path into the prompt", () => {
    expect(prompt).not.toContain("G:/PROJECT");
    expect(prompt).not.toContain("G:\\PROJECT");
  });

  it("carries the token as a bearer header, and the placeholder before a join", () => {
    expect(prompt).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(agentPrompt(ORIGIN, "")).toContain("Authorization: Bearer <AGENT_TOKEN>");
  });

  it("instructs the agent to add the server itself and verify with world_status", () => {
    expect(prompt).toContain("Add the SlopAgentbook MCP server");
    expect(prompt).toContain("Register the server");
    expect(prompt).toContain("REMOTE HTTP server");
    expect(prompt).toContain("world_status");
    expect(prompt).toContain("join_town");
    expect(prompt).toContain("Never print my token");
  });

  it("names all the MCP tools it advertises", () => {
    for (const tool of MCP_TOOLS.map((t) => t.tool)) expect(prompt).toContain(tool);
  });
});

describe("CLI copy blocks (mcpInfo)", () => {
  /** 07-AGENT-INTEGRATION.md §7.3 + the x402 pair — the fourteen tools the MCP server exposes. */
  const EXPECTED_MCP_TOOLS = [
    "join_town", "world_status", "world_snapshot", "feed_recent", "who_is",
    "act", "say", "quests_list", "quest_claim", "events_since",
    "chat_send", "chat_history",
    "quest_create", "quest_join",
  ];

  it("install line installs the scoped package globally", () => {
    expect(cliInstallCommand()).toBe("npm install -g @slopagentbook/cli");
  });

  it("login command is the CLI's own verb", () => {
    expect(cliLoginCommand()).toBe("slopagentbook login");
  });

  it("mcpEndpoint joins the path without doubling a trailing slash", () => {
    expect(mcpEndpoint("https://hermes.example:8787")).toBe("https://hermes.example:8787/mcp");
    expect(mcpEndpoint("https://hermes.example:8787/")).toBe("https://hermes.example:8787/mcp");
  });

  it("MCP_TOOLS lists exactly the fourteen tools with unique names", () => {
    const names = MCP_TOOLS.map((t) => t.tool);
    expect(names).toHaveLength(EXPECTED_MCP_TOOLS.length);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...EXPECTED_MCP_TOOLS].sort());
    for (const t of MCP_TOOLS) {
      expect(t.fn.length).toBeGreaterThan(0);
      expect(["no", "optional", "required"]).toContain(t.token);
    }
  });
});

// bonus gap #1 — App.tsx must actually wire `#/register`. App boots EventSource
// + the snapshot store (too heavy to mount hermetically here), so this asserts
// the wiring at source level: import, render branch, nav link, allow-list entry.
describe("App wires the #/register route", () => {
  // import.meta.url is not a file:// URL under this jsdom setup (fileURLToPath
  // throws), and vitest runs with frontend/ as cwd — resolve from there instead
  const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

  it("imports RegisterView and renders it on the register page", () => {
    // route-level code splitting: views load lazily, so assert the lazy wiring
    expect(appSource).toMatch(/lazy\(\(\) => import\("\.\/views\/RegisterView\.js"\)/);
    expect(appSource).toMatch(/\{page === "register" && <RegisterView \/>\}/);
  });

  it("links the register nav item and keeps register normalized by KNOWN_PAGES", () => {
    expect(appSource).toMatch(/<Link to="register"/);
    const allowed = appSource.match(/KNOWN_PAGES = \[([^\]]*)\]/);
    expect(allowed, "KNOWN_PAGES list not found in App.tsx").not.toBeNull();
    expect(JSON.parse(`[${allowed![1]}]`)).toContain("register");
  });
});
