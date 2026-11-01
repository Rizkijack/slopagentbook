import { useEffect, useState } from "react";

// The notice board (blueprint §5.1): the settlement rail's official facts plus
// the four warnings that keep people from being robbed while wearing this game's
// costume. The contract section reads the server rather than printing an
// address, because no contract is deployed — a notice board that invents an
// address is exactly how these scams work.

type ChainStatus = {
  // Elysium is EVM, so the identity is a chain id; there is no faucet on
  // mainnet. Fields beyond the first four are optional so an older build of
  // the backend still validates here rather than rendering "undefined".
  chain: { name: string; rpcUrl?: string; explorer: string; faucetUrl?: string; nativeSymbol?: string; chainId?: number };
  note?: string;
  contractAddress?: string;
  configured?: boolean;
  /** Live client version read from the RPC, when reachable. */
  clientVersion?: string;
  /** Live chain id read from the RPC, and whether it is 99901's. */
  chainId?: number;
  chainIdMatched?: boolean;
  reachable?: boolean;
};

const WARNINGS: { title: string; body: string }[] = [
  {
    title: "There is no contract to sign with",
    body: "This town settles on Elysium Mainnet, and no vault contract exists on it yet — so nothing here should ever ask you to sign, approve or send anything. A page that does is not this town, whatever it looks like. The board publishes no address until a contract exists; any address claiming to be this town's before this line changes is fake.",
  },
  {
    title: "Only trust an address you can find here",
    body: "An official contract address appears on this board and nowhere else. It is never sent by direct message, never in a reply, and never in a pop-up.",
  },
  {
    title: "No one else can hold your keys",
    body: "Nobody legitimate will ever ask for your seed phrase or private key to let you trade, claim, or verify. There is no such verification step.",
  },
  {
    title: "Mainnet funds are real, and sending them is final",
    body: "This is mainnet, not a testnet: there is no faucet and no free funds, and nothing can be reversed once it is sent. The testnet warning that used to sit here does not apply — which makes it more important, not less. Nobody connected to this town has any reason to want your HYPE.",
  },
];

export function NoticeView() {
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/brawl/testnet")
      .then((r) => r.json())
      .then((d: ChainStatus) => { if (alive) setStatus(d); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  const address = status?.contractAddress?.trim();
  const deployed = Boolean(address);

  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          OFFICIAL · READ BEFORE YOU SIGN
        </div>
        <div style={{ fontFamily: "Jacquard 24", fontSize: 30, marginTop: 4 }}>Notice Board</div>

        <div className="stagger" style={{ marginTop: 12, gap: 8 }}>
          <Fact label="NETWORK" value={status?.chain.name ?? "—"} />
          {/* The probe reads web3_clientVersion off the RPC — the live client
              string, which on a Nitro chain names the release actually running. */}
          <Fact label="CLIENT VERSION" value={status?.clientVersion ?? (status ? (status.reachable ? "reachable" : "unreachable") : "—")} />
          {/* The one fact worth pinning: an EVM chain is named by its chain id,
              and 99901 is this rail's published constant. A mismatch is shown,
              not buried — an endpoint that answers but turns out not to be
              Elysium is worse than one that is down, because it looks alive. */}
          <Fact
            label="CHAIN ID"
            value={chainIdFact(status)}
          />
          <Fact label="RPC" value={status?.chain.rpcUrl ?? "—"} />
          <Fact label="EXPLORER" value={status?.chain.explorer ?? "—"} />
          <Fact label="FAUCET" value={status?.chain.faucetUrl ?? "none — mainnet"} />
        </div>

        <div style={{ marginTop: 14, padding: "10px 12px", border: `1px solid ${deployed ? "var(--hair)" : "var(--halt)"}`, borderRadius: 6 }}>
          <div className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)" }}>
            VAULT CONTRACT
          </div>
          {deployed ? (
            <div className="mono" style={{ fontSize: 13, marginTop: 6, wordBreak: "break-all" }}>{address}</div>
          ) : (
            <div className="mono" style={{ fontSize: 12, marginTop: 6, color: "var(--halt)" }}>
              Not deployed yet.
              <div className="muted" style={{ fontSize: 11, marginTop: 4, color: "var(--muted)" }}>
                {status?.note ?? "No vault contract exists on this chain, so no address is published here."}
                {" "}Settlement runs in the town until one does. Any address claiming to be this town's contract
                before this line changes is fake.
              </div>
            </div>
          )}
        </div>

        {failed && (
          <div className="mono" style={{ fontSize: 11, marginTop: 10, color: "var(--halt)" }}>
            The chain facts could not be read, so nothing is asserted above. Try again rather than trusting a stale board.
          </div>
        )}
      </div>

      <div className="grid grid-2">
        {WARNINGS.map((w, i) => (
          <div className="card" key={w.title} style={{ borderLeft: "3px solid var(--danger)" }}>
            <div className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>WARNING {i + 1} OF 4</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{w.title}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>{w.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
      <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)", minWidth: 76 }}>{label}</span>
      <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

/** The chain-id line: the live id, plus whether it is 99901's. */
function chainIdFact(status: ChainStatus | null): string {
  if (!status) return "—";
  if (typeof status.chainId !== "number") return "not read";
  const verdict = status.chainIdMatched === false ? " — NOT Elysium" : " — Elysium";
  return `${status.chainId}${verdict}`;
}
