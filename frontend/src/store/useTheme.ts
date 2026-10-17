import { useEffect, useState, useCallback } from "react";

// P0-6 / §6.3.1: tema jadi siklus 3 — parchment → stone → dark → parchment.
// stone = tema medieval (00 blueprint §6). Ditambahkan, bukan mengganti:
// "light" dan "dark" tetap nama yang sama, save lama tetap valid.
export type Theme = "light" | "stone" | "dark";

const NEXT: Record<Theme, Theme> = { light: "stone", stone: "dark", dark: "light" };

function getPreferred(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = localStorage.getItem("hermes:theme") as Theme | null;
  if (saved === "light" || saved === "stone" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getPreferred);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    // also set color-scheme for native inputs — "stone" is not a valid CSS
    // color-scheme keyword, and stone renders like night, so it maps to dark
    root.style.colorScheme = theme === "light" ? "light" : "dark";
    localStorage.setItem("hermes:theme", theme);
  }, [theme]);

  useEffect(() => {
    // listen to system changes if no explicit saved preference? we still respect saved, but also update if user hasn't manually toggled recently?
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      const saved = localStorage.getItem("hermes:theme");
      // only follow system if user hasn't manually set? we keep manual as override, but if they clear storage, follow system
      if (!saved) setTheme(e.matches ? "dark" : "light");
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => NEXT[t]);
  }, []);

  const set = useCallback((t: Theme) => setTheme(t), []);

  // isDark dipakai canvas engine (BUILD_INK.dark, ground gelap) — stone adalah
  // tema gelap, jadi termasuk "dark" di sini. K4: engine tetap nol perubahan.
  return { theme, next: NEXT[theme], toggle, set, isDark: theme === "dark" || theme === "stone" };
}
