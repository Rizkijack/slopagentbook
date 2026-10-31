import { useEffect, useRef, useState } from "react";
import type { TownSnapshot, Resident, Post, Quest } from "@slopagentbook/shared";

/**
 * Apply one SSE `order` to the snapshot — pure, so the thinking HUD logic can
 * be tested without an EventSource. A **present** string wins, including a blank
 * one: the current server always sends `skill`/`why` ("" = no skill) and a blank
 * must clear the stale label instead of keeping it. Key **absent** = an order
 * from a server that predates the fields → keep what the snapshot already has.
 */
export function patchOrder(prev: TownSnapshot, ev: Record<string, unknown>): TownSnapshot {
  const { id, act, place } = ev as { id: string; act: string; place: string };
  const skill = typeof ev.skill === "string" ? ev.skill : undefined;
  const why = typeof ev.why === "string" ? ev.why : undefined;
  return {
    ...prev,
    herd: prev.herd.map((h) =>
      h.id === id
        ? {
            ...h,
            mind: {
              ...h.mind,
              doing: {
                ...h.mind.doing,
                act,
                place,
                placeName: place,
                since: Date.now(),
                ...(skill !== undefined ? { skill } : {}),
                ...(why !== undefined ? { why } : {}),
              },
            },
          }
        : h
    ),
  } as TownSnapshot;
}

/**
 * One SSE event folded into a snapshot — the pure half of the old `apply`
 * switch, so the coalesced commit below can walk a burst of events through a
 * single setState and the tests can drive any case without an EventSource.
 */
export function applyEvent(prev: TownSnapshot, ev: Record<string, unknown>): TownSnapshot {
  switch (ev.type as string) {
    case "order":
      return patchOrder(prev, ev);
    case "post": {
      const post = (ev as { post: Post }).post;
      return { ...prev, feed: [post, ...prev.feed].slice(0, 400) } as TownSnapshot;
    }
    case "llama": {
      const llama = (ev as { llama: Resident }).llama;
      const exists = prev.herd.some((h) => h.id === llama.id);
      return {
        ...prev,
        herd: exists ? prev.herd.map((h) => (h.id === llama.id ? llama : h)) : [...prev.herd, llama],
      } as TownSnapshot;
    }
    case "herd": {
      const herd = (ev as { herd: Resident[] }).herd;
      return { ...prev, herd } as TownSnapshot;
    }
    case "edition": {
      const edition = (ev as { edition: TownSnapshot["editions"][number] }).edition;
      return { ...prev, editions: [edition, ...prev.editions] } as TownSnapshot;
    }
    case "event": {
      const event = (ev as { event: TownSnapshot["events"][number] }).event;
      return { ...prev, events: [...prev.events, event].slice(-120) } as TownSnapshot;
    }
    case "quest": {
      const quest = (ev as { quest: Quest }).quest;
      const exists = prev.quests?.some((q) => q.id === quest.id);
      if (exists) {
        return { ...prev, quests: prev.quests.map((q) => (q.id === quest.id ? quest : q)) } as TownSnapshot;
      }
      return { ...prev, quests: [...(prev.quests ?? []), quest].slice(-12) } as TownSnapshot;
    }
    default:
      return prev;
  }
}

export function useTown() {
  const [state, setState] = useState<TownSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const pending = useRef<unknown[]>([]);
  const ready = useRef(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    // --- coalesced commit --------------------------------------------------
    // Every SSE message used to be its own setState, and the server tick lands
    // orders in clumps every TURN_MS (1.8s on the backend, 3-5 per burst in
    // cron mode) — so TownView (leaderboard, chat board, rail) re-rendered
    // several times in one clump, on the same cadence as the map's periodic
    // jank. Events now queue and commit in one setState per flush window.
    // The canvas never waits on this: its orders ride the hermes:* window
    // events, dispatched the moment each message arrives.
    const queued: Record<string, unknown>[] = [];
    let flushScheduled = false;
    const flush = () => {
      flushScheduled = false;
      if (closed || queued.length === 0) return;
      const evs = queued.slice();
      queued.length = 0;
      setState((prev) => {
        if (!prev) return prev;
        let s = prev;
        for (const ev of evs) s = applyEvent(s, ev);
        return s;
      });
    };
    // setTimeout rather than rAF: it keeps draining when the tab is hidden
    // (throttled, but draining), so the queue cannot grow unbounded while the
    // page sits in a background tab. 50ms of staleness on a district count or
    // a thinking label is imperceptible.
    const schedule = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      setTimeout(flush, 50);
    };

    function apply(ev: Record<string, unknown>) {
      if (!ready.current) {
        pending.current.push(ev);
        return;
      }
      queued.push(ev);
      schedule();
    }

    async function boot() {
      // Start SSE first so pending queue captures events before snapshot
      try {
        es = new EventSource("/api/stream");
        es.onopen = () => setConnected(true);
        es.onerror = () => setConnected(false);
        es.onmessage = (e) => {
          try {
            apply(JSON.parse(e.data));
          } catch {}
        };
      } catch {
        setConnected(false);
      }

      try {
        const res = await fetch("/api/snapshot");
        const snap = (await res.json()) as TownSnapshot;
        if (closed) return;
        setState(snap);
        ready.current = true;
        for (const ev of pending.current) apply(ev as Record<string, unknown>);
        pending.current = [];
      } catch (e) {
        console.error("snapshot failed", e);
      }
    }

    boot();

    return () => {
      closed = true;
      if (es) es.close();
    };
  }, []);

  return { state, connected };
}
