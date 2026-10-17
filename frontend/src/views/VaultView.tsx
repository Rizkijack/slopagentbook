import { useCallback, useEffect, useState } from "react";
import type { Vault, Leash } from "@slopagentbook/shared";
import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";
import { LeashPanel } from "../components/LeashPanel.js";
import { HaltRune } from "../components/HaltRune.js";

// A keeper's page: open a vault, fund it, set the five leashes, kill it. Reads
// the snapshot's optional `vaults` array (absent on a town that never opened
// one) and refreshes through the same SSE channel the rest of the app uses, so a
// trade closed in another tab lands without a reload.
//
// Auth reuses the existing session cookie — requireAgent on the backend accepts
// the cookie exactly as it accepts a bearer token, so there is no second auth
// system here. A 401 becomes a sentence on the page, not a crash.

type VaultResponse = { id?: string; error?: string; balance?: number; leash?: Leash };
type Snapshot = { vaults?: Vault[] };

// The rail's native symbol, from the shared contract — balances and fund amounts
// on this page are denominated in it.
const SYMBOL = SETTLEMENT_CHAIN.nativeSymbol;

export function VaultView() {
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [amount, setAmount] = useState("1");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/snapshot", { credentials: "same-origin" });
      const data = (await res.json()) as Snapshot;
      setVaults(data.vaults ?? []);
      setError("");
    } catch {
      setError("the town could not be reached");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === "vault" || msg.type === "trade" || msg.type === "herd") void load();
      } catch { /* not json */ }
    };
    return () => { es.close(); };
  }, [load]);

  async function post(path: string, body?: unknown): Promise<VaultResponse> {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as VaultResponse;
    if (res.status === 401) throw new Error("this action needs a session — sign in first");
    if (!res.ok) throw new Error(data.error || `refused (${res.status})`);
    return data;
  }

  async function guard(fn: () => Promise<void>, ok?: string) {
    setMessage("");
    setError("");
    try {
      await fn();
      if (ok) setMessage(ok);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "the rail refused");
    }
  }

  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          VAULTS · LEASH · HALT
        </div>
        <div style={{ fontFamily: "Jacquard 24", fontSize: 30, marginTop: 4 }}>The Strongbox</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          The keeper funds a vault and sets the caps; the agent inside it can never exceed them. Halting blocks the
          agent at once while leaving the keeper able to close positions and withdraw.
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn"
            onClick={() => void guard(async () => { await post("/api/brawl/vaults"); }, "Vault opened.")}
          >
            Open a vault
          </button>
        </div>
        {message && <div className="mono" style={{ fontSize: 11, marginTop: 8, color: "var(--profit)" }}>{message}</div>}
        {error && <div className="mono" style={{ fontSize: 11, marginTop: 8, color: "var(--halt)" }}>{error}</div>}
      </div>

      {!loaded && <div className="card muted">Reading the board…</div>}

      {loaded && vaults.length === 0 && (
        <div className="card muted" style={{ fontSize: 13 }}>
          No vault yet. Open one above to give the agent something it is allowed to lose.
        </div>
      )}

      {vaults.map((v) => (
        <div className="card" key={v.id} data-testid="vault-card" style={{ borderLeft: v.paused ? "3px solid var(--halt)" : "3px solid var(--hair)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
            <div>
              <div className="mono" style={{ fontSize: 11, color: "var(--faint)" }}>VAULT {v.id.slice(0, 14)}…</div>
              <div style={{ fontSize: 24, fontWeight: 700, marginTop: 2 }}>
                {v.balance.toFixed(4)} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>{SYMBOL}</span>
              </div>
              <div className="mono" style={{ fontSize: 11, color: v.paused ? "var(--halt)" : "var(--profit)" }}>
                {v.paused ? "● halted — the agent cannot open a trade" : "● live"}
              </div>
            </div>
            <HaltRune
              paused={v.paused}
              onToggle={async () => { await post(`/api/brawl/vaults/${v.id}/${v.paused ? "resume" : "halt"}`); }}
            />
          </div>

          <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Fund amount"
              className="mono"
              style={{ width: 96, padding: "4px 6px", fontSize: 12 }}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                const n = Number(amount);
                if (!Number.isFinite(n) || n <= 0) { setError("enter an amount above zero"); return; }
                void guard(async () => { await post(`/api/brawl/vaults/${v.id}/fund`, { amount: n }); }, `Funded ${n} ${SYMBOL}.`);
              }}
            >
              Fund
            </button>
          </div>

          <div style={{ marginTop: 14 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--faint)", marginBottom: 6 }}>
              LEASH
            </div>
            <LeashPanel
              leash={v.leash}
              onChange={(next) => setVaults((prev) => prev.map((x) => (x.id === v.id ? { ...x, leash: next } : x)))}
            />
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void guard(async () => { await post(`/api/brawl/vaults/${v.id}/leash`, { leash: v.leash }); }, "Leash saved.")}
              >
                Save leash
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
