/**
 * RUNE PRESSURE - synthesised audio.
 *
 * Every sound is generated with WebAudio oscillators and one shared noise
 * buffer, so the game ships with zero audio assets and still has impact.
 *
 * The four elements are pitched a fifth apart so that a recipe has a melody:
 * EARTH is the low root, FIRE the fourth, WATER the fifth, WIND the octave.
 * After an hour of play you can hear a wrong tap coming.
 *
 * Audio is strictly decorative: every entry point is wrapped so that a missing
 * or blocked AudioContext can never break the game loop.
 */

/** Element -> base frequency. Chosen so sequences have a recognisable tune. */
const ELEMENT_PITCH = {
  earth: 196, // G3
  fire: 262, // C4
  water: 392, // G4
  wind: 523, // C5
};

const CUES = {
  element: { cooldown: 0.02 },
  spark: { cooldown: 0.05 },
  fireball: { cooldown: 0.06 },
  waterball: { cooldown: 0.06 },
  heal: { cooldown: 0.1 },
  explosion: { cooldown: 0.12 },
  freeze: { cooldown: 0.12 },
  break: { cooldown: 0.12 },
  fizzle: { cooldown: 0.2 },
  kill: { cooldown: 0.03 },
  playerHit: { cooldown: 0.08 },
  waveStart: { cooldown: 0.5 },
  waveClear: { cooldown: 0.5 },
  overtime: { cooldown: 0.5 },
  death: { cooldown: 1 },
};

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.muted = false;
    this.available = false;
    this.lastPlayed = new Map();
  }

  /** Must be called from a user gesture on iOS/Android. Safe to call repeatedly. */
  resume() {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return false;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.34;
        this.master.connect(this.ctx.destination);

        const len = Math.floor(this.ctx.sampleRate * 0.6);
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        this.noiseBuffer = buf;
        this.available = true;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) {
      try {
        this.master.gain.value = this.muted ? 0 : 0.34;
      } catch {
        /* ignore */
      }
    }
    return this.muted;
  }

  /** One oscillator with an exponential pitch and amplitude envelope. */
  blip({ freq, freq2, dur = 0.15, type = 'triangle', gain = 0.3, delay = 0 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freq), t0);
    if (freq2 != null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + Math.min(0.02, dur * 0.25));
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** Filtered noise burst - impacts, fire, swooshes. */
  noise({ dur = 0.2, gain = 0.3, freq = 900, q = 1, type = 'lowpass', sweepTo = null, delay = 0 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    filter.Q.value = q;
    if (sweepTo != null) filter.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + dur);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(amp).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  play(name, opts = {}) {
    if (this.muted || !this.available || !this.ctx) return;
    const cue = CUES[name];
    if (cue?.cooldown) {
      const now = this.ctx.currentTime;
      const last = this.lastPlayed.get(name) ?? -Infinity;
      if (now - last < cue.cooldown) return;
      this.lastPlayed.set(name, now);
    }
    try {
      switch (name) {
        case 'element': {
          const f = ELEMENT_PITCH[opts.element] ?? 330;
          // Each tap in a longer recipe steps up, so a sequence builds.
          const step = 1 + (opts.index ?? 0) * 0.12;
          this.blip({ freq: f * step, freq2: f * step * 1.02, dur: 0.09, type: 'triangle', gain: 0.17 });
          break;
        }
        case 'spark':
          this.blip({ freq: 900, freq2: 380, dur: 0.07, type: 'square', gain: 0.12 });
          break;
        case 'fireball':
          this.noise({ dur: 0.3, gain: 0.3, freq: 1800, sweepTo: 220 });
          this.blip({ freq: 300, freq2: 70, dur: 0.32, type: 'sawtooth', gain: 0.2 });
          break;
        case 'waterball':
          this.blip({ freq: 520, freq2: 130, dur: 0.28, type: 'sine', gain: 0.26 });
          this.noise({ dur: 0.24, gain: 0.2, freq: 700, sweepTo: 180, type: 'bandpass', q: 1.8 });
          break;
        case 'heal':
          [523, 659, 784].forEach((f, i) =>
            this.blip({ freq: f, dur: 0.34, gain: 0.18, delay: i * 0.07, type: 'sine' }),
          );
          break;
        case 'explosion':
          this.noise({ dur: 0.55, gain: 0.38, freq: 2400, sweepTo: 80 });
          this.blip({ freq: 170, freq2: 32, dur: 0.65, type: 'sine', gain: 0.36 });
          this.blip({ freq: 1500, freq2: 380, dur: 0.28, type: 'triangle', gain: 0.13 });
          break;
        case 'freeze':
          this.blip({ freq: 660, freq2: 1980, dur: 0.4, type: 'sine', gain: 0.22 });
          this.blip({ freq: 990, freq2: 2500, dur: 0.36, type: 'sine', gain: 0.12, delay: 0.04 });
          this.noise({ dur: 0.42, gain: 0.14, freq: 4200, type: 'highpass' });
          break;
        case 'break':
          // A dull, unambiguous thud. Wrong, but not painful.
          this.blip({ freq: 180, freq2: 74, dur: 0.2, type: 'square', gain: 0.2 });
          this.noise({ dur: 0.14, gain: 0.16, freq: 420, sweepTo: 160 });
          break;
        case 'fizzle':
          this.blip({ freq: 340, freq2: 130, dur: 0.16, type: 'triangle', gain: 0.14 });
          break;
        case 'kill':
          this.blip({ freq: 420, freq2: 760, dur: 0.1, type: 'triangle', gain: 0.16 });
          this.noise({ dur: 0.1, gain: 0.12, freq: 1500, sweepTo: 300 });
          break;
        case 'playerHit':
          this.blip({ freq: 210, freq2: 90, dur: 0.18, type: 'square', gain: 0.2 });
          break;
        case 'waveStart':
          this.blip({ freq: 330, dur: 0.16, gain: 0.2 });
          this.blip({ freq: 494, dur: 0.22, gain: 0.2, delay: 0.14 });
          break;
        case 'waveClear':
          [523, 659, 784, 1047].forEach((f, i) =>
            this.blip({ freq: f, dur: 0.26, gain: 0.18, delay: i * 0.08, type: 'triangle' }),
          );
          break;
        case 'overtime':
          this.blip({ freq: 660, dur: 0.18, type: 'square', gain: 0.2 });
          this.blip({ freq: 494, dur: 0.24, type: 'square', gain: 0.2, delay: 0.16 });
          break;
        case 'death':
          this.blip({ freq: 300, freq2: 38, dur: 0.9, type: 'sawtooth', gain: 0.3 });
          this.noise({ dur: 0.7, gain: 0.22, freq: 800, sweepTo: 80 });
          break;
        default:
          break;
      }
    } catch {
      /* audio must never be able to crash the game */
    }
  }
}
