import { useState, type ChangeEvent } from "react";
import type { Leash } from "@slopagentbook/shared";
import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";

export interface ScaleResult {
  capped: number;
  pnl: number;
  callerPaid: number;
  keeperPaid: number;
}

// The rail's native symbol, read from the shared contract — every figure below
// is denominated in it.
const SYMBOL = SETTLEMENT_CHAIN.nativeSymbol;

// Blueprint §8 settlement, exactly as backend/src/leash.ts computes it. Exported
// and pure so the contract test can pin it without rendering anything — this is
// the one place where the two implementations must never drift.
//
// Worked example from the blueprint: size 0.25, +60% move, tp 40 -> capped 40 ->
// pnl 0.10; share 20 -> callerPaid 0.02, keeperPaid 0.08. On a loss the caller
// is paid exactly nothing and the keeper carries the whole thing.
export function settleScale(leash: Leash, size: number, rawMovePct: number): ScaleResult {
  const capped = Math.max(leash.sl, Math.min(leash.tp, rawMovePct));
  const pnl = (capped / 100) * size;
  const callerPaid = pnl > 0 ? (pnl * leash.share) / 100 : 0;
  return { capped, pnl, callerPaid, keeperPaid: pnl - callerPaid };
}

const LEASH: Leash = { perTrade: 0.25, daily: 1, sl: -20, tp: 40, share: 20 };

// Sliders in, money out (blueprint §5.2). The size and move sliders are local
// to the calculator — they are hypotheticals, not orders, so they are never
// posted to the rail.
export function ScalesCalculator({ leash = LEASH }: { leash?: Leash }) {
  const [size, setSize] = useState(0.25);
  const [move, setMove] = useState(60);
  const r = settleScale(leash, size, move);

  const num = (fn: (n: number) => void) => (e: ChangeEvent<HTMLInputElement>) => fn(Number(e.target.value));

  return (
    <div className="stagger" data-testid="scales-calculator">
      <label style={{ display: "block" }}>
        <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)", display: "flex", justifyContent: "space-between" }}>
          <span>SIZE</span><span style={{ color: "var(--ink)" }}>{size.toFixed(2)} {SYMBOL}</span>
        </span>
        <input type="range" min={0.01} max={1} step={0.01} value={size} onChange={num(setSize)} style={{ width: "100%", accentColor: "var(--accent)", marginTop: 2 }} />
      </label>

      <label style={{ display: "block" }}>
        <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)", display: "flex", justifyContent: "space-between" }}>
          <span>PRICE MOVE</span>
          <span style={{ color: move >= 0 ? "var(--profit)" : "var(--halt)" }}>{move >= 0 ? "+" : ""}{move}%</span>
        </span>
        <input type="range" min={-100} max={200} step={1} value={move} onChange={num(setMove)} style={{ width: "100%", accentColor: "var(--accent)", marginTop: 2 }} />
      </label>

      <div className="card" style={{ background: "var(--mark)", boxShadow: "none" }}>
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <tbody>
            <Row label="RAW MOVE" value={`${move >= 0 ? "+" : ""}${move}%`} />
            <Row label="CAPPED BY LEASH" value={`${r.capped >= 0 ? "+" : ""}${r.capped}%`} muted />
            <Row label="PNL" value={`${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(4)} ${SYMBOL}`} tone={r.pnl >= 0 ? "var(--profit)" : "var(--halt)"} />
            <Row label={`CALLER (${leash.share}%)`} value={`${r.callerPaid.toFixed(4)} ${SYMBOL}`} muted={r.callerPaid === 0} />
            <Row label="KEEPER KEEPS" value={`${r.keeperPaid.toFixed(4)} ${SYMBOL}`} tone="var(--ink)" />
          </tbody>
        </table>
        {r.callerPaid === 0 && r.pnl < 0 && (
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            A loss pays the caller nothing — the vault carries it alone.
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, tone, muted = false }: { label: string; value: string; tone?: string; muted?: boolean }) {
  return (
    <tr style={{ borderTop: "1px solid var(--hair)" }}>
      <td className="mono" style={{ padding: "5px 4px", fontSize: 10, color: "var(--faint)" }}>{label}</td>
      <td className="mono" style={{ padding: "5px 4px", textAlign: "right", color: tone ?? (muted ? "var(--muted)" : "var(--ink)") }}>{value}</td>
    </tr>
  );
}
