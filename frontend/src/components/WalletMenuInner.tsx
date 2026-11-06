import { useEffect, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useAccount, useConnect, useDisconnect as useWagmiDisconnect } from "wagmi";
import {
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
  useAppKitTheme,
  useDisconnect as useAppKitDisconnect,
  useWalletInfo,
} from "@reown/appkit/react";
import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";
import { useTheme } from "../store/useTheme.js";
import { queryClient, wagmiConfig, walletConfigured } from "../wallet/config.js";

// The real masthead wallet control. WalletMenu.tsx lazy-loads this module and
// owns the loading button, so nothing here runs until the chunk is on the page.
//
// Disconnected it is one "Connect wallet" button. Connected it shows the
// address and nothing else; clicking that chip opens the wallet table, which is
// where Disconnect lives — the rail is a picker, not a second nav.
//
// Two implementations, chosen once at module scope by whether a Reown project
// id exists. AppKit's React hooks throw unless createAppKit() ran, so the
// injected-only path must not call them; splitting the components is what keeps
// that guarantee without a runtime branch inside a hook.
export function WalletMenuInner() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {walletConfigured ? <AppKitWalletMenu /> : <InjectedWalletMenu />}
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

// Close on outside click and Escape, the same two exits every disclosure uses.
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!open) return;
    // pointerdown, not mousedown: the mobile bottom sheet must dismiss on tap
    // without waiting for the browser to synthesise a mouse event.
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return ref;
}

function WalletPanel({
  walletName,
  address,
  network,
  busy,
  error,
  onDisconnect,
}: {
  walletName: string;
  address: string;
  network: string;
  busy: boolean;
  error: string | null;
  onDisconnect: () => void;
}) {
  return (
    <div className="wallet-popover" role="dialog" aria-label="Connected wallet">
      <div className="wallet-popover-head">Connected wallet</div>
      <div className="table-scroll">
        <table className="data-table wallet-table">
          <thead>
            <tr>
              <th scope="col">Wallet</th>
              <th scope="col">Address</th>
              <th scope="col">Network</th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{walletName}</td>
              <td className="wallet-address">{address}</td>
              <td>{network}</td>
              <td className="num">
                <button
                  type="button"
                  className="btn btn-ghost wallet-disconnect"
                  onClick={onDisconnect}
                  disabled={busy}
                >
                  {busy ? "Disconnecting…" : "Disconnect"}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {error && (
        <p className="wallet-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AppKitWalletMenu() {
  const { address, isConnected } = useAppKitAccount();
  const { caipNetwork } = useAppKitNetwork();
  const { walletInfo } = useWalletInfo();
  const { open } = useAppKit();
  const { disconnect } = useAppKitDisconnect();
  const { setThemeMode } = useAppKitTheme();
  const { theme } = useTheme();
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useDismiss(panelOpen, () => setPanelOpen(false));

  // Keep the modal on the app's theme; AppKit defaults to the system setting,
  // which can disagree with the parchment/stone/orbital cycle.
  useEffect(() => {
    setThemeMode(theme === "light" ? "light" : "dark");
  }, [theme]);

  const handleDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnect();
      setPanelOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "disconnect failed");
    } finally {
      setBusy(false);
    }
  };

  if (!isConnected || !address) {
    return (
      <div className="wallet-wrap">
        <button
          type="button"
          className="btn btn-ghost wallet-connect"
          onClick={() => void open()}
        >
          Connect wallet
        </button>
      </div>
    );
  }

  return (
    <div className="wallet-wrap" ref={wrapRef}>
      <button
        type="button"
        className="wallet-chip mono"
        aria-label={`Wallet ${address}`}
        aria-haspopup="dialog"
        aria-expanded={panelOpen}
        title={address}
        onClick={() => setPanelOpen((v) => !v)}
      >
        {shortAddress(address)}
      </button>
      {panelOpen && (
        <WalletPanel
          walletName={walletInfo?.name ?? "Browser wallet"}
          address={address}
          network={caipNetwork?.name ?? SETTLEMENT_CHAIN.name}
          busy={busy}
          error={error}
          onDisconnect={() => void handleDisconnect()}
        />
      )}
    </div>
  );
}

function InjectedWalletMenu() {
  const { address, chain, connector, isConnected } = useAccount();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnectAsync } = useWagmiDisconnect();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useDismiss(pickerOpen || panelOpen, () => {
    setPickerOpen(false);
    setPanelOpen(false);
  });

  // wagmi always adds a generic `injected` connector for pre-EIP-6963
  // providers. When real announcements exist, prefer those: the generic entry
  // would be the same wallet a second time, with no name.
  const announced = connectors.filter((c) => c.id !== "injected");
  const browserWallets = announced.length > 0 ? announced : connectors;

  const handleConnect = async (c: (typeof connectors)[number]) => {
    setError(null);
    try {
      await connectAsync({ connector: c });
      setPickerOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "connection refused");
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnectAsync();
      setPanelOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "disconnect failed");
    } finally {
      setBusy(false);
    }
  };

  if (!isConnected || !address) {
    return (
      <div className="wallet-wrap" ref={wrapRef}>
        <button
          type="button"
          className="btn btn-ghost wallet-connect"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((v) => !v)}
        >
          Connect wallet
        </button>
        {pickerOpen && (
          <div className="wallet-popover" role="dialog" aria-label="Choose a browser wallet">
            <div className="wallet-popover-head">Browser wallets detected</div>
            {browserWallets.length === 0 ? (
              <p className="wallet-note">
                No browser wallet found. Install an EIP-6963 wallet, then reopen this menu.
              </p>
            ) : (
              <ul className="wallet-list">
                {browserWallets.map((c) => (
                  <li key={c.uid}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={isPending}
                      onClick={() => void handleConnect(c)}
                    >
                      {c.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <p className="wallet-error" role="alert">
                {error}
              </p>
            )}
            <p className="wallet-note">Browser wallets only — the WalletConnect list is not configured.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-wrap" ref={wrapRef}>
      <button
        type="button"
        className="wallet-chip mono"
        aria-label={`Wallet ${address}`}
        aria-haspopup="dialog"
        aria-expanded={panelOpen}
        title={address}
        onClick={() => setPanelOpen((v) => !v)}
      >
        {shortAddress(address)}
      </button>
      {panelOpen && (
        <WalletPanel
          walletName={connector?.name ?? "Browser wallet"}
          address={address}
          network={chain?.name ?? SETTLEMENT_CHAIN.name}
          busy={busy}
          error={error}
          onDisconnect={() => void handleDisconnect()}
        />
      )}
    </div>
  );
}
