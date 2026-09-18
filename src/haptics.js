/**
 * RUNE PRESSURE - haptic feedback.
 *
 * The element wheel is a rhythm control that you operate while your eyes are on
 * the arena, not on your thumb. A tap therefore has to confirm itself through
 * touch: without it, a mis-tap is silent and you only find out when the spell
 * you were building fails to appear.
 *
 * ── Platform reality ────────────────────────────────────────────────────────
 * This uses the Web Vibration API, which exists on Android browsers and does
 * NOT exist on iOS Safari at all. There is no web workaround worth shipping
 * (the old `<input switch>` trick fires once per interaction and is deeply
 * unreliable). For iOS you need the native shell - see `setDriver` below.
 *
 * ── Native shells (Capacitor) ───────────────────────────────────────────────
 * `setDriver` swaps the backend without touching game code. With
 * `@capacitor/haptics` installed, the driver is:
 *
 *   import { Haptics as NativeHaptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
 *   const heavy = new Set(['castHeavy', 'death', 'overtime']);
 *   const error = new Set(['break', 'fizzle']);
 *   haptics.setDriver(async (name) => {
 *     if (error.has(name)) return NativeHaptics.notification({ type: NotificationType.Error });
 *     return NativeHaptics.impact({
 *       style: heavy.has(name) ? ImpactStyle.Heavy
 *            : name === 'tick' || name === 'spark' ? ImpactStyle.Light
 *            : ImpactStyle.Medium,
 *     });
 *   });
 *
 * Drivers receive the cue NAME as well as the expanded durations, precisely so a
 * native backend can map to its own vocabulary of impact styles instead of
 * imitating a millisecond pattern.
 */

import { HAPTICS } from './config.js';

/** Game event -> haptic cue. Single source of truth, shared with the tests. */
export const EVENT_CUE = {
  element: 'tick',
  spark: 'spark',
  'sequence-break': 'break',
  fizzle: 'fizzle',
  kill: 'kill',
  'player-hit': 'hit',
  'wave-start': 'waveStart',
  'wave-clear': 'waveClear',
  overtime: 'overtime',
  death: 'death',
};

/** Cast cue by spell, so power is felt and not just read off the mana bar. */
export const CAST_CUE = {
  spark: 'spark',
  heal: 'castLight',
  fireball: 'castMed',
  waterball: 'castMed',
  explosion: 'castHeavy',
  freeze: 'castHeavy',
};

const MIN_MS = 4;
/** The Vibration API treats 0 as "cancel everything", so a duration must never
 *  round down to zero. */
function safeDuration(ms, strength) {
  return Math.max(MIN_MS, Math.round(ms * strength));
}

/** Web Vibration API backend. */
function webVibrationDriver(name, durations) {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  try {
    // A single-element pattern is passed as a number; anything longer must be
    // an array, or the browser reads it as one long buzz.
    const pattern = durations.length === 1 ? durations[0] : durations;
    return navigator.vibrate(pattern) !== false;
  } catch {
    return false;
  }
}
webVibrationDriver.available = () =>
  typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

export class Haptics {
  constructor(opts = {}) {
    this.driver = opts.driver ?? webVibrationDriver;
    this.enabled = opts.enabled ?? HAPTICS.enabledByDefault;
    this.strength = opts.strength ?? HAPTICS.strength;
    /** Injectable clock, so tests can exercise cooldowns without sleeping. */
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.lastPlayed = new Map();
    this.plays = 0;
    this.suppressed = 0;
  }

  /** True when some backend can actually produce feedback on this device. */
  get supported() {
    return this.driver === webVibrationDriver ? webVibrationDriver.available() : true;
  }

  /** Swap the backend (native shell, or a test double). */
  setDriver(driver) {
    this.driver = driver ?? webVibrationDriver;
    return this;
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.cancel();
    return this.enabled;
  }

  /** Stop any pattern still running - used when muting mid-buzz. */
  cancel() {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(0);
    } catch {
      /* ignore */
    }
    this.lastPlayed.clear();
  }

  /** Expand a cue into the durations that will be handed to the driver. */
  durationsFor(name) {
    const cue = HAPTICS.cues[name];
    if (!cue) return null;
    const raw = Array.isArray(cue.ms) ? cue.ms : [cue.ms];
    return raw.map((ms) => safeDuration(ms, this.strength));
  }

  /**
   * Fire a cue, rate-limited.
   *
   * The cooldown is what makes a fast 3-tap recipe read as three distinct ticks
   * rather than one continuous rumble: without it, replays arrive faster than
   * the actuator can settle and the whole sequence blurs into a mush.
   *
   * @returns {boolean} whether the driver was actually invoked
   */
  play(name) {
    if (!this.enabled) {
      this.suppressed += 1;
      return false;
    }
    const cue = HAPTICS.cues[name];
    if (!cue) return false;

    const t = this.now();
    const last = this.lastPlayed.get(name);
    if (last !== undefined && (t - last) / 1000 < cue.cooldown) {
      this.suppressed += 1;
      return false;
    }
    this.lastPlayed.set(name, t);

    const durations = this.durationsFor(name);
    const ok = this.driver(name, durations) !== false;
    if (ok) this.plays += 1;
    return ok;
  }

  /** Fire without rate limiting. Only for cues that must never be dropped. */
  playNow(name) {
    if (!this.enabled) return false;
    const durations = this.durationsFor(name);
    if (!durations) return false;
    const ok = this.driver(name, durations) !== false;
    if (ok) this.plays += 1;
    return ok;
  }

  /** Convenience for the event stream: map a game event to its cue. */
  playForEvent(ev) {
    if (ev.type === 'cast') return this.play(CAST_CUE[ev.spell] ?? 'castMed');
    const cue = EVENT_CUE[ev.type];
    return cue ? this.play(cue) : false;
  }
}
