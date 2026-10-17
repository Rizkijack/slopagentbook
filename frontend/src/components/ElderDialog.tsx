import { useState } from "react";
import { ELDER_NODES, ELDER_START, elderNode } from "../views/elder.js";
import type { ElderNode } from "../views/elder.js";

/**
 * The Elder's dialog panel: a topic list beside the selected node's text.
 * Selection is local state — the branch happens on this page without routing,
 * exactly as blueprint §4.1 specifies ("dipilih di frontend tanpa pindah
 * halaman"). `next` links inside the text jump to other topics; unknown ids
 * are filtered out so a content typo degrades to a missing link, never a
 * crash.
 */

export function ElderDialog() {
  const [selected, setSelected] = useState<string>(ELDER_START);

  const current = elderNode(selected) ?? elderNode(ELDER_START) ?? ELDER_NODES[0];
  // Drop any `next` id that doesn't resolve — content is edited by hand.
  const branches = current.next
    .map((id) => elderNode(id))
    .filter((n): n is ElderNode => n !== undefined);

  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      {/* topic list */}
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          ASK THE ELDER
        </div>
        <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
          {ELDER_NODES.map((node) => {
            const active = node.id === current.id;
            return (
              <button
                key={node.id}
                type="button"
                className="btn btn-ghost"
                data-topic={node.id}
                aria-pressed={active}
                style={{
                  textAlign: "left",
                  textTransform: "none",
                  letterSpacing: "0.02em",
                  borderColor: active ? "var(--accent)" : "var(--hair)",
                  background: active ? "var(--mark)" : "transparent",
                  color: active ? "var(--ink)" : "var(--muted)",
                }}
                onClick={() => setSelected(node.id)}
              >
                {node.topic}
              </button>
            );
          })}
        </div>
      </div>

      {/* selected node's text */}
      <div className="card" data-node={current.id}>
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          THE ELDER SPEAKS
        </div>
        <div style={{ fontFamily: "var(--serif)", fontSize: 20, fontWeight: 700, marginTop: 6 }}>
          {current.topic}
        </div>
        <div className="muted" style={{ fontSize: 14, lineHeight: 1.65, marginTop: 10 }}>
          {current.text}
        </div>

        {branches.length > 0 && (
          <div style={{ marginTop: 16, borderTop: "1px solid var(--hair)", paddingTop: 12 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.1em", color: "var(--faint)" }}>
              AND ABOUT…
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {branches.map((branch) => (
                <button
                  key={branch.id}
                  type="button"
                  className="btn btn-ghost"
                  data-branch={branch.id}
                  style={{ padding: "4px 10px", fontSize: 11 }}
                  onClick={() => setSelected(branch.id)}
                >
                  {branch.topic} →
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
