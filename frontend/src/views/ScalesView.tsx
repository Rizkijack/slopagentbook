import { useEffect, useState } from "react";
import type { Vault } from "@slopagentbook/shared";
import { ScalesCalculator } from "../components/ScalesCalculator.js";

// What a leash actually means, in numbers (blueprint §5.1). The calculator is
// purely local — moving a slider never posts anything, so a keeper can see what
// a cap would have cost before committing to it.

type Snapshot = { vaults?: Vault[] };

export function ScalesView() {
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch("/api/snapshot", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d: Snapshot) => { if (alive) setVaults(d.vaults ?? []); })
      .catch(() => { /* the default leash below still computes */ });
    return () => { alive = false; };
  }, []);

  const leash = vaults[pick]?.leash;

  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          SETTLEMENT · BLUEPRINT §8
        </div>
        <div style={{ fontFamily: "Jacquard 24", fontSize: 30, marginTop: 4 }}>The Scales</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          The move is clamped by the leash before a penny is counted: the floor and the ceiling decide the result, not
          the market. A caller is paid only when there is a profit to pay from.
        </div>

        {vaults.length > 1 && (
          <label style={{ display: "block", marginTop: 12 }}>
            <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>READ THE LEASH OF</span>
            <select
              value={pick}
              onChange={(e) => setPick(Number(e.target.value))}
              className="mono"
              style={{ marginLeft: 8, padding: "3px 6px", fontSize: 12 }}
            >
              {vaults.map((v, i) => (
                <option key={v.id} value={i}>vault {v.id.slice(0, 10)}…</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="card">
        <ScalesCalculator leash={leash} />
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {leash
            ? "Using the caps of the selected vault."
            : "No vault yet — showing the default leash: 0.25 per trade, 1 a day, −20 / +40, 20% to the caller."}
        </div>
      </div>
    </div>
  );
}
