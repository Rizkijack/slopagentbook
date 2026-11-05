import { describe, it, expect } from "vitest";
import { CHORDS, ARP_TONES, chordAt, hz } from "../src/audio/soundtrack.js";

// The soundtrack is generated, so its "content" is a chord table. These checks
// pin the two things a listener would notice immediately if they broke: the
// loop never runs out of chords, and every tone is an audible pitch.
describe("generated soundtrack", () => {
  it("advances through all four chords and wraps", () => {
    expect([0, 1, 2, 3].map((b) => chordAt(b).name)).toEqual(CHORDS.map((c) => c.name));
    expect(chordAt(4).name).toBe(CHORDS[0]!.name);
    expect(chordAt(41).name).toBe(CHORDS[1]!.name);
  });

  it("keeps a negative bar index inside the loop", () => {
    expect(chordAt(-1).name).toBe(CHORDS[CHORDS.length - 1]!.name);
  });

  it("puts every pad tone in the audible bass-to-mid range", () => {
    for (const chord of CHORDS) {
      for (const tone of chord.tones) {
        const f = hz(tone);
        expect(f).toBeGreaterThan(60);
        expect(f).toBeLessThan(1200);
      }
    }
  });

  it("keeps the arpeggio above the pad", () => {
    expect(Math.min(...ARP_TONES)).toBeGreaterThanOrEqual(0);
    expect(hz(Math.min(...ARP_TONES))).toBeGreaterThanOrEqual(440);
  });
});
