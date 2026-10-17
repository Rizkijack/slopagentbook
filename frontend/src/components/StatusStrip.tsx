import { useEffect, useState } from "react";
import { Link } from "../router/hash.js";
import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";

type ChainStatus = {
  chain: { name: string; nativeSymbol?: string };
  reachable?: boolean;
};

// The masthead strip (blueprint §5.2): which settlement rail this town is on,
// and one link into the workspace. Everything is read from the server, never
// typed here, so the strip cannot advertise a chain the backend doesn't report.
//
// Solana has no chain id, so the strip shows the native symbol beside the name
// instead of a number that would mean nothing. The route kept its `#/testnet`
// name (renaming it would break every saved link) even though the rail it opens
// is mainnet, so the link label says what the page is, not what the hash is.
export function StatusStrip() {
  const [status, setStatus] = useState<ChainStatus | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/brawl/testnet")
      .then((r) => r.json())
      .then((d: ChainStatus) => { if (alive && d?.chain) setStatus(d); })
      .catch(() => { /* strip is decorative; leave it out rather than show a lie */ });
    return () => { alive = false; };
  }, []);

  if (!status) return null;

  return (
    <span
      data-testid="status-strip"
      className="mono"
      style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 10, letterSpacing: "0.08em" }}
    >
      <span
        aria-hidden
        style={{
          width: 6, height: 6, borderRadius: 6,
          background: status.reachable === false ? "var(--halt)" : "var(--profit)",
        }}
      />
      <span style={{ color: "var(--muted)" }}>
        {status.chain.name} · {status.chain.nativeSymbol ?? SETTLEMENT_CHAIN.nativeSymbol}
      </span>
      <Link to="testnet" style={{ color: "var(--accent)" }}>Open workspace</Link>
    </span>
  );
}
