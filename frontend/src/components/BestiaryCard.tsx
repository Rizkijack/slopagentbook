import type { Monster } from "../views/bestiary.js";
import { dangerLabel } from "../views/bestiary.js";

/**
 * One monster card for the Bestiary page: pixel sprite, name, danger level,
 * mitigation. The sprite is drawn from the data module's 8×8 grid as SVG so
 * the icon scales without an asset, and every colour comes from theme tokens —
 * a hardcoded hex here would break whichever of the three themes it wasn't
 * picked for.
 */

/** Danger → token. Low danger stays quiet; the top of the ladder reads as danger. */
function dangerColor(danger: number): string {
  if (danger >= 5) return "var(--danger)";
  if (danger >= 3) return "var(--halt)";
  return "var(--accent)";
}

function MonsterSprite({ sprite }: { sprite: string[] }) {
  const cells: { x: number; y: number }[] = [];
  sprite.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "#") cells.push({ x, y });
    }
  });
  return (
    <svg
      viewBox="0 0 8 8"
      width={44}
      height={44}
      aria-hidden="true"
      focusable="false"
      style={{ imageRendering: "pixelated", flexShrink: 0, color: "var(--ink-2)" }}
    >
      {cells.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width={1} height={1} fill="currentColor" />
      ))}
    </svg>
  );
}

export function BestiaryCard({ monster }: { monster: Monster }) {
  const color = dangerColor(monster.danger);
  return (
    <div className="card" data-monster={monster.id} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      <MonsterSprite sprite={monster.sprite} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{monster.name}</div>
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color,
              border: `1px solid ${color}`,
              padding: "1px 6px",
              borderRadius: 10,
            }}
          >
            danger {monster.danger}/5 · {dangerLabel(monster.danger)}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.55 }}>
          {monster.mitigation}
        </div>
      </div>
    </div>
  );
}
