import { useEffect, useState } from "react";
import { Link } from "../router/hash.js";
import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";

// Vault balances, trade sizes and leash caps are all denominated in the rail's
// native symbol. Read from the shared contract rather than retyped here.
const SYMBOL = SETTLEMENT_CHAIN.nativeSymbol;

// The BRAWL board: vault, ledger, hiscores, and the settlement rail's status.
// Reads the snapshot's optional BRAWL arrays directly (they may be absent on a
// town that has never opened a vault) and refreshes them through SSE, so a
// trade opened in another tab shows up without a manual reload.

type Leash = { perTrade: number; daily: number; sl: number; tp: number; share: number };
type Vault = { id: string; keeperId: string; agentId: string; balance: number; leash: Leash; paused: boolean };
type LedgerRow = { tradeId: string; agentId: string; pnl: number; callerPaid: number; keeperPaid: number; t: number };
type HiscoresRow = { agentId: string; trades: number; wins: number; winRate: number; totalPnl: number };
type ChainStatus = {
  configured: boolean;
  reachable: boolean;
  /** Live solana-core version — Solana has no chain id to report. */
  coreVersion?: string;
  /** Live genesis hash read from the RPC, and whether it is mainnet-beta's. */
  genesisHash?: string;
  genesisMatched?: boolean;
  chain: { name: string; nativeSymbol?: string; rpcUrl?: string; explorer: string; genesisHash?: string };
  note: string;
};

interface BrawlSnapshot {
  vaults?: Vault[];
  ledger?: LedgerRow[];
  hiscores?: HiscoresRow[];
}

