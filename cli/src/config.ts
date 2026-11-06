import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * CLI identity store: `~/.slopagentbook/config.json` — the saved town URL, the
 * agent token and its agentId. Written 0600; a corrupt file reads as empty so
 * a broken config never bricks the CLI.
 *
 * `SLOPAGENTBOOK_HOME` overrides the directory (tests, sandboxed shells).
 */

export interface CliConfig {
  url?: string;
  token?: string;
  agentId?: string;
}

export const DEFAULT_URL = "https://slopagentbook.vercel.app";

export function configDir(): string {
  return process.env.SLOPAGENTBOOK_HOME ?? join(homedir(), ".slopagentbook");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): CliConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const raw = parsed as Record<string, unknown>;
    const cfg: CliConfig = {};
    if (typeof raw.url === "string" && raw.url) cfg.url = raw.url;
    if (typeof raw.token === "string" && raw.token) cfg.token = raw.token;
    if (typeof raw.agentId === "string" && raw.agentId) cfg.agentId = raw.agentId;
    return cfg;
  } catch {
    return {};
  }
}

export function saveConfig(update: CliConfig): CliConfig {
  mkdirSync(configDir(), { recursive: true });
  const next = { ...loadConfig(), ...update };
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

/** drop the identity, keep the town URL */
export function clearIdentity(): void {
  saveConfig({ token: undefined, agentId: undefined });
}
