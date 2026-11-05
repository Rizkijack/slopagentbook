/**
 * Generative soundtrack — synthesised in the browser, not a recording.
 *
 * There is no audio file in this repo and no third-party track behind it: the
 * pads, bass and arpeggio are oscillators scheduled by Web Audio, so the
 * soundtrack carries no licence, no attribution requirement and no takedown
 * surface. It also costs nothing to ship — the whole piece is a few hundred
 * bytes of chord table.
 *
 * Sound starts only from a click (browsers refuse programmatic playback), so
 * `start()` is called by the toggle, never on mount.
 */

/** A minor, four bars. Semitone offsets from A4 (440 Hz). */
export const CHORDS: ReadonlyArray<{ name: string; tones: readonly number[] }> = [
  { name: "Am9", tones: [-12, -9, -5, -2, 2] },
  { name: "Fmaj7", tones: [-16, -12, -9, -5] },
  { name: "Cmaj7", tones: [-9, -5, -2, 2] },
  { name: "G6", tones: [-14, -10, -7, -5] },
];

/** A minor pentatonic, two octaves up from the pad — used for the arpeggio. */
export const ARP_TONES: readonly number[] = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22];

const A4 = 440;
export const hz = (semitone: number): number => A4 * Math.pow(2, semitone / 12);

/** Which chord is sounding `bars` bars into the loop. Pure, so it is testable. */
export function chordAt(bars: number): (typeof CHORDS)[number] {
  return CHORDS[((bars % CHORDS.length) + CHORDS.length) % CHORDS.length]!;
}

const BAR_SECONDS = 8;
const ARP_STEP = 0.5;

export class Soundtrack {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBarAt = 0;
  private nextArpAt = 0;
  private bars = 0;
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = this.ctx ?? new Ctor();
    this.ctx = ctx;
    await ctx.resume();

    if (!this.master) {
      const master = ctx.createGain();
      // Quiet on purpose: it is furniture behind the town, not a player.
      master.gain.value = 0;
      master.connect(ctx.destination);
      this.master = master;
    }
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setValueAtTime(this.master.gain.value, ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 2.5);

    this.bars = 0;
    this.nextBarAt = ctx.currentTime + 0.15;
    this.nextArpAt = ctx.currentTime + 1.5;
    this.running = true;
    // Lookahead scheduling: notes are booked a fraction of a second ahead so a
    // throttled timer never leaves a silent gap.
    this.timer = setInterval(() => this.schedule(), 250);
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ctx = this.ctx;
    const master = this.master;
    if (ctx && master) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
      // Suspending drops the oscillator clock entirely — a muted tab does not
      // keep burning CPU on a pad nobody can hear.
      setTimeout(() => void ctx.suspend().catch(() => {}), 700);
    }
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || !this.running) return;
    const ahead = ctx.currentTime + 0.6;

    while (this.nextBarAt < ahead) {
      this.playPad(chordAt(this.bars), this.nextBarAt);
      this.nextBarAt += BAR_SECONDS;
      this.bars += 1;
    }
    while (this.nextArpAt < ahead) {
      this.playArp(this.nextArpAt);
      this.nextArpAt += this.nextArpStep();
    }
  }

  private nextArpStep(): number {
    // Slight swing keeps the line from sounding like a metronome.
    return ARP_STEP * (Math.random() < 0.22 ? 0.75 : 1);
  }

  private playPad(chord: (typeof CHORDS)[number], at: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const duration = BAR_SECONDS * 1.12; // overlap so chords breathe into each other
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1150;
    filter.Q.value = 0.7;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.09, at + 2.2);
    gain.gain.linearRampToValueAtTime(0.06, at + duration - 2);
    gain.gain.linearRampToValueAtTime(0, at + duration);
    filter.connect(gain);
    gain.connect(master);

    for (const tone of chord.tones) {
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = hz(tone);
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(at);
        osc.stop(at + duration + 0.05);
      }
    }
    // Root an octave down, sine, so the chord has a floor.
    const bass = ctx.createOscillator();
    const bassGain = ctx.createGain();
    bass.type = "sine";
    bass.frequency.value = hz(chord.tones[0]! - 12);
    bassGain.gain.setValueAtTime(0, at);
    bassGain.gain.linearRampToValueAtTime(0.1, at + 1.2);
    bassGain.gain.linearRampToValueAtTime(0, at + duration);
    bass.connect(bassGain);
    bassGain.connect(master);
    bass.start(at);
    bass.stop(at + duration + 0.05);
  }

  private playArp(at: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const tone = ARP_TONES[Math.floor(Math.random() * ARP_TONES.length)]!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const delay = ctx.createDelay(1);
    const feedback = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.value = hz(tone);
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.05, at + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 1.4);

    delay.delayTime.value = 0.38;
    feedback.gain.value = 0.32;

    osc.connect(env);
    env.connect(master);
    env.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(master);

    osc.start(at);
    osc.stop(at + 1.5);
    const cleanup = () => {
      osc.disconnect();
      env.disconnect();
      delay.disconnect();
      feedback.disconnect();
    };
    osc.onended = cleanup;
  }
}
