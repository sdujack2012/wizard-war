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

import { versioned } from './assets.js';

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
  chargeFull: { cooldown: 0.4 },
  /**
   * Impacts: the sound of a spell ARRIVING.
   *
   * The game had none. A fireball connecting sounded exactly like one that flew
   * past, which is most of why casting felt like it happened in a different room
   * from the fight. Short cooldowns, because a burst of hits should rattle
   * rather than smear into one long noise.
   */
  hitFire: { cooldown: 0.035 },
  hitWater: { cooldown: 0.035 },
  hitIce: { cooldown: 0.035 },
  break: { cooldown: 0.12 },
  fizzle: { cooldown: 0.2 },
  kill: { cooldown: 0.03 },
  playerHit: { cooldown: 0.08 },
  waveStart: { cooldown: 0.5 },
  waveClear: { cooldown: 0.5 },
  overtime: { cooldown: 0.5 },
  death: { cooldown: 1 },
};

/**
 * The background track: an anime battle theme, generated for this game with
 * YuE2 (see README, "Music"). It is deliberately the ONE audio file the project
 * ships - every cue in this file is still synthesised at runtime, and the track
 * is streamed, decoded and looped through the same master gain, so mute and
 * volume apply to it for free.
 */
export const MUSIC = {
  // Versioned like the art: the track keeps its filename, so without this a
  // returning player would keep hearing the previous one for thirty days.
  src: versioned('./assets/bgm.mp3'),
  /** Under the cues: this is background, and the ticks carry information. */
  gain: 0.34,
  /** Fade-in, in seconds. A track that slams in on the first tap sounds broken. */
  fadeIn: 1.6,
};

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.muted = false;
    this.available = false;
    this.lastPlayed = new Map();
    /** Music state, exposed so a test can assert it without hearing anything. */
    this.musicBuffer = null;
    this.musicSource = null;
    this.musicState = 'idle'; // idle | loading | playing | failed | unsupported
  }

  /**
   * Fetch and loop the background track.
   *
   * Called from the first user gesture (same moment the context is unlocked),
   * because a browser will not start audio before one. Failure is contained: if
   * the file is missing or will not decode, the game plays on with its
   * synthesised cues and no music, which is exactly how it shipped before.
   */
  async loadMusic(src = MUSIC.src) {
    if (this.musicState === 'playing' || this.musicState === 'loading') return this.musicState;
    if (!this.available || !this.ctx || typeof fetch !== 'function') {
      this.musicState = 'unsupported';
      return this.musicState;
    }
    this.musicState = 'loading';
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      this.musicBuffer = await this.ctx.decodeAudioData(bytes);
    } catch {
      this.musicState = 'failed';
      return this.musicState;
    }
    if (this.muted) {
      // Loaded but muted: remember it so unmuting starts it.
      this.musicState = 'idle';
      return this.musicState;
    }
    this.startMusic();
    return this.musicState;
  }

  /** Start (or restart) the loop with a fade-in. */
  startMusic() {
    if (!this.musicBuffer || !this.ctx) return false;
    try {
      if (this.musicSource) {
        try {
          this.musicSource.stop();
        } catch {
          /* already stopped */
        }
      }
      const gain = this.ctx.createGain();
      const now = this.ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(MUSIC.gain, now + MUSIC.fadeIn);
      const src = this.ctx.createBufferSource();
      src.buffer = this.musicBuffer;
      src.loop = true;
      src.connect(gain).connect(this.master);
      src.start();
      this.musicSource = src;
      this.musicState = 'playing';
      return true;
    } catch {
      this.musicState = 'failed';
      return false;
    }
  }

  /** Stop the loop without unloading it. */
  stopMusic() {
    if (this.musicSource) {
      try {
        this.musicSource.stop();
      } catch {
        /* already stopped */
      }
      this.musicSource = null;
    }
    if (this.musicState === 'playing') this.musicState = 'idle';
  }

  /** Must be called from a user gesture on iOS/Android. Safe to call repeatedly. */
  resume() {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return false;
        this.attach(new Ctor());
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      // First gesture: bring the track in. Deliberately not awaited - the input
      // handler must not wait on a network fetch.
      if (this.musicState === 'idle' || this.musicState === 'unsupported') {
        void this.loadMusic();
      }
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  /** The shared noise buffer, built for whatever context is current. */
  buildNoise() {
    const len = Math.floor(this.ctx.sampleRate * 0.6);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  /**
   * Attach an already-created AudioContext and wire up the master gain.
   *
   * `resume()` uses this for a real context. A test uses it to render cues into
   * an OfflineAudioContext, which is the only way to demonstrate that a cue
   * makes a sound at all - and that two cues make DIFFERENT sounds - without a
   * human sitting there listening to them.
   */
  attach(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.34;
    this.master.connect(ctx.destination);
    this.buildNoise();
    this.available = true;
    return this;
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
  blip({ freq, freq2, dur = 0.15, type = 'triangle', gain = 0.3, delay = 0, filter = null }) {
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
    // An optional shaper. A lowpass makes a tone dull and woody, a bandpass
    // makes it hollow and wet - which is the whole difference between a thud and
    // a splash, so it is worth having on the primitive rather than on each cue.
    let tail = osc;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type ?? 'lowpass';
      f.frequency.setValueAtTime(Math.max(40, filter.freq ?? 900), t0);
      if (filter.sweepTo != null) {
        f.frequency.exponentialRampToValueAtTime(Math.max(40, filter.sweepTo), t0 + dur);
      }
      f.Q.value = filter.q ?? 1;
      tail.connect(f);
      tail = f;
    }
    tail.connect(amp).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /**
   * Two-operator FM: a carrier whose frequency is wobbled by a modulator.
   *
   * This is what makes a glassy or metallic tone, which a plain oscillator
   * cannot do. The index decays across the note, and that decay is the whole
   * trick - a static index buzzes, a decaying one rings like something struck.
   * The ice, the heal and the ice impacts all depend on it.
   */
  fm({ carrier = 880, ratio = 1.5, index = 400, dur = 0.5, gain = 0.18, delay = 0, type = 'sine' }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();

    mod.type = 'sine';
    mod.frequency.setValueAtTime(Math.max(20, carrier * ratio), t0);
    modGain.gain.setValueAtTime(Math.max(1, index), t0);
    modGain.gain.exponentialRampToValueAtTime(1, t0 + dur * 0.85);
    mod.connect(modGain).connect(osc.frequency);

    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, carrier), t0);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(this.master);

    mod.start(t0);
    osc.start(t0);
    mod.stop(t0 + dur + 0.02);
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
          // Every element also gets its own colour on the tap, so you can hear
          // WHICH circle you hit and not just that you hit one: fire is a rasp,
          // water is round and hollow, earth is dull, wind is thin and airy.
          const tint = {
            fire: { type: 'sawtooth', filter: { type: 'lowpass', freq: 2400, q: 0.7 } },
            water: { type: 'sine', filter: { type: 'lowpass', freq: 1200, q: 0.9 } },
            earth: { type: 'triangle', filter: { type: 'lowpass', freq: 520, q: 0.8 } },
            wind: { type: 'triangle', filter: { type: 'bandpass', freq: 2600, q: 1.6 } },
          }[opts.element] ?? { type: 'triangle', filter: null };
          this.blip({
            freq: f * step,
            freq2: f * step * 1.02,
            dur: 0.09,
            type: tint.type,
            gain: 0.17,
            filter: tint.filter,
          });
          break;
        }
        case 'chargeFull': {
          // The wind-up is ready. Two quick notes a fifth apart, quiet enough to
          // sit under the fight but bright enough to catch the ear.
          this.blip({ freq: 880, dur: 0.1, type: 'triangle', gain: 0.13 });
          this.blip({ freq: 1318, dur: 0.2, type: 'triangle', gain: 0.15, delay: 0.07 });
          break;
        }
        case 'spark': {
          // A charged release is the same voice with more behind it: lower,
          // longer and louder the further the thumb wound it up.
          const k = opts.charge ?? 0;
          this.blip({
            freq: 900 + k * 320,
            freq2: 380 - k * 170,
            dur: 0.07 + k * 0.13,
            type: 'square',
            gain: 0.12 + k * 0.1,
            filter: { type: 'bandpass', freq: 1400 + k * 900, q: 1.2 },
          });
          this.noise({ dur: 0.05 + k * 0.06, gain: 0.1 + k * 0.16, freq: 2600, sweepTo: 700, type: 'highpass' });
          // Past half charge it acquires a body, so a full wind-up is felt as
          // well as heard.
          if (k > 0.45) {
            const w = (k - 0.45) / 0.55;
            this.blip({ freq: 190, freq2: 54, dur: 0.2 + w * 0.2, type: 'sine', gain: 0.14 + w * 0.16 });
          }
          break;
        }
        case 'fireball':
          // Fire is a rasp over a falling body, with a crackle riding behind it.
          this.noise({ dur: 0.34, gain: 0.28, freq: 1700, sweepTo: 230, type: 'lowpass', q: 0.9 });
          this.blip({ freq: 320, freq2: 72, dur: 0.3, type: 'sawtooth', gain: 0.17, filter: { type: 'lowpass', freq: 1800, q: 1.1 } });
          this.noise({ dur: 0.22, gain: 0.1, freq: 2600, type: 'bandpass', q: 1.4, delay: 0.06 });
          break;
        case 'waterball':
          // Water is a hollow gulp with a wet edge, landed on a low thump.
          this.blip({ freq: 540, freq2: 128, dur: 0.3, type: 'sine', gain: 0.26, filter: { type: 'lowpass', freq: 900, q: 1.4 } });
          this.noise({ dur: 0.26, gain: 0.18, freq: 700, sweepTo: 180, type: 'bandpass', q: 2.2 });
          this.blip({ freq: 150, freq2: 70, dur: 0.16, type: 'triangle', gain: 0.14, delay: 0.02, filter: { type: 'lowpass', freq: 400 } });
          break;
        case 'heal':
          // Warm, and rising: a soft pad under a glass arpeggio that keeps
          // climbing, so the spell sounds like relief rather than impact.
          this.blip({ freq: 262, dur: 0.7, type: 'triangle', gain: 0.1, filter: { type: 'lowpass', freq: 900 } });
          [523, 659, 784].forEach((f, i) =>
            this.fm({ carrier: f, ratio: 2, index: 180, dur: 0.42, gain: 0.15, delay: i * 0.07 }),
          );
          this.blip({ freq: 1568, dur: 0.5, type: 'sine', gain: 0.05, delay: 0.14 });
          break;
        case 'explosion':
          // Three layers plus a transient, so it reads as one event rather than
          // a pile: a crack, a sub, a body, and a rumble that outlives them.
          this.noise({ dur: 0.05, gain: 0.22, freq: 2000, type: 'highpass' });
          this.blip({ freq: 155, freq2: 27, dur: 0.72, type: 'sine', gain: 0.4 });
          this.noise({ dur: 0.6, gain: 0.36, freq: 2400, sweepTo: 70, type: 'lowpass', q: 0.8 });
          this.blip({ freq: 110, freq2: 46, dur: 0.3, type: 'square', gain: 0.16, filter: { type: 'lowpass', freq: 500 } });
          this.noise({ dur: 0.5, gain: 0.12, freq: 300, type: 'lowpass', delay: 0.12 });
          break;
        case 'freeze':
          // Ice is FM: a struck-glass ring over a rising sine, with a scatter of
          // shards on top. This is the one spell that should sound like crystal
          // rather than like a noise burst.
          this.fm({ carrier: 1180, ratio: 2.4, index: 900, dur: 0.5, gain: 0.16 });
          this.blip({ freq: 660, freq2: 1980, dur: 0.42, type: 'sine', gain: 0.2 });
          this.fm({ carrier: 1760, ratio: 1.5, index: 500, dur: 0.36, gain: 0.1, delay: 0.05 });
          this.noise({ dur: 0.4, gain: 0.13, freq: 4200, type: 'highpass' });
          break;
        case 'hitFire':
          // Landing. Short, dry and bright - it has to cut through the music
          // without becoming the loudest thing on screen.
          this.noise({ dur: 0.13, gain: 0.26, freq: 3200, sweepTo: 420, type: 'lowpass', q: 0.9 });
          this.blip({ freq: 430, freq2: 120, dur: 0.12, type: 'sawtooth', gain: 0.16, filter: { type: 'lowpass', freq: 1400, q: 1.1 } });
          break;
        case 'hitWater':
          this.noise({ dur: 0.15, gain: 0.24, freq: 950, sweepTo: 320, type: 'bandpass', q: 2.4 });
          this.blip({ freq: 320, freq2: 95, dur: 0.14, type: 'sine', gain: 0.2, filter: { type: 'lowpass', freq: 800, q: 1.2 } });
          break;
        case 'hitIce':
          this.fm({ carrier: 1500, ratio: 2.8, index: 700, dur: 0.28, gain: 0.14 });
          this.noise({ dur: 0.14, gain: 0.16, freq: 3800, type: 'highpass' });
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
