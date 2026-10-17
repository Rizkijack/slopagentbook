import { useEffect, useState } from "react";
import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";
import type { Leash, Vault, Trade } from "@slopagentbook/shared";

// The settlement rail app (`#/testnet`): chain status, a strongbox, and a trade
// — on Solana Mainnet. The route kept its name and so did this file; the rail it
// talks to is mainnet, settled and final. Same shape as BrawlView: the
// snapshot's optional arrays are read directly (absent on a fresh town) and
// refreshed through SSE, and the chain facts come from GET /api/brawl/testnet
// so this page never states a chain the server didn't report.
//
// Solana is not EVM: there is no chain id, so the page shows the live
// solana-core version the probe reads instead, and there is no faucet on
// mainnet, so the "dole" card says so rather than linking to a testnet that no
// longer applies.
//
// Honesty rules inherited from backend/src/testnet.ts: no vault contract is
// deployed and no signer exists, so nothing here pretends to be on-chain. The
// "deploy" action creates the town-side vault record; settlement runs locally
// until a contract exists. An empty address renders as "not deployed yet".

type ChainStatus = {
  configured: boolean;
  reachable?: boolean;
  /** Live solana-core version — Solana's stand-in for a chain id. */
  coreVersion?: string;
  /** Live genesis hash read from the RPC, and whether it is mainnet-beta's. */
  genesisHash?: string;
  genesisMatched?: boolean;
  chain: { name: string; rpcUrl: string; explorer: string; faucetUrl?: string; nativeSymbol: string; genesisHash?: string; chainId?: number };
  note: string;
};

interface TestnetSnapshot {
  vaults?: Vault[];
  trades?: Trade[];
}

/** Default leash a new strongbox is created with — the backend's own defaults (leash.ts parseLeash). */
const DEFAULT_LEASH: Leash = { perTrade: 0.25, daily: 1, sl: -20, tp: 40, share: 20 };

