import { useEffect, useState, type ComponentType } from "react";

// The wallet stack — AppKit, WalletConnect, wagmi and viem — is larger than the
// rest of this app's initial JS. It gets its own async chunk so first paint of
// the town never waits for a wallet library: the masthead button appears
// immediately and is swapped for the real control when the chunk arrives. The
// wagmi provider lives inside that chunk too, because the header is the only
// consumer of wallet state.
//
// A plain dynamic import rather than React.lazy on purpose. A rejected lazy
// import throws during render, and there is no error boundary above the shell —
// one bad wallet chunk would unmount the whole town. Here a failed import just
// leaves the control inert; the page it sits on keeps working.
let loaded: ComponentType | null = null;

export function WalletMenu() {
  const [Inner, setInner] = useState<ComponentType | null>(() => loaded);

  useEffect(() => {
    if (loaded) return;
    let alive = true;
    import("./WalletMenuInner.js")
      .then((m) => {
        loaded = m.WalletMenuInner;
        if (alive) setInner(() => m.WalletMenuInner);
      })
      .catch(() => {
        /* header control stays inert; the town is unaffected */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!Inner) {
    return (
      <button
        type="button"
        className="btn btn-ghost wallet-connect"
        aria-busy="true"
        disabled
      >
        Connect wallet
      </button>
    );
  }

  return <Inner />;
}
