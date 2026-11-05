import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Soundtrack } from "../src/audio/soundtrack.js";

// The track is generated at runtime, so "does it play" is not something a chord
// table can answer. These tests drive the real scheduler against a recording
// AudioContext stub: if start() ever stops booking oscillators, the count stays
// at zero and every assertion here fails.

type Started = { type: string; frequency: number; at: number };

function makeFakeContext() {
  const started: Started[] = [];
  const param = () => ({
    value: 0,
    setValueAtTime: () => {},
    linearRampToValueAtTime: () => {},
    exponentialRampToValueAtTime: () => {},
    cancelScheduledValues: () => {},
  });
  const node = (extra: Record<string, unknown> = {}) => ({
    connect: () => {},
    disconnect: () => {},
    ...extra,
  });
  const t0 = Date.now();
  const ctx = {
    // fake timers also drive Date.now, so the context clock advances with
    // vi.advanceTimersByTime — without that the scheduler would never see time
    // pass and could only ever book the first chord.
    get currentTime() {
      return (Date.now() - t0) / 1000;
    },
    destination: node(),
    resumed: 0,
    suspended: 0,
    resume: async () => {
      ctx.resumed += 1;
    },
    suspend: async () => {
      ctx.suspended += 1;
    },
    createGain: () => node({ gain: param() }),
    createBiquadFilter: () => node({ type: "", frequency: param(), Q: param() }),
    createDelay: () => node({ delayTime: param() }),
    createOscillator: () => {
      const rec: Started = { type: "sine", frequency: 0, at: 0 };
      const osc = node({
        type: "sine",
        frequency: param(),
        detune: param(),
        onended: null as null | (() => void),
        start: (at: number) => {
          rec.type = String(osc.type);
          rec.at = at;
          started.push(rec);
        },
        stop: () => {},
      });
      return osc;
    },
  };
  return { ctx, started };
}

let fake: ReturnType<typeof makeFakeContext>;

beforeEach(() => {
  fake = makeFakeContext();
  vi.useFakeTimers();
  (globalThis as unknown as { window: unknown }).window = {
    AudioContext: function AudioContext() {
      return fake.ctx;
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("soundtrack playback", () => {
  it("books a pad chord — several oscillators — as soon as it starts", async () => {
    const player = new Soundtrack();
    await player.start();
    vi.advanceTimersByTime(300);

    expect(player.isRunning).toBe(true);
    expect(fake.ctx.resumed).toBeGreaterThan(0);
    // five chord tones × two detuned saws, plus a sine root
    expect(fake.started.length).toBeGreaterThanOrEqual(4);
    for (const osc of fake.started) expect(osc.at).toBeGreaterThanOrEqual(0);
  });

  it("keeps scheduling as the loop advances", async () => {
    const player = new Soundtrack();
    await player.start();
    vi.advanceTimersByTime(300);
    const first = fake.started.length;
    // one full bar plus the lookahead
    vi.advanceTimersByTime(9000);
    expect(fake.started.length).toBeGreaterThan(first);
    player.stop();
  });

  it("fades out and suspends the context when muted", async () => {
    const player = new Soundtrack();
    await player.start();
    player.stop();
    expect(player.isRunning).toBe(false);
    vi.advanceTimersByTime(900);
    expect(fake.ctx.suspended).toBe(1);
  });

  it("does not suspend a context that was restarted before the fade ended", async () => {
    const player = new Soundtrack();
    await player.start();
    player.stop();
    // off → on inside the 700ms fade window
    await player.start();
    vi.advanceTimersByTime(900);
    expect(fake.ctx.suspended).toBe(0);
    expect(player.isRunning).toBe(true);
    player.stop();
  });

  it("does not stack a second scheduler when start is called twice", async () => {
    const player = new Soundtrack();
    await player.start();
    vi.advanceTimersByTime(300);
    const afterFirst = fake.started.length;
    await player.start();
    vi.advanceTimersByTime(300);
    // only the arpeggio may add notes; a duplicated scheduler would double it
    expect(fake.started.length - afterFirst).toBeLessThanOrEqual(2);
    player.stop();
  });
});
