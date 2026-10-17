import { useState } from "react";

// The kill switch (blueprint §5.2): one orange rune that halts a live vault and
// reads "Resume" once it is halted. #FF6B1A is the literal value the blueprint
// specifies for this control, so unlike every other colour in the app it does
// not follow a theme token — it is the single sanctioned exception.
export function HaltRune({ paused, onToggle, busyLabel = "…" }: {
  paused: boolean;
  onToggle: () => Promise<void>;
  busyLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onToggle();
    } catch (e) {
      setError(e instanceof Error ? e.message : "the rail refused");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="btn"
        data-testid="halt-rune"
        data-paused={paused ? "1" : "0"}
        disabled={busy}
        onClick={() => void run()}
        style={{
          borderColor: "#FF6B1A",
          color: "#FF6B1A",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? busyLabel : paused ? "Resume" : "Halt"}
      </button>
      {error && (
        <span className="mono" style={{ fontSize: 11, color: "var(--halt)" }}>{error}</span>
      )}
    </span>
  );
}
