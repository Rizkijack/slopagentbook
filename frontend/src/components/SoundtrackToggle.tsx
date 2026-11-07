import { useEffect, useRef, useState } from "react";
import { Soundtrack } from "../audio/soundtrack";

const STORAGE_KEY = "slab.soundtrack";

/**
 * The soundtrack control.
 *
 * Off by default and always click-to-start: every browser blocks audio that
 * begins without a gesture, and a town that makes noise on load is worse than
 * one that does not. The choice is remembered, but a remembered "on" still
 * needs this click the first time the page is opened in a session — that is the
 * gesture the browser wants, not a bug.
 */
export function SoundtrackToggle() {
  const player = useRef<Soundtrack | null>(null);
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "on";
    setReady(saved);
    return () => player.current?.stop();
  }, []);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  }, [on]);

  const toggle = async () => {
    if (!player.current) player.current = new Soundtrack();
    if (on) {
      player.current.stop();
      setOn(false);
      return;
    }
    await player.current.start();
    setOn(true);
  };

  return (
    <button
      type="button"
      className={"soundtrack mono" + (on ? " soundtrack--on" : "")}
      onClick={() => void toggle()}
      aria-pressed={on}
      aria-label={on ? "Mute the town soundtrack" : "Play the town soundtrack"}
      title={
        !ready
          ? "Generated in the browser — no track, no licence"
          : on
            ? "Mute the town soundtrack"
            : "Play the town soundtrack (generated, royalty-free)"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        fontSize: 10,
        whiteSpace: "nowrap",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: on ? "var(--accent)" : "var(--muted)",
        background: "transparent",
        border: `1px solid ${on ? "color-mix(in srgb, var(--accent) 55%, var(--hair))" : "var(--hair)"}`,
        borderRadius: 999,
        cursor: "pointer",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>
        {on ? "◉" : "◎"}
      </span>
      {on ? "sound on" : "sound off"}
    </button>
  );
}
