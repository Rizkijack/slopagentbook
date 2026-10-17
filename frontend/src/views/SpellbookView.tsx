import { SPELLBOOK_INTRO, SPELLBOOK_SECTIONS, SPELLBOOK_STUB } from "./spellbook.js";
import type { SpellbookSection } from "./spellbook.js";

/**
 * The Spellbook (`#/spellbook`) — how to drive the BRAWL rail over HTTP, plus
 * the honest stub where the x402 SDK will go. Pure content render: the
 * snippets live in ./spellbook.ts, this page arranges them and adds the
 * framing copy. No fetching, no SSE — nothing here changes without a deploy.
 *
 * Every section carries its status line: LIVE for routes verified against
 * backend/src/brawl.ts, ILLUSTRATIVE for the settlement stub that has not
 * shipped. The stub banner sits above them all, NoticeView style — the page
 * never prints an address because there is no contract to print.
 */

export function SpellbookView() {
  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          THE SPELLBOOK · SDK GUIDE · READ THE STATUS LINE
        </div>
        <div style={{ fontFamily: "var(--serif)", fontSize: 34, marginTop: 4 }}>The Spellbook</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{SPELLBOOK_INTRO}</div>
      </div>

      <div className="card" style={{ borderLeft: "3px solid var(--danger)" }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)" }}>
          {SPELLBOOK_STUB.label}
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: "var(--danger)" }}>
          {SPELLBOOK_STUB.headline}
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>{SPELLBOOK_STUB.body}</div>
      </div>

      {SPELLBOOK_SECTIONS.map((section) => (
        <SectionCard key={section.id} section={section} />
      ))}

      <div className="card muted" style={{ fontSize: 12 }}>
        The rules behind these routes are told as dialog by <a href="#/elder">the Elder</a>, the chain facts sit on{" "}
        <a href="#/notice">the Notice Board</a>, and the token plus MCP client configs are issued on{" "}
        <a href="#/register">the Register page</a>. Twelve questions before you start are on <a href="#/faq">the FAQ</a>.
      </div>
    </div>
  );
}

/** One section: status line, heading, prose, and the snippet block. */
function SectionCard({ section }: { section: SpellbookSection }) {
  const live = section.status === "live";
  return (
    <div className="card">
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span
          className="mono"
          style={{ fontSize: 10, letterSpacing: "0.08em", color: live ? "var(--profit)" : "var(--halt)" }}
        >
          {live ? "● LIVE · VERIFIED ROUTE" : "○ ILLUSTRATIVE · NOT SHIPPED"}
        </span>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{section.title}</span>
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>{section.blurb}</div>
      <pre
        className="mono"
        style={{
          margin: "10px 0 0",
          background: "var(--mark)",
          border: "1px solid var(--hair)",
          padding: 10,
          borderRadius: 6,
          fontSize: 11,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          overflow: "auto",
        }}
      >
        {section.code}
      </pre>
    </div>
  );
}
