import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { WalletMenuInner } from "../src/components/WalletMenuInner.js";

// The masthead wallet control. The plan for this file:
//  - disconnected, configured: one "Connect wallet" button that opens AppKit;
//  - disconnected, no project id: auto-detected browser wallets, nothing else;
//  - connected: the chip shows the address and NOTHING else, and clicking it
//    opens the wallet table whose Disconnect action runs the right API
//    (AppKit when configured, wagmi when not).
// The providers and both SDK hook sets are mocked: this is a UI contract test,
// not a WalletConnect transport test.

const h = vi.hoisted(() => ({
  configured: true,
  address: undefined as string | undefined,
  connectorName: undefined as string | undefined,
  connectors: [] as Array<{ uid: string; id: string; name: string }>,
  open: vi.fn(),
  connectAsync: vi.fn(() => Promise.resolve()),
  disconnectWagmi: vi.fn(() => Promise.resolve()),
  disconnectAppKit: vi.fn(() => Promise.resolve()),
}));

vi.mock("wagmi", () => ({
  WagmiProvider: ({ children }: { children: unknown }) => children,
  useAccount: () => ({
    address: h.address,
    chain: h.address ? { name: "Elysium Mainnet" } : undefined,
    connector: h.connectorName ? { name: h.connectorName } : undefined,
    isConnected: Boolean(h.address),
  }),
  useConnect: () => ({
    connectors: h.connectors,
    connectAsync: h.connectAsync,
    isPending: false,
  }),
  useDisconnect: () => ({ disconnectAsync: h.disconnectWagmi }),
}));

vi.mock("@tanstack/react-query", () => ({
  QueryClientProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("@reown/appkit/react", () => ({
  useAppKit: () => ({ open: h.open, close: () => Promise.resolve() }),
  useAppKitAccount: () => ({
    address: h.address,
    isConnected: Boolean(h.address),
    allAccounts: [],
  }),
  useAppKitNetwork: () => ({
    caipNetwork: h.address ? { name: "Elysium Mainnet" } : undefined,
  }),
  useWalletInfo: () => ({
    walletInfo: h.connectorName ? { name: h.connectorName } : undefined,
  }),
  useDisconnect: () => ({ disconnect: h.disconnectAppKit }),
  useAppKitTheme: () => ({ themeMode: "light", setThemeMode: () => undefined }),
}));

vi.mock("../src/store/useTheme.js", () => ({
  useTheme: () => ({
    theme: "light",
    next: "stone",
    toggle: () => undefined,
    set: () => undefined,
    isDark: false,
  }),
}));

vi.mock("../src/wallet/config.js", () => ({
  get walletConfigured() {
    return h.configured;
  },
  wagmiConfig: {},
  queryClient: {},
}));

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";

let host: HTMLDivElement;
let root: Root;

function renderMenu(): void {
  act(() => {
    root.render(createElement(WalletMenuInner));
  });
}

function connectButton(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(".wallet-connect");
}

function chip(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(".wallet-chip");
}

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  h.configured = true;
  h.address = undefined;
  h.connectorName = undefined;
  h.connectors = [];
  h.open.mockClear();
  h.connectAsync.mockClear();
  h.disconnectWagmi.mockClear();
  h.disconnectAppKit.mockClear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe("WalletMenu", () => {
  it("opens the full AppKit dialog when a Reown project id is configured", () => {
    renderMenu();
    expect(connectButton()?.textContent).toBe("Connect wallet");

    act(() => connectButton()!.click());
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  it("shows only the address when connected, and the chip opens the wallet table", () => {
    h.address = ADDRESS;
    h.connectorName = "MetaMask";
    renderMenu();

    expect(chip()?.textContent).toBe("0x1234…5678");
    expect(connectButton()).toBeNull();

    act(() => chip()!.click());
    const popover = host.querySelector(".wallet-popover");
    expect(popover).toBeTruthy();
    expect(popover!.textContent).toContain("MetaMask");
    expect(popover!.textContent).toContain(ADDRESS);
    expect(popover!.textContent).toContain("Elysium Mainnet");
    expect(popover!.querySelector(".wallet-disconnect")?.textContent).toBe("Disconnect");
  });

  it("disconnects through AppKit from the wallet table", async () => {
    h.address = ADDRESS;
    h.connectorName = "MetaMask";
    renderMenu();

    act(() => chip()!.click());
    const disconnect = host.querySelector<HTMLButtonElement>(".wallet-disconnect")!;
    await act(async () => {
      disconnect.click();
    });

    expect(h.disconnectAppKit).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".wallet-popover")).toBeNull();
  });

  it("without a project id, lists detected browser wallets and connects through wagmi", async () => {
    h.configured = false;
    h.connectors = [
      { uid: "wallet-1", id: "io.metamask", name: "MetaMask" },
      { uid: "wallet-2", id: "injected", name: "Injected" },
    ];
    renderMenu();

    act(() => connectButton()!.click());
    const popover = host.querySelector(".wallet-popover")!;
    expect(popover.textContent).toContain("MetaMask");
    // The generic pre-EIP-6963 connector is the same wallet twice — drop it.
    expect(popover.textContent).not.toContain("Injected");

    const metaMask = [...host.querySelectorAll<HTMLButtonElement>(".wallet-list button")].find(
      (b) => b.textContent === "MetaMask"
    )!;
    await act(async () => {
      metaMask.click();
    });
    expect(h.connectAsync).toHaveBeenCalledWith({ connector: h.connectors[0] });
  });

  it("disconnects a fallback connection through wagmi", async () => {
    h.configured = false;
    h.address = ADDRESS;
    h.connectorName = "MetaMask";
    renderMenu();

    act(() => chip()!.click());
    const disconnect = host.querySelector<HTMLButtonElement>(".wallet-disconnect")!;
    await act(async () => {
      disconnect.click();
    });

    expect(h.disconnectWagmi).toHaveBeenCalledTimes(1);
    expect(h.disconnectAppKit).not.toHaveBeenCalled();
  });
});
