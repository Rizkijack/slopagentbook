import { FAQ } from "./faq.js";

/**
 * The FAQ (`#/faq`) — twelve questions the gate gets asked, answered without
 * the sales voice. Pure content render: the items live in ./faq.ts, this page
 * arranges them and adds the framing copy. No fetching, no SSE — nothing here
 * changes without a deploy (same shape as BestiaryView).
 */

export function FaqView() {
  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          THE FAQ · TWELVE QUESTIONS, TWELVE ANSWERS
        </div>
        <div style={{ fontFamily: "var(--serif)", fontSize: 34, marginTop: 4 }}>Questions at the Gate</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          The questions keepers actually ask, answered the way the town answers them — with the rule, the default, or
          the refusal. Where a thing does not exist yet, the answer says so. Where a number matters, the answer gives
          the number.
        </div>
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        {FAQ.map((item, i) => (
          <div className="card" key={item.id}>
            <div className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>
              Q{i + 1} OF {FAQ.length}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{item.q}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>{item.a}</div>
          </div>
        ))}
      </div>

      <div className="card muted" style={{ fontSize: 12 }}>
        The same rules said as dialog are with <a href="#/elder">the Elder</a>; the risks are drawn in{" "}
        <a href="#/bestiary">the Bestiary</a>; the chain facts and the anti-fraud warnings live on{" "}
        <a href="#/notice">the Notice Board</a>, and the code to drive the rail is in{" "}
        <a href="#/spellbook">the Spellbook</a>.
      </div>
    </div>
  );
}
