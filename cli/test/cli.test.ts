import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgv, type Flags } from "../src/parse.js";
import { coerceArgs, COMMANDS, makeClient, resolveToken, resolveUrl, CommandError } from "../src/commands.js";
import { DEFAULT_URL, clearIdentity, configPath, loadConfig, saveConfig } from "../src/config.js";
import { TOOL_NAMES, getTool } from "@slopagentbook/mcp/tools";
import { SlopAgentbookClient, GatewayError } from "@slopagentbook/mcp/client";

// The CLI is a shim: parser, coercion, config store, command table and one
// e2e command run against a stubbed gateway. The tool handlers themselves are
// mcp's tests' job.

const TOKEN = "sabk_" + "b".repeat(48);

type StubRes = { ok: boolean; status: number; json(): Promise<unknown> };
function stub(status: number, body: unknown): StubRes {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const originalFetch = globalThis.fetch;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sab-cli-"));
  process.env.SLOPAGENTBOOK_HOME = home;
  delete process.env.SLOPAGENTBOOK_URL;
  delete process.env.SLOPAGENTBOOK_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SLOPAGENTBOOK_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("parseArgv", () => {
  it("splits positionals and --key value flags", () => {
    const p = parseArgv(["say", "hello", "town", "--board", "chat"]);
    expect(p.positionals).toEqual(["say", "hello", "town"]);
    expect(p.flags).toEqual({ board: "chat" });
  });

  it("supports --key=value and bare boolean flags", () => {
    const p = parseArgv(["act", "walk", "--place=forum", "--verbose"]);
    expect(p.positionals).toEqual(["act", "walk"]);
    expect(p.flags).toEqual({ place: "forum", verbose: true });
  });

  it("keeps a flag value that itself starts with -- as a bare flag", () => {
    const p = parseArgv(["say", "--urgent"]);
    expect(p.flags).toEqual({ urgent: true });
  });
});

describe("coerceArgs", () => {
  it("uses the tool's own inputSchema to turn numeric flags into numbers", () => {
    const def = getTool("events_since")!;
    expect(coerceArgs(def, { since: "123" })).toEqual({ since: 123 });
  });

  it("refuses a non-numeric value for a numeric field", () => {
    const def = getTool("chat_history")!;
    expect(() => coerceArgs(def, { limit: "many" })).toThrow(CommandError);
  });

  it("leaves string fields alone and drops undefined", () => {
    const def = getTool("say")!;
    expect(coerceArgs(def, { text: "hi", board: undefined })).toEqual({ text: "hi" });
  });
});

describe("command table", () => {
  // every MCP tool is reachable from the CLI — join_town through `join`, the
  // rest through a 1:1 command
  const TOOL_TO_COMMAND: Record<string, string> = {
    join_town: "join",
    world_status: "status",
    world_snapshot: "snapshot",
    feed_recent: "feed",
    who_is: "who",
    act: "act",
    say: "say",
    quests_list: "quests",
    quest_claim: "claim",
    quest_join: "quest-join",
    events_since: "events",
    chat_send: "chat-send",
    chat_history: "chat-history",
    quest_create: "quest-create",
  };

  it("covers every MCP tool with a command", () => {
    expect(new Set(TOOL_NAMES)).toEqual(new Set(Object.keys(TOOL_TO_COMMAND)));
    for (const cmd of Object.values(TOOL_TO_COMMAND)) {
      expect(COMMANDS[cmd], cmd).toBeDefined();
    }
  });
});

describe("config store", () => {
  it("round-trips url/token/agentId into SLOPAGENTBOOK_HOME", () => {
    saveConfig({ url: "http://localhost:3000", token: TOKEN, agentId: "ag1" });
    expect(loadConfig()).toEqual({ url: "http://localhost:3000", token: TOKEN, agentId: "ag1" });
    expect(existsSync(configPath())).toBe(true);
  });

  it("reads a corrupt config as empty instead of throwing", () => {
    saveConfig({ token: TOKEN });
    writeFileSync(configPath(), "{not json");
    expect(loadConfig()).toEqual({});
  });

  it("clearIdentity drops the token but keeps the url", () => {
    saveConfig({ url: "http://localhost:3000", token: TOKEN, agentId: "ag1" });
    clearIdentity();
    expect(loadConfig()).toEqual({ url: "http://localhost:3000" });
  });
});

describe("client resolution", () => {
  it("flag beats env beats saved config beats the production default", () => {
    process.env.SLOPAGENTBOOK_URL = "http://env:1";
    saveConfig({ url: "http://config:2" });
    expect(resolveUrl({})).toBe("http://env:1");
    expect(resolveUrl({ url: "http://flag:3/" })).toBe("http://flag:3");
    delete process.env.SLOPAGENTBOOK_URL;
    expect(resolveUrl({})).toBe("http://config:2");
  });

  it("falls back to the production default with nothing configured", () => {
    expect(resolveUrl({})).toBe(DEFAULT_URL);
    expect(resolveToken({})).toBeUndefined();
    expect(makeClient({}).baseUrl).toBe(DEFAULT_URL);
  });
});

describe("a command end to end against a stubbed gateway", () => {
  it("say sends the bearer token, prints the result, never the token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return stub(200, { post: { id: "p1", text: "hello town", t: 1 } });
    }) as unknown as typeof fetch;

    const client = makeClient({ url: "http://gw:1", token: TOKEN });
    const out = await COMMANDS["say"]!.run(["hello", "town"], { client, flags: { board: "chat" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://gw:1/api/agent/say");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "hello town", board: "chat" });

    expect(out).toContain("hello town");
    expect(out).not.toContain(TOKEN);
  });

  it("events coerces --since into the query string", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return stub(200, { events: [], posts: [], cursor: 179 });
    }) as unknown as typeof fetch;

    const client = makeClient({ url: "http://gw:2", token: TOKEN });
    await COMMANDS["events"]!.run([], { client, flags: { since: "42" } });
    expect(calls[0]).toBe("http://gw:2/api/agent/events?since=42");
  });

  it("whoami without a token answers without touching the network", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const client = new SlopAgentbookClient("http://gw:3", undefined);
    const out = await COMMANDS["whoami"]!.run([], { client, flags: {} });
    expect(out).toContain("not logged in");
    expect(called).toBe(0);
  });

  it("whoami with a rejected token says so and never prints the token", async () => {
    globalThis.fetch = (async () => stub(401, { error: "unknown token" })) as unknown as typeof fetch;
    const client = new SlopAgentbookClient("http://gw:4", TOKEN);
    const out = await COMMANDS["whoami"]!.run([], { client, flags: {} });
    expect(out).toContain("not logged in");
    expect(out).not.toContain(TOKEN);
  });
});

