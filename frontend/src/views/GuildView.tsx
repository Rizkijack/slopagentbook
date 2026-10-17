import { useState, type FormEvent } from "react";

// Early access (blueprint §5.1): email, the role you would come as, and a
// honeypot. The honeypot is a visually-hidden field a real visitor's autofill
// never touches; a filled one means a script, and the form then reports success
// without sending anything anywhere. It must never block a genuine submission
// and the hidden field's value never leaves the browser.

const ROLES = ["keeper", "caller", "artificer", "just curious"];

export function GuildView() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(ROLES[0]!);
  const [company, setCompany] = useState(""); // honeypot
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  const [error, setError] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (company.trim() !== "") {
      // A script filled the hidden field. Answer as a human would and send
      // nothing — no request, no stored address.
      setState("sent");
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setState("error");
      setError("That address does not look like an email.");
      return;
    }
    // There is no mailing endpoint on the rail yet, so this stays honest: the
    // form confirms locally and says exactly what it did and did not do.
    setState("sent");
    setError("");
  }

  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          EARLY ACCESS
        </div>
        <div style={{ fontFamily: "Jacquard 24", fontSize: 30, marginTop: 4 }}>Join the Guild</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          The town is small on purpose. Say who you would come as and we will open a door when there is one worth
          opening.
        </div>

        <form onSubmit={submit} style={{ marginTop: 14, display: "grid", gap: 10, maxWidth: 420 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)" }}>EMAIL</span>
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (state !== "idle") setState("idle"); }}
              placeholder="you@example.com"
              autoComplete="email"
              className="mono"
              style={{ padding: "6px 8px", fontSize: 13 }}
            />
          </label>

          <label style={{ display: "grid", gap: 4 }}>
            <span className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)" }}>ROLE</span>
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ padding: "6px 8px", fontSize: 13 }}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>

          {/* Honeypot: off-screen and aria-hidden so no person or assistive
              technology ever reaches it, but a autofilling bot still will. */}
          <div
            aria-hidden
            style={{ position: "absolute", left: "-9999px", width: 1, height: 1, overflow: "hidden" }}
          >
            <label>
              Company
              <input
                type="text"
                name="company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                tabIndex={-1}
                autoComplete="off"
              />
            </label>
          </div>

          <div>
            <button type="submit" className="btn">Request a place</button>
          </div>

          {state === "sent" && (
            <div className="mono" style={{ fontSize: 11, color: "var(--profit)" }}>
              Noted. Nothing was sent anywhere — the rail has no mailing list yet, so this is a local confirmation
              only.
            </div>
          )}
          {state === "error" && (
            <div className="mono" style={{ fontSize: 11, color: "var(--halt)" }}>{error}</div>
          )}
        </form>

        <div className="muted mono" style={{ fontSize: 11, marginTop: 12 }}>
          coming as {role}
        </div>
      </div>
    </div>
  );
}
