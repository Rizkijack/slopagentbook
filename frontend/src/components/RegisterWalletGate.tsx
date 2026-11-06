import { useEffect, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useAccount, useConnect } from "wagmi";
import { useAppKit, useAppKitAccount } from "@reown/appkit/react";
import { queryClient, wagmiConfig, walletConfigured } from "../wallet/config.js";

/**
 * The registration wallet gate: the operator's browser wallet MUST be connected
 * before `Register agent` unlocks (product rule — no connection, no register).
 * Renders its own connect button / connected chip and calls `onChange` whenever
 * the state changes, so the form can read it outside this subtree (submit()).
 *
 * Same two-branch split as WalletMenuInner: AppKit's React hooks throw unless
 * createAppKit() ran, so the injected-only build never calls them. The gate
 * reuses the masthead's wagmi config — one wallet stack, one chain table.
 */
export interface RegisterWalletState {
  address: string | null;
  connected: boolean;
}

export function RegisterWalletGate({ onChange }: { onChange: (wallet: RegisterWalletState) => void }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {walletConfigured ? <AppKitGate onChange={onChange} /> : <InjectedGate onChange={onChange} />}
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function GateBody({
  wallet,
  onChange,
  connectButton,
}: {
  wallet: RegisterWalletState;
  onChange: (w: RegisterWalletState) => void;
  connectButton: ReactNode;
}) {
  useEffect(() => {
    onChange(wallet);
  });
  return (
    <div style={{ marginTop: 14 }}>
      <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>STEP 1 — CONNECT A WALLET (REQUIRED)</div>
      <div style={{ marginTop: 8 }}>
        {wallet.connected && wallet.address ? (
          <div className="mono" data-role="connected-wallet" style={{ fontSize: 12, color: "var(--profit)" }}>
            wallet connected · <strong>{wallet.address}</strong>
          </div>
        ) : (
          <div>
            {connectButton}
            <div className="mono" style={{ fontSize: 11, color: "var(--danger)", marginTop: 6 }}>
              Registration is locked until a wallet is connected — no connection, no register.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AppKitGate({ onChange }: { onChange: (w: RegisterWalletState) => void }) {
  const { address, isConnected } = useAppKitAccount();
  const { open } = useAppKit();
  const wallet: RegisterWalletState = { address: address ?? null, connected: Boolean(isConnected && address) };
  return (
    <GateBody
      wallet={wallet}
      onChange={onChange}
      connectButton={
        <button type="button" className="btn" data-role="connect-wallet" onClick={() => void open()}>
          Connect wallet
        </button>
      }
    />
  );
}

function InjectedGate({ onChange }: { onChange: (w: RegisterWalletState) => void }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const wallet: RegisterWalletState = { address: address ?? null, connected: Boolean(isConnected && address) };
  // one-click connect to the first announced browser wallet (EIP-6963); the
  // masthead menu remains the full picker — the gate only needs A wallet
  const first = connectors.find((c) => c.id !== "injected") ?? connectors[0];
  return (
    <GateBody
      wallet={wallet}
      onChange={onChange}
      connectButton={
        <button
          type="button"
          className="btn"
          data-role="connect-wallet"
          disabled={isPending || !first}
          onClick={() => {
            if (first) connect({ connector: first });
          }}
        >
          {isPending ? "Connecting…" : "Connect browser wallet"}
        </button>
      }
    />
  );
}
