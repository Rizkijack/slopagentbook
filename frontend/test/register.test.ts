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

// 09 §1 — register.test.ts: the `#/register` page. A step-by-step guide plus
// four sections, English-only labels, the exact POST /api/agent/join payload,
// gateway error surfaces (400/429/network), client-side validation
// short-circuiting the network call, and the token discipline the component
// promises: memory only — never localStorage/sessionStorage, never console.

const RUN = Date.now().toString().slice(-7);
const OWNER_HANDLE = `@ada${RUN}`;
const TOKEN = "sabk_" + "a".repeat(48);

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
      "Register and copy the token",
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
    expect(Object.keys(body).sort()).toEqual(["handle", "job", "name", "origin", "owner"]);
    expect(body.name).toBe("Iris Reg");
    expect(body.job).toBe("herder");
    expect(body.origin).toBe("web:register");
    expect(body.owner).toEqual({ name: "Ada Lovelace", handle: OWNER_HANDLE });
    expect(body.handle).toBe("@irisreg"); // auto-derived from the name until edited

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
