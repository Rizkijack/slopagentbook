import type { ChangeEvent } from "react";
import type { Leash } from "@slopagentbook/shared";
import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";

// The five leashes a keeper can pull (blueprint §5.2). Controlled rather than
// self-managing: the Scales calculator, the spellbook and the save request all
// read the same single value, so there is one source of truth for the caps.
// The size caps are denominated in the rail's native symbol, read from the
// shared contract rather than retyped here.
const SYMBOL = SETTLEMENT_CHAIN.nativeSymbol;
const FIELDS: { key: keyof Leash; label: string; min: number; max: number; step: number; unit: string; hint: string }[] = [
  { key: "perTrade", label: "PER-TRADE", min: 0.01, max: 1, step: 0.01, unit: SYMBOL, hint: "the most one trade may carry" },
  { key: "daily", label: "DAILY CAP", min: 0.01, max: 2, step: 0.01, unit: SYMBOL, hint: "the most a whole day may carry" },
  { key: "sl", label: "STOP LOSS", min: -100, max: 0, step: 1, unit: "%", hint: "the floor the move is clamped to" },
  { key: "tp", label: "TAKE PROFIT", min: 0, max: 200, step: 1, unit: "%", hint: "the ceiling the move is clamped to" },
  { key: "share", label: "CALLER SHARE", min: 0, max: 100, step: 1, unit: "%", hint: "the caller's cut of a profit" },
];

export function LeashPanel({ leash, onChange, disabled = false }: {
  leash: Leash;
  onChange?: (next: Leash) => void;
  disabled?: boolean;
}) {
  const update = (key: keyof Leash) => (e: ChangeEvent<HTMLInputElement>) => {
    onChange?.({ ...leash, [key]: Number(e.target.value) });
  };

  return (
    <div className="stagger" data-testid="leash-panel" style={{ gap: 10 }}>
      {FIELDS.map((f) => (
        <label key={f.key} style={{ display: "block" }}>
          <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)", display: "flex", justifyContent: "space-between" }}>
            <span>{f.label}</span>
            <span style={{ color: "var(--ink)" }}>
              {leash[f.key]}
              {f.unit}
            </span>
          </span>
          <input
            type="range"
            min={f.min}
            max={f.max}
            step={f.step}
            value={leash[f.key]}
            disabled={disabled}
            onChange={update(f.key)}
            style={{ width: "100%", accentColor: "var(--accent)", marginTop: 2 }}
          />
          <span className="muted" style={{ fontSize: 11 }}>{f.hint}</span>
        </label>
      ))}
    </div>
  );
}