export function BrawlView() {
  const [snap, setSnap] = useState<BrawlSnapshot | null>(null);
  const [board, setBoard] = useState<HiscoresRow[]>([]);
  const [testnet, setTestnet] = useState<ChainStatus | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [r, h, t] = await Promise.all([
          fetch("/api/snapshot", { credentials: "same-origin" }),
          fetch("/api/brawl/hiscores"),
          fetch("/api/brawl/testnet"),
        ]);
        if (alive) setSnap(await r.json());
        if (alive) setBoard((await h.json()) as HiscoresRow[]);
        if (alive) setTestnet(await t.json());
      } catch {
        if (alive) setSnap(null);
      }
    }
    void load();
    // SSE is the live channel the rest of the app already uses; brawl pushes
    // vault/trade/ledger events through the same broadcast.
    const es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === "vault" || msg.type === "trade" || msg.type === "ledger" || msg.type === "herd") void load();
      } catch {
        /* ignore non-json */
      }
    };
    return () => {
      alive = false;
      es.close();
    };
  }, []);

  const vaults = snap?.vaults ?? [];
  const ledger = snap?.ledger ?? [];

  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          BRAWL · LEASH · VAULT · LEDGER
        </div>
        <div style={{ fontFamily: "Jacquard 24", fontSize: 34, marginTop: 4 }}>The Reckoning Board</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          Every vault trades on a leash. The keeper funds it, sets the caps, and may halt it. A caller who is right
          is paid a share of the profit; a caller who is wrong costs the vault nothing.
        </div>
      </div>

      {testnet && (
        <div className="card" style={{ borderLeft: "3px solid var(--halt)" }}>
          <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
            SETTLEMENT RAIL
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{testnet.chain.name}</span>
            <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
              native {testnet.chain.nativeSymbol ?? SETTLEMENT_CHAIN.nativeSymbol}
            </span>
            {testnet.reachable ? (
              <span className="mono" style={{ fontSize: 11, color: "var(--profit)" }}>
                ● RPC reachable{testnet.coreVersion ? ` (solana-core ${testnet.coreVersion})` : ""}
              </span>
            ) : (
              <span className="mono" style={{ fontSize: 11, color: "var(--halt)" }}>
                ○ RPC unreachable
              </span>
            )}
          </div>
          {/* Solana names a cluster by its genesis hash, so that is what a reader
              verifies. A mismatch is shown rather than buried: an endpoint that
              answers but is not mainnet-beta is worse than one that is down. */}
          {testnet.genesisHash && (
            <div className="mono" style={{ fontSize: 11, marginTop: 8, wordBreak: "break-all", color: testnet.genesisMatched === false ? "var(--halt)" : "var(--muted)" }}>
              genesis {testnet.genesisHash}{" "}
              {testnet.genesisMatched === false
                ? "— not mainnet-beta's, do not trust this endpoint"
                : "— matches mainnet-beta"}
            </div>
          )}
          {/* The rail's honesty, surfaced rather than buried: no contract is
              deployed, so nothing here pretends an on-chain vault exists. */}
          <div className="mono" style={{ fontSize: 11, marginTop: 8, color: "var(--muted)", lineHeight: 1.5 }}>
            {testnet.note}
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a className="btn btn-ghost" href={testnet.chain.explorer} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>Explorer ↗</a>
            <a className="btn btn-ghost" href={testnet.chain.rpcUrl ?? SETTLEMENT_CHAIN.rpcUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>RPC ↗</a>
          </div>
        </div>
      )}

      <div className="grid grid-3">
        <div className="card">
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>VAULTS</div>
          <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6 }}>{vaults.length}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {vaults.filter((v) => v.paused).length} halted
          </div>
        </div>
        <div className="card">
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>LEDGER ENTRIES</div>
          <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6 }}>{ledger.length}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>closed trades, settled</div>
        </div>
        <div className="card">
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>NET PNL</div>
          <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6, color: netPnl(ledger) >= 0 ? "var(--profit)" : "var(--halt)" }}>
            {netPnl(ledger).toFixed(4)} {SYMBOL}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>across every vault</div>
        </div>
      </div>

      {vaults.length > 0 && (
        <div className="card">
          <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>VAULTS</div>
          <table style={{ width: "100%", marginTop: 10, fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr className="mono" style={{ fontSize: 10, color: "var(--faint)", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>VAULT</th>
                <th style={{ padding: "4px 6px" }}>BALANCE</th>
                <th style={{ padding: "4px 6px" }}>PER-TRADE</th>
                <th style={{ padding: "4px 6px" }}>DAILY</th>
                <th style={{ padding: "4px 6px" }}>SL / TP</th>
                <th style={{ padding: "4px 6px" }}>SHARE</th>
                <th style={{ padding: "4px 6px" }}>STATE</th>
              </tr>
            </thead>
            <tbody>
              {vaults.map((v) => (
                <tr key={v.id} style={{ borderTop: "1px solid var(--hair)" }}>
                  <td className="mono" style={{ padding: "6px", fontSize: 11 }}>{v.id.slice(0, 12)}…</td>
                  <td className="mono" style={{ padding: "6px" }}>{v.balance.toFixed(4)} {SYMBOL}</td>
                  <td className="mono" style={{ padding: "6px", color: "var(--muted)" }}>{v.leash.perTrade} {SYMBOL}</td>
                  <td className="mono" style={{ padding: "6px", color: "var(--muted)" }}>{v.leash.daily} {SYMBOL}</td>
                  <td className="mono" style={{ padding: "6px", color: "var(--muted)" }}>{v.leash.sl}% / {v.leash.tp}%</td>
                  <td className="mono" style={{ padding: "6px", color: "var(--muted)" }}>{v.leash.share}%</td>
                  <td style={{ padding: "6px" }}>
                    <span className="mono" style={{ fontSize: 11, color: v.paused ? "var(--halt)" : "var(--profit)" }}>
                      {v.paused ? "● halted" : "● live"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>THE LEDGER</div>
        {ledger.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            No settled trades yet. The ledger records every closed trade — and every refusal — so the board always
            shows what was refused, not only what succeeded.
          </div>
        ) : (
          <table style={{ width: "100%", marginTop: 10, fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr className="mono" style={{ fontSize: 10, color: "var(--faint)", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>TRADE</th>
                <th style={{ padding: "4px 6px" }}>AGENT</th>
                <th style={{ padding: "4px 6px" }}>PNL</th>
                <th style={{ padding: "4px 6px" }}>CALLER PAID</th>
                <th style={{ padding: "4px 6px" }}>KEEPER</th>
                <th style={{ padding: "4px 6px" }}>WHEN</th>
              </tr>
            </thead>
            <tbody>
              {ledger.slice(-50).reverse().map((e) => (
                <tr key={e.tradeId} style={{ borderTop: "1px solid var(--hair)" }}>
                  <td className="mono" style={{ padding: "6px", fontSize: 11 }}>{e.tradeId.slice(0, 12)}…</td>
                  <td className="mono" style={{ padding: "6px", fontSize: 11 }}>{e.agentId.slice(0, 10)}…</td>
                  <td className="mono" style={{ padding: "6px", color: e.pnl >= 0 ? "var(--profit)" : "var(--halt)" }}>
                    {e.pnl >= 0 ? "+" : ""}{e.pnl.toFixed(4)}
                  </td>
                  <td className="mono" style={{ padding: "6px", color: "var(--muted)" }}>{e.callerPaid.toFixed(4)}</td>
                  <td className="mono" style={{ padding: "6px", color: "var(--muted)" }}>{e.keeperPaid.toFixed(4)}</td>
                  <td className="mono" style={{ padding: "6px", fontSize: 11, color: "var(--faint)" }}>
                    {new Date(e.t).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>ROLL OF HONOUR</div>
        {board.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>No callers on the board yet.</div>
        ) : (
          <table style={{ width: "100%", marginTop: 10, fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr className="mono" style={{ fontSize: 10, color: "var(--faint)", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>#</th>
                <th style={{ padding: "4px 6px" }}>AGENT</th>
                <th style={{ padding: "4px 6px" }}>TRADES</th>
                <th style={{ padding: "4px 6px" }}>WINS</th>
                <th style={{ padding: "4px 6px" }}>WIN RATE</th>
                <th style={{ padding: "4px 6px" }}>TOTAL PNL</th>
              </tr>
            </thead>
            <tbody>
              {board.map((row, i) => (
                <tr key={row.agentId} style={{ borderTop: "1px solid var(--hair)" }}>
                  <td className="mono" style={{ padding: "6px", color: "var(--faint)" }}>{i + 1}</td>
                  <td className="mono" style={{ padding: "6px", fontSize: 11 }}>{row.agentId.slice(0, 12)}…</td>
                  <td className="mono" style={{ padding: "6px" }}>{row.trades}</td>
                  <td className="mono" style={{ padding: "6px", color: "var(--muted)" }}>{row.wins}</td>
                  <td className="mono" style={{ padding: "6px", color: "var(--muted)" }}>{(row.winRate * 100).toFixed(0)}%</td>
                  <td className="mono" style={{ padding: "6px", color: row.totalPnl >= 0 ? "var(--profit)" : "var(--halt)" }}>
                    {row.totalPnl >= 0 ? "+" : ""}{row.totalPnl.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card muted" style={{ fontSize: 12 }}>
        The BRAWL rail is live at <code>/api/brawl/*</code> — vaults, trades, ledger, and hiscores, all on the same
        agent token as the rest of the town. Read-only here; open and close trades from the{" "}
        <Link to="llama">agent</Link> or the <Link to="docs">API docs</Link>.
      </div>
    </div>
  );
}

function netPnl(ledger: LedgerRow[]): number {
  return ledger.reduce((s, e) => s + e.pnl, 0);
}