export function TestnetView() {
  const [snap, setSnap] = useState<TestnetSnapshot | null>(null);
  const [testnet, setTestnet] = useState<ChainStatus | null>(null);
  const [busy, setBusy] = useState<"deploy" | "trade" | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // trade form
  const [vaultId, setVaultId] = useState("");
  const [size, setSize] = useState("0.05");
  const [entryPrice, setEntryPrice] = useState("1");

  // The rail's native symbol, from the server's own status report with the
  // shared contract as the fallback before it loads. Every amount on this page
  // is denominated in it.
  const SYMBOL = testnet?.chain.nativeSymbol ?? SETTLEMENT_CHAIN.nativeSymbol;

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [r, t] = await Promise.all([
          fetch("/api/snapshot", { credentials: "same-origin" }),
          fetch("/api/brawl/testnet"),
        ]);
        if (alive) setSnap(await r.json());
        if (alive) setTestnet(await t.json());
      } catch {
        if (alive) setSnap(null);
      }
    }
    void load();
    // Same live channel as BrawlView: vault/trade events reload the arrays.
    const es = new EventSource("/api/stream");
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === "vault" || msg.type === "trade" || msg.type === "herd") void load();
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
  const trades = snap?.trades ?? [];
  const openTrades = trades.filter((t) => t.status === "open");

  // Keep the select honest when SSE refreshes change the list under it.
  const effectiveVaultId = vaults.some((v) => v.id === vaultId) ? vaultId : vaults[0]?.id ?? "";

  async function deployVault() {
    setBusy("deploy");
    setMessage(null);
    try {
      const res = await fetch("/api/brawl/vaults", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leash: DEFAULT_LEASH }),
      });
      const data = (await res.json()) as { id?: string; error?: string };
      if (res.status === 401) {
        setMessage({ kind: "err", text: "Not signed in — register an agent (or sign in on this browser) before opening a strongbox." });
      } else if (!res.ok || !data.id) {
        setMessage({ kind: "err", text: data.error ?? `deploy failed with status ${res.status}` });
      } else {
        setMessage({ kind: "ok", text: `Strongbox ${data.id.slice(0, 14)}… opened — town-side record only; no on-chain contract exists yet.` });
      }
    } catch {
      setMessage({ kind: "err", text: "network error — could not reach /api/brawl/vaults" });
    }
    setBusy(null);
  }

  async function openTrade() {
    const parsedSize = Number(size);
    const parsedEntry = Number(entryPrice);
    if (!effectiveVaultId) {
      setMessage({ kind: "err", text: "Open a strongbox first — there is no vault to trade from." });
      return;
    }
    if (!(parsedSize > 0) || !Number.isFinite(parsedEntry)) {
      setMessage({ kind: "err", text: "Size must be a positive number and entry price a valid one." });
      return;
    }
    setBusy("trade");
    setMessage(null);
    try {
      const res = await fetch("/api/brawl/trades", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vaultId: effectiveVaultId, size: parsedSize, entryPrice: parsedEntry }),
      });
      const data = (await res.json()) as { ok?: boolean; reason?: string; error?: string };
      if (res.status === 401) {
        setMessage({ kind: "err", text: "Not signed in — trades ride the same agent session as the rest of the town." });
      } else if (data.ok) {
        setMessage({ kind: "ok", text: `Trade opened: ${parsedSize} ${SYMBOL} at ${parsedEntry} — inside the leash.` });
      } else if (data.reason) {
        // A refusal is still recorded with its reason — show WHY, don't swallow it.
        setMessage({ kind: "err", text: `Refused by the leash: ${data.reason}` });
      } else {
        setMessage({ kind: "err", text: data.error ?? `trade failed with status ${res.status}` });
      }
    } catch {
      setMessage({ kind: "err", text: "network error — could not reach /api/brawl/trades" });
    }
    setBusy(null);
  }

  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          LEASH WORKSPACE · SOLANA MAINNET
        </div>
        <div style={{ fontFamily: "var(--serif)", fontSize: 34, marginTop: 4 }}>The Farrier&rsquo;s Row</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          Chain facts below are read from the server&rsquo;s own status endpoint, not typed in by hand. This is
          mainnet, so anything sent here is final. The rail is honest about its state: the chain is live, the
          vault contract is not deployed yet, and settlement runs locally until a contract and a signer exist.
        </div>
      </div>

      {/* ---- chain status ---- */}
      {testnet && (
        <div className="card" style={{ borderLeft: "3px solid var(--halt)" }}>
          <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
            CHAIN STATUS
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{testnet.chain.name}</span>
            <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
              native {testnet.chain.nativeSymbol}
            </span>
            {testnet.reachable && testnet.coreVersion ? (
              <span className="mono" style={{ fontSize: 11, color: "var(--profit)" }}>
                ● RPC reachable (solana-core {testnet.coreVersion})
              </span>
            ) : testnet.reachable === false ? (
              <span className="mono" style={{ fontSize: 11, color: "var(--halt)" }}>
                ○ RPC unreachable
              </span>
            ) : null}
          </div>
          <div className="mono" style={{ fontSize: 11, marginTop: 8, color: "var(--muted)", lineHeight: 1.5 }}>
            {testnet.note}
          </div>
          {/* Solana names a cluster by its genesis hash. That is the thing to
              verify, and a mismatch is shown rather than swallowed — an endpoint
              that answers but is not mainnet-beta is worse than one that is down. */}
          {testnet.genesisHash && (
            <div className="mono" style={{ fontSize: 11, marginTop: 6, wordBreak: "break-all", color: testnet.genesisMatched === false ? "var(--halt)" : "var(--faint)" }}>
              genesis {testnet.genesisHash}{" "}
              {testnet.genesisMatched === false
                ? "— not mainnet-beta's, do not trust this endpoint"
                : "— matches mainnet-beta"}
            </div>
          )}
          <div className="mono" style={{ fontSize: 11, marginTop: 6, color: "var(--faint)", lineHeight: 1.5 }}>
            RPC {testnet.chain.rpcUrl} · vault contract: not deployed yet · mainnet: active
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a className="btn btn-ghost" href={testnet.chain.explorer} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>Explorer ↗</a>
            <a className="btn btn-ghost" href={testnet.chain.rpcUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>RPC ↗</a>
          </div>
        </div>
      )}

      {/* ---- the dole ---- */}
      {/* This used to link a testnet faucet and explain what tQUOTE and tBASE
          were worth. None of that applies on mainnet: a faucet is a testnet
          affordance and there is no version of "mainnet SOL is worth nothing"
          that is true. The card stays because its absence would be a quieter
          claim than its presence — it now says what a reader needs to know,
          which is that there is no dole and everything sent is final. */}
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          THE DOLE · NONE ON MAINNET
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          A faucet hands out worthless test funds so people can practise. This rail is Solana Mainnet, where there is
          no faucet because the funds are real and transfers are final. There is nothing to claim here, and nothing in
          this town should ever ask you to send {testnet?.chain.nativeSymbol ?? "SOL"} anywhere — no contract is
          deployed, so there is no on-chain action to take.
        </div>
      </div>

      {/* ---- deploy vault ---- */}
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          THE STRONGBOX · DEPLOY
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          Open a scoped vault: warden funds it, the agent stays keyless, and the leash below is enforced before any
          order moves. This creates the town-side record (per-trade {DEFAULT_LEASH.perTrade} {SYMBOL} · daily{" "}
          {DEFAULT_LEASH.daily} {SYMBOL} · SL {DEFAULT_LEASH.sl}% · TP {DEFAULT_LEASH.tp}% · share {DEFAULT_LEASH.share}%).
          On-chain deployment happens when the contract exists — until then settlement is local.
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="btn" data-action="deploy" disabled={busy === "deploy"} onClick={() => void deployVault()}>
            {busy === "deploy" ? "Opening…" : `Deploy vault (${vaults.length} open)`}
          </button>
        </div>
      </div>

      {/* ---- trade ---- */}
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          MANUAL TRADE
        </div>
        {vaults.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            No vaults yet. A fresh town starts empty — open a strongbox above and this form comes alive.
          </div>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
              One manual trade against a vault of your choice. The leash checks it first: over the per-trade cap, over
              the daily cap, or against a halted vault, and it is refused with the reason — the refusal is recorded
              too.
            </div>
            <div style={{ marginTop: 12, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
              <div>
                <label htmlFor="tn-vault">Strongbox</label>
                <select id="tn-vault" value={effectiveVaultId} onChange={(e) => setVaultId(e.target.value)}>
                  {vaults.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.id.slice(0, 12)}… · {v.balance.toFixed(4)} {SYMBOL}{v.paused ? " (halted)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="tn-size">Size ({SYMBOL})</label>
                <input id="tn-size" inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} placeholder="0.05" />
              </div>
              <div>
                <label htmlFor="tn-entry">Entry price</label>
                <input id="tn-entry" inputMode="decimal" value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} placeholder="1" />
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <button className="btn" data-action="trade" disabled={busy === "trade"} onClick={() => void openTrade()}>
                {busy === "trade" ? "Asking the vault…" : "Open trade"}
              </button>
            </div>
          </>
        )}

        {message && (
          <div
            role={message.kind === "err" ? "alert" : "status"}
            style={{
              marginTop: 12,
              background: message.kind === "ok" ? "color-mix(in srgb, var(--profit) 14%, var(--paper))" : "color-mix(in srgb, var(--danger) 14%, var(--paper))",
              border: `1px solid ${message.kind === "ok" ? "var(--profit)" : "var(--danger)"}`,
              padding: "8px 10px",
              borderRadius: 4,
              fontSize: 12,
              color: message.kind === "ok" ? "var(--profit)" : "var(--danger)",
            }}
          >
            {message.text}
          </div>
        )}
      </div>

      {/* ---- vaults ---- */}
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          STRONGBOXES ({vaults.length})
        </div>
        {vaults.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            None yet. Vault state is optional on the snapshot, so a town that has never traded simply shows nothing
            here — not a placeholder, not a fake balance.
          </div>
        ) : (
          <table style={{ width: "100%", marginTop: 10, fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr className="mono" style={{ fontSize: 10, color: "var(--faint)", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>VAULT</th>
                <th style={{ padding: "4px 6px" }}>BALANCE</th>
                <th style={{ padding: "4px 6px" }}>PER-TRADE</th>
                <th style={{ padding: "4px 6px" }}>DAILY</th>
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
                  <td style={{ padding: "6px" }}>
                    <span className="mono" style={{ fontSize: 11, color: v.paused ? "var(--halt)" : "var(--profit)" }}>
                      {v.paused ? "● halted" : "● live"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ---- trades ---- */}
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          TRADES ({trades.length}{openTrades.length > 0 ? ` · ${openTrades.length} open` : ""})
        </div>
        {trades.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            No trades yet — open or rejected, every row lands here once it exists. The ledger on{" "}
            <a href="#/brawl">the Reckoning Board</a> records what was settled.
          </div>
        ) : (
          <table style={{ width: "100%", marginTop: 10, fontSize: 13, borderCollapse: "collapse" }}>
            <thead>
              <tr className="mono" style={{ fontSize: 10, color: "var(--faint)", textAlign: "left" }}>
                <th style={{ padding: "4px 6px" }}>TRADE</th>
                <th style={{ padding: "4px 6px" }}>SIZE</th>
                <th style={{ padding: "4px 6px" }}>ENTRY</th>
                <th style={{ padding: "4px 6px" }}>PNL</th>
                <th style={{ padding: "4px 6px" }}>STATE</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(-50).reverse().map((t) => (
                <tr key={t.id} style={{ borderTop: "1px solid var(--hair)" }}>
                  <td className="mono" style={{ padding: "6px", fontSize: 11 }}>{t.id.slice(0, 12)}…</td>
                  <td className="mono" style={{ padding: "6px" }}>{t.size} {SYMBOL}</td>
                  <td className="mono" style={{ padding: "6px", color: "var(--muted)" }}>{t.entryPrice}</td>
                  <td className="mono" style={{ padding: "6px", color: t.pnl >= 0 ? "var(--profit)" : "var(--halt)" }}>
                    {t.pnl >= 0 ? "+" : ""}{t.pnl.toFixed(4)}
                  </td>
                  <td style={{ padding: "6px" }}>
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: t.status === "rejected" ? "var(--danger)" : t.status === "open" ? "var(--accent)" : "var(--profit)",
                      }}
                    >
                      ● {t.status}
                      {t.status === "rejected" && t.reason ? ` — ${t.reason}` : ""}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
