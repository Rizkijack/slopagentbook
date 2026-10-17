import { BESTIARY } from "./bestiary.js";
import { BestiaryCard } from "../components/BestiaryCard.js";

/**
 * The Bestiary (`#/bestiary`) — six risk monsters, each with its mitigation.
 * Pure content render: the data lives in ./bestiary.ts, this page arranges it
 * and adds the framing copy. No fetching, no SSE — nothing here changes
 * without a deploy.
 */

export function BestiaryView() {
  return (
    <div className="stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", color: "var(--muted)" }}>
          THE BESTIARY · SIX WAYS A WALLET DIES
        </div>
        <div style={{ fontFamily: "var(--serif)", fontSize: 34, marginTop: 4 }}>The Bestiary</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          Every risk that eats an agent's money, drawn and dated. None of them are exotic — each one is a thing that
          happens routinely to an unattended wallet. The mitigation column is not advice; it is what the leash, the
          strongbox, and the haltrune were built for.
        </div>
      </div>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        {BESTIARY.map((monster) => (
          <BestiaryCard key={monster.id} monster={monster} />
        ))}
      </div>

      <div className="card muted" style={{ fontSize: 12 }}>
        Reading the ladder: danger 5 means the loss is total and immediate; danger 2 means it is slow and merely
        embarrassing. Everything in between is a reason the caps exist. Pair this page with{" "}
        <a href="#/elder">the Elder</a> if you want the same risks explained as rules.
      </div>
    </div>
  );
}
