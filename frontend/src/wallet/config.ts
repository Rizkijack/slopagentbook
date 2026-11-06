import { QueryClient } from "@tanstack/react-query";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { createAppKit } from "@reown/appkit/react";
import { createConfig, http, type Config } from "wagmi";
import { injected } from "wagmi/connectors";
import { SETTLEMENT_CHAIN } from "@slopagentbook/shared";
import { townChain } from "./chain.js";

// The Reown project id is what turns on the full WalletConnect list — every
// wallet in the explorer, QR and desktop deeplinks — on top of the EIP-6963
// browser wallets AppKit detects for free. Without it AppKit's React hooks
// throw by design, so the app falls back to a wagmi-only menu that still lists
// installed browser wallets: the control must never dead-end on a missing
// build-time variable.
const projectId = (import.meta.env.VITE_REOWN_PROJECT_ID ?? "").trim();
export const walletConfigured = projectId.length > 0;

export const queryClient = new QueryClient();

const metadata = {
  name: "SlopAgentbook",
  description: "The herd trades. You hold the leash.",
  url: typeof window === "undefined" ? "https://slopagentbook.vercel.app" : window.location.origin,
  icons: [
    typeof window === "undefined"
      ? "https://slopagentbook.vercel.app/logo.png"
      : `${window.location.origin}/logo.png`,
  ],
};

function appKitConfig(): Config {
  const adapter = new WagmiAdapter({ networks: [townChain], projectId, ssr: false });

  createAppKit({
    adapters: [adapter],
    networks: [townChain],
    projectId,
    metadata,
    // A wallet picker, not a login screen. Reown's remote project config can
    // re-enable email/socials regardless of the local `email`/`socials: false`
    // flags, so those flags are not what pins the modal down: the connect order
    // is. One method — wallets — is the only screen AppKit may render.
    // `allWallets` is the full Reown/WalletConnect explorer list.
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
      history: false,
      receive: false,
      send: false,
      allWallets: true,
      connectMethodsOrder: ["wallet"],
    },
    // EIP-6963 is what puts an installed browser wallet at the top of the modal
    // ("Installed"); enableInjected covers pre-6963 `window.ethereum` wallets.
    enableEIP6963: true,
    enableInjected: true,
    allWallets: "SHOW",
    themeMode: "light",
  });

  return adapter.wagmiConfig;
}

function injectedOnlyConfig(): Config {
  return createConfig({
    chains: [townChain],
    // Without this a browser with three EIP-6963 wallets would show one generic
    // "Injected" entry. This is the automatic detection half of the feature.
    multiInjectedProviderDiscovery: true,
    connectors: [injected()],
    transports: { [townChain.id]: http(SETTLEMENT_CHAIN.rpcUrl) },
  });
}

export const wagmiConfig = walletConfigured ? appKitConfig() : injectedOnlyConfig();