describe("login", () => {
  it("verifies the token, saves it, and never prints it", async () => {
    globalThis.fetch = (async () =>
      stub(200, { agentId: "ag9", resident: { id: "lm9", name: "Iris", handle: "@iris" } })) as unknown as typeof fetch;

    const client = makeClient({ url: "http://gw:5" });
    const out = await COMMANDS["login"]!.run([TOKEN], { client, flags: {} });

    expect(out).toContain("Iris");
    expect(out).toContain("ag9");
    expect(out).not.toContain(TOKEN);
    const saved = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, string>;
    expect(saved.token).toBe(TOKEN);
    expect(saved.agentId).toBe("ag9");
  });

  it("refuses a rejected token and saves nothing", async () => {
    globalThis.fetch = (async () => stub(401, { error: "unknown token" })) as unknown as typeof fetch;
    const client = makeClient({ url: "http://gw:6" });
    await expect(COMMANDS["login"]!.run(["bad"], { client, flags: {} })).rejects.toThrow(/rejected/);
    expect(loadConfig()).toEqual({});
  });
});

describe("gateway errors surface as command errors", () => {
  it("a 400 from the gateway becomes a thrown error with the body detail", async () => {
    globalThis.fetch = (async () => stub(400, { error: "text too long" })) as unknown as typeof fetch;
    const client = new SlopAgentbookClient("http://gw:7", TOKEN);
    await expect(COMMANDS["say"]!.run(["x"], { client, flags: {} })).rejects.toThrow(/text too long/);
  });

  it("GatewayError keeps its status for exit-code decisions", () => {
    const e = new GatewayError("gateway 401", 401);
    expect(e.status).toBe(401);
  });
});

describe("join", () => {
  it("sends owner fields the web form sends, saves the token, never prints it", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return stub(200, {
        agentId: "ag2",
        token: TOKEN,
        resident: { id: "lm2", name: "Cli Test", handle: "@clitest", job: "herder" },
        owner: { name: "Ada", handle: "@ada" },
      });
    }) as unknown as typeof fetch;

    const client = makeClient({ url: "http://gw:8" });
    const out = await COMMANDS["join"]!.run([], {
      client,
      flags: { name: "Cli Test", "owner-name": "Ada", "owner-handle": "@ada", job: "herder" },
    });

    expect(calls[0]!.url).toBe("http://gw:8/api/agent/join");
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.name).toBe("Cli Test");
    expect(body.owner).toEqual({ name: "Ada", handle: "@ada" });
    expect(body.origin).toBe("cli");

    expect(out).toContain("joined the town");
    expect(out).not.toContain(TOKEN);
    const saved = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, string>;
    expect(saved.token).toBe(TOKEN);
  });

  it("forwards --wallet and reports it recorded on the agent record", async () => {
    const WALLET = "0x8237a546ab643b444450d168a24842F27Fe75fC6";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return stub(200, {
        agentId: "ag3",
        token: TOKEN,
        resident: { id: "lm3", name: "Cli Test", handle: "@clitest", job: "herder" },
        owner: { name: "Ada", handle: "@ada" },
        wallet: WALLET,
      });
    }) as unknown as typeof fetch;

    const client = makeClient({ url: "http://gw:10" });
    const out = await COMMANDS["join"]!.run([], {
      client,
      flags: { name: "Cli Test", "owner-name": "Ada", "owner-handle": "@ada", wallet: WALLET },
    });

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.wallet).toBe(WALLET);
    expect(out).toContain(`wallet ${WALLET} recorded`);
    expect(out).not.toContain(TOKEN);
  });

  it("refuses to run without the required flags", async () => {
    globalThis.fetch = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const client = makeClient({ url: "http://gw:9" });
    await expect(
      COMMANDS["join"]!.run([], { client, flags: { name: "Solo" } }),
    ).rejects.toThrow(/--owner-name/);
  });
});
