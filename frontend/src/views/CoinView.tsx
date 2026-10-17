import { useEffect, useState } from "react";
import type { TownSnapshot } from "@slopagentbook/shared";

export function CoinView({ snapshot }: { snapshot: TownSnapshot }) {
  const [treasury, setTreasury] = useState<{ sol: number; solUsd: number; usd: number; updated: number; address: string; chainName: string; illustrative?: boolean } | null>(null);
  // Read from config rather than inferring it from the chain name. The ternary
  // this replaces (`chainName === "Base" ? "ETH" : "SOL"`) was a second copy of
  // a fact the config already carries, and it went wrong the moment the chain
  // changed under it.
  const symbol = snapshot.config.nativeSymbol ?? "SOL";

  useEffect(() => {
    let alive = true;
    async function fetchTreasury() {
      try {
        const r = await fetch("/api/treasury");
        const j = await r.json();
        if (alive) setTreasury(j);
      } catch {}
    }
    fetchTreasury();
    const id = setInterval(fetchTreasury, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="stagger">
      <div className="card" style={{ background: "var(--ink)", color: "var(--mark)", borderColor: "var(--ink)" }}>
        <div className="mono" style={{ fontSize: 11, letterSpacing: 0.12 + "em", opacity: 0.7 }}>${snapshot.config.ticker} · {snapshot.config.chainName} · {snapshot.config.network}</div>
        <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6 }}>SlopAgentbook Treasury</div>
        {/* The treasury wallet, and nothing else. This line used to show
            `tokenAddress` — the mint — and said "No mint deployed yet" whenever
            it was empty, which made a real treasury address unshowable and
            answered the mint question on a card titled Treasury. The mint has
            its own statement in the ABOUT copy below. */}
        <div className="mono" style={{ fontSize: 11, opacity: 0.75, marginTop: 6, wordBreak: "break-all" }}>
          {snapshot.config.treasuryAddress
            ? snapshot.config.treasuryAddress
            : "Treasury address not stated"}
        </div>
        <div style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap" }}>
          {snapshot.config.tokenDeployed && (
            <>
              <a className="btn" style={{ background: "var(--mark)", color: "var(--ink)", borderColor: "var(--mark)", textDecoration: "none" }} href={snapshot.config.explorer} target="_blank" rel="noreferrer">Explorer ↗</a>
              <a className="btn btn-ghost" style={{ borderColor: "var(--mark)", color: "var(--mark)", textDecoration: "none" }} href={snapshot.config.dexUrl} target="_blank" rel="noreferrer">Dexscreener ↗</a>
            </>
          )}
          <a className="mono" style={{ alignSelf: "center", fontSize: 11, opacity: 0.7, color: "var(--mark)" }} href={snapshot.config.xUrl} target="_blank" rel="noreferrer">{snapshot.config.xUrl}</a>
        </div>
      </div>

      {/* grid-2, not the grid-3 this was: the third card held the wallet
          connect button, and deleting it left an empty cell that read as a
          missing card rather than as two wide ones. */}
      <div className="grid grid-2">
        <div className="card">
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>TREASURY — illustrative</div>
          {treasury ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>{treasury.sol.toFixed(4)} {symbol}</div>
              <div className="mono muted" style={{ fontSize: 12 }}>${treasury.solUsd.toFixed(2)} each → ${treasury.usd.toFixed(2)} USD</div>
              <div className="mono faint" style={{ fontSize: 10, marginTop: 6 }}>updated {new Date(treasury.updated).toLocaleString()}</div>
            </>
          ) : <div className="mono muted">Loading treasury…</div>}
        </div>
        <div className="card">
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>HERD CAPACITY</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>{snapshot.herd.length} / {snapshot.config.maxHerd}</div>
          <div style={{ marginTop: 8, height: 6, background: "var(--mark)", borderRadius: 6, overflow: "hidden" }}>
            <div style={{ width: `${(snapshot.herd.length / snapshot.config.maxHerd) * 100}%`, height: "100%", background: "var(--ink)" }} />
          </div>
          <div className="mono faint" style={{ fontSize: 10, marginTop: 6 }}>{snapshot.config.maxHerd - snapshot.herd.length} spots left · fork cost: {snapshot.config.forkCost}</div>
        </div>
      </div>

      <div className="card">
        <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>ABOUT ${snapshot.config.ticker}</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, marginTop: 8 }}>
          SlopAgentbook is the Hermes-town simulation — server-authoritative, real-time, every resident run by a rule table. No ${snapshot.config.ticker} mint is deployed and no on-chain reserve exists; the figures above are a fixed illustrative balance served by <code>/api/treasury</code>, not a reading of any chain.
        </div>
      </div>
    </div>
  );
}
