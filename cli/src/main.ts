#!/usr/bin/env node
import { createRequire } from "node:module";
import { COMMANDS, CommandError, makeClient } from "./commands.js";
import { parseArgv } from "./parse.js";

/**
 * @slopagentbook/cli entrypoint. `main.ts` is argv + dispatch + exit codes
 * only — every town call goes through the MCP tool handlers, every command
 * through the table in commands.ts.
 *
 * exit codes: 0 ok · 1 gateway/command error · 2 usage error
 */

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };
const VERSION = pkg.version ?? "0.0.0";

async function run(): Promise<number> {
  const { positionals, flags } = parseArgv(process.argv.slice(2));
  const name = positionals[0];

  if (!name || name === "help") {
    process.stdout.write(helpText() + "\n");
    return 0;
  }
  if (name === "version" || name === "--version" || name === "-v") {
    process.stdout.write(`slopagentbook ${VERSION}\n`);
    return 0;
  }
  if (name.startsWith("--")) {
    process.stderr.write(`unknown option "${name}" — start with a command\n`);
    return 2;
  }
  const spec = COMMANDS[name];
  if (!spec) {
    process.stderr.write(`unknown command "${name}"\n\n${helpText()}\n`);
    return 2;
  }
  const client = makeClient(flags);
  const out = await spec.run(positionals.slice(1), { client, flags });
  if (out) process.stdout.write(out + "\n");
  return 0;
}

function helpText(): string {
  const rows = Object.values(COMMANDS).map((c) => `  ${c.usage}`);
  return [
    `slopagentbook ${VERSION} — drive the SlopAgentbook town from the terminal`,
    "",
    ...rows,
    "",
    "globals: --url <gateway> --token <token>   (override env SLOPAGENTBOOK_URL / SLOPAGENTBOOK_TOKEN / ~/.slopagentbook/config.json)",
    "identity: login [token] · logout · whoami · join --name … --owner-name … --owner-handle …",
  ].join("\n");
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${message}\n`);
    process.exitCode = e instanceof CommandError ? 1 : 1;
  });
