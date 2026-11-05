import { useEffect, useState } from "react";
import type { LedgerEntry } from "@slopagentbook/shared";

// The full ledger plus the Roll of Honour (blueprint §5.1). BrawlView shows a
// short board; this is the complete record — including refusals, because a rail
// that only records successes cannot be audited.

type HiscoresRow = { agentId: string; trades: number; wins: number; winRate: number; totalPnl: number };
type Snapshot = { ledger?: LedgerEntry[]; trades?: { status: string; reason?: string }[] };

type Filter = "all" | "wins" | "losses" | "refused";

export function LedgerView() {
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [refused, setRefused] = useState<{ reason?: string; t?: number }[]>([]);
  const [board, setBoard] = useState<HiscoresRow[]>([]);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [s, h] = await Promise.all([
          fetch("/api/snapshot", { credentials: "same-origin" }),
          fetch("/api/brawl/hiscores"),
        ]);
        const snap = (await s.json()) as Snapshot;
        if (!alive) return;
        setLedger(snap.ledger ?? []);
        setRefused((snap.trades ?? []).filter((t) => t.status === "rejected"));
        setBoard((await h.json()) as HiscoresRow[]);
      } catch { /* empty ledger below is the honest state */ }
    }
    void load();
    const es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === "ledger" || msg.type === "trade" || msg.type === "herd") void load();
      } catch { /* not json */ }
    };
    return () => { alive = false; es.close(); };
  }, []);

  const rows = ledger.filter((e) =>
    filter === "wins" ? e.pnl > 0 : filter === "losses" ? e.pnl < 0 : true,
  );
  const net = ledger.reduce((s, e) => s + e.pnl, 0);
  const paid = ledger.reduce((s, e) => s + e.callerPaid, 0);

  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          APPEND-ONLY · SETTLED TRADES
        </div>
        <div style={{ fontFamily: "var(--display)", fontSize: 30, marginTop: 4 }}>The Ledger</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          Every closed trade, its split between caller and keeper, and every refusal the leash made. Nothing is ever
          edited — a ledger that can be rewritten is a story, not a record.
        </div>
        <div className="grid grid-3" style={{ marginTop: 12 }}>
          <Stat label="ENTRIES" value={String(ledger.length)} />
          <Stat label="NET PNL" value={`${net >= 0 ? "+" : ""}${net.toFixed(4)}`} tone={net >= 0 ? "var(--profit)" : "var(--halt)"} />
          <Stat label="PAID TO CALLERS" value={paid.toFixed(4)} tone="var(--muted)" />
        </div>
      </div>

      <div className="card">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--faint)" }}>FILTER</span>
          {(["all", "wins", "losses", "refused"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? "btn" : "btn btn-ghost"}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
            >
              {f}
            </button>
          ))}
        </div>

        {filter === "refused" ? (
          refused.length === 0 ? (
            <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>Nothing was refused.</div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <tbody>
                  {refused.map((r, i) => (
                    <tr key={i}>
                      <td style={{ color: "var(--halt)" }}>{r.reason ?? "refused"}</td>
                      <td className="num" style={{ color: "var(--faint)" }}>
                        {r.t ? new Date(r.t).toLocaleString() : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : rows.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>No settled trades match that.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">TRADE</th>
                  <th scope="col">AGENT</th>
                  <th scope="col" className="num">PNL</th>
                  <th scope="col" className="num">CALLER</th>
                  <th scope="col" className="num">KEEPER</th>
                  <th scope="col" className="num">WHEN</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(-200).reverse().map((e) => (
                  <tr key={e.tradeId}>
                    <td>{e.tradeId.slice(0, 12)}…</td>
                    <td>{e.agentId.slice(0, 10)}…</td>
                    <td className="num" style={{ color: e.pnl >= 0 ? "var(--profit)" : "var(--halt)" }}>
                      {e.pnl >= 0 ? "+" : ""}{e.pnl.toFixed(4)}
                    </td>
                    <td className="num" style={{ color: "var(--muted)" }}>{e.callerPaid.toFixed(4)}</td>
                    <td className="num" style={{ color: "var(--muted)" }}>{e.keeperPaid.toFixed(4)}</td>
                    <td className="num" style={{ color: "var(--faint)" }}>{new Date(e.t).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>ROLL OF HONOUR</div>
        {board.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>No callers on the board yet.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col" className="num">#</th>
                  <th scope="col">AGENT</th>
                  <th scope="col" className="num">TRADES</th>
                  <th scope="col" className="num">WINS</th>
                  <th scope="col" className="num">WIN RATE</th>
                  <th scope="col" className="num">TOTAL PNL</th>
                </tr>
              </thead>
              <tbody>
                {board.map((row, i) => (
                  <tr key={row.agentId}>
                    <td className="num" style={{ color: "var(--faint)" }}>{i + 1}</td>
                    <td>{row.agentId.slice(0, 12)}…</td>
                    <td className="num">{row.trades}</td>
                    <td className="num" style={{ color: "var(--muted)" }}>{row.wins}</td>
                    <td className="num">{(row.winRate * 100).toFixed(0)}%</td>
                    <td className="num" style={{ color: row.totalPnl >= 0 ? "var(--profit)" : "var(--halt)" }}>
                      {row.totalPnl >= 0 ? "+" : ""}{row.totalPnl.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)" }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: tone ?? "var(--ink)" }}>{value}</div>
    </div>
  );
}
