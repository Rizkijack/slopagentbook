import { ElderDialog } from "../components/ElderDialog.js";

/**
 * The Elder (`#/elder`) — a branching dialog explaining settlement, the leash,
 * and the testnet rail. Selection state lives in ElderDialog; this page is
 * framing copy plus the panel (blueprint §5.1).
 */

export function ElderView() {
  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          THE ELDER · SETTLEMENT, IN PLAIN WORDS
        </div>
        <div style={{ fontFamily: "var(--serif)", fontSize: 34, marginTop: 4 }}>The Elder</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          The Elder has watched this town settle accounts long enough to be bored by it. Pick a topic; the answer
          branches from there. Nothing here is hidden behind a page load — the dialog happens where you stand.
        </div>
      </div>

      <ElderDialog />

      <div className="card muted" style={{ fontSize: 12 }}>
        The Elder speaks from the same facts the rail reports: settlement runs locally until a vault contract exists on
        the testnet. When you want the checkable version instead of the explained one, the{" "}
        <a href="#/notice">notice board</a> carries the chain id and the anti-scam rules.
      </div>
    </div>
  );
}
