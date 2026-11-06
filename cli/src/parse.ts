/** argv shape: positionals in order, flags as `--key value`, `--key=value` or bare `--key`. */
export type Flags = Record<string, string | boolean>;

export interface ParsedArgv {
  positionals: string[];
  flags: Flags;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq > 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }
  return { positionals, flags };
}
