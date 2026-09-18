/**
 * RUNE PRESSURE - all balance and feel tunables live here.
 * Nothing in this file imports anything, so it is safe to load in Node for tests.
 *
 * Coordinate system: arena world units, origin top-left, +y is DOWN
 * (matching canvas and touch input, so no flips exist anywhere in the codebase).
 */

/** Fixed logical arena. The renderer letterboxes this into any screen size. */
export const WORLD = { w: 960, h: 540 };

export const PLAYER = {
  radius: 15,
  speed: 232, // world units / second
  maxHp: 100,
  maxMana: 100,
  manaRegen: 19, // per second
  contactGrace: 0.45,
};

export const TIME = {
  normal: 1,
  /** A brief flourish of slow motion as a spell discharges. Purely for feel. */
  resolving: 0.55,
  resolveSlowDur: 0.16, // seconds of real time
  hitStop: 0.05, // freeze frames on a big hit
  maxFrame: 1 / 30, // clamp so an alt-tab never tunnels entities through walls
};

/**
 * The movement stick.
 *
 * This was originally digital: any travel past a tiny dead zone meant full
 * speed, so the mage had exactly two states - standing still, or sprinting at
 * 232 units/second. That reads as uncontrollable, because you cannot creep up on
 * a brute, ease off a wall, or make a small correction while holding a line.
 *
 * It is now properly analog: deflection sets speed continuously from 0 to 100%
 * across the radius, so the whole control has a usable range.
 */
export const STICK = {
  radiusFrac: 0.16, // of the smaller screen dimension...
  radiusMin: 58, // ...clamped, so it is thumb-sized on every device
  radiusMax: 116,
  /** Fraction of the radius where the mage stands perfectly still. Big enough
   *  that a resting thumb does not cause drift. */
  deadZone: 0.18,
  /**
   * Response curve applied to the deflection past the dead zone.
   *   1.0 = linear
   *   < 1 = biased toward the low end, for finer control near the centre
   *   0   = digital (full speed the instant you leave the dead zone)
   */
  response: 0.85,
};

/**
 * The element wheel - the new spell mechanism.
 *
 * Tapping the centre fires SPARK (weak, auto-aimed, always available).
 * Tapping the four outer circles in a recipe order casts a real spell.
 *
 * Note there is no "drawing" slow-motion any more. The wheel does not occupy
 * your eyes the way a freehand stroke did, and removing it sharpens the central
 * decision: SPARK now, or spend three taps on something that actually hurts?
 */
export const WHEEL = {
  centerXFrac: 0.73, // centre of the casting half of the screen
  centerYFrac: 0.5,
  ringRadiusFrac: 0.245, // of the smaller screen dimension...
  ringRadiusMin: 72, // ...clamped, so it is thumb-sized on every device
  ringRadiusMax: 138,
  elementRadiusFrac: 0.44, // of the ring radius
  focusRadiusFrac: 0.42, // of the ring radius
  hitPadding: 1.16, // extra forgiveness on the tap targets
  iconScale: 0.62,
};

export const SEQUENCE = {
  maxLength: 3,
  /** Lock-out after a tap that cannot lead to any spell. Costs time, not HP. */
  breakLock: 0.45,
  /** An abandoned partial sequence quietly dissolves after this long. */
  idleTimeout: 3.0,
  /** Minimum gap between centre-circle shots, so SPARK cannot be spammed. */
  sparkCooldown: 0.22,
  /** Ring pulse drawn outward when a sequence breaks. */
  breakFlashDur: 0.35,
};

/**
 * Haptic feedback.
 *
 * The wheel is a rhythm control you operate while watching the arena, so a tap
 * has to confirm itself through the thumb rather than the eye. Durations are
 * short on purpose: a 3-tap recipe fires three separate ticks, and anything
 * longer smears them into one buzz.
 *
 * `ms` is a single duration, or an on/off pattern like [30, 25, 60].
 * `cooldown` (seconds) is the minimum gap between repeats of that cue, which is
 * what keeps a fast combo feeling like three taps instead of one long rumble.
 *
 * NOTE: `navigator.vibrate` exists on Android browsers and does NOT exist on
 * iOS Safari at all. See src/haptics.js for the native-shell path.
 */
export const HAPTICS = {
  enabledByDefault: true,
  /** Duration multiplier. 0.5 is subtle, 1 authored, 1.4 emphatic. */
  strength: 1,
  cues: {
    // ── the wheel ──────────────────────────────────────────────────────────
    tick: { ms: 11, cooldown: 0.026 }, // element accepted
    spark: { ms: 8, cooldown: 0.03 }, // centre circle: lighter than an element
    break: { ms: [26, 42, 26], cooldown: 0.14 }, // wrong tap: a double thud
    fizzle: { ms: [8, 32, 8, 32, 8], cooldown: 0.24 }, // not enough mana: a dud
    castLight: { ms: 18, cooldown: 0.05 }, // heal
    castMed: { ms: 30, cooldown: 0.06 }, // fireball, waterball
    castHeavy: { ms: [36, 24, 62], cooldown: 0.1 }, // explosion, freeze
    // ── the fight ──────────────────────────────────────────────────────────
    kill: { ms: 12, cooldown: 0.04 },
    hit: { ms: [22, 14, 34], cooldown: 0.12 },
    // ── the run ────────────────────────────────────────────────────────────
    waveStart: { ms: [12, 45, 22], cooldown: 0.5 },
    waveClear: { ms: [12, 40, 12, 40, 34], cooldown: 0.6 },
    overtime: { ms: [46, 52, 46, 52, 46], cooldown: 0.7 },
    death: { ms: [95, 50, 180], cooldown: 1 },
  },
};

export const WAVE = {
  firstDelay: 1.6,
  intermission: 3.6,
  baseTimer: 36,
  timerStep: 1.35,
  minTimer: 15,
  baseCount: 3,
  countStep: 0.85,
  maxAlive: 22,
  clearBonus: 250,
  overtimeDamage: 11,
  overtimeTimer: 12,
  overtimeSpawns: 2,
  spawnMargin: 46,
  minSpawnDist: 210,
};

export const ENEMY = {
  shade: {
    hp: 20,
    speed: 108,
    radius: 14,
    contactDps: 16,
    armor: 0,
    color: '#ff5c7a',
    score: 50,
  },
  wisp: {
    hp: 14,
    speed: 74,
    radius: 12,
    contactDps: 4,
    armor: 0,
    color: '#c58bff',
    score: 70,
    standoff: 250,
    fireInterval: 2.5,
    boltSpeed: 205,
    boltDamage: 9,
    boltRadius: 8,
  },
  brute: {
    hp: 78,
    speed: 58,
    radius: 27,
    contactDps: 26,
    armor: 0.4,
    color: '#ffa33d',
    score: 160,
  },
};

/** Wave composition table. Returns how many of each type to spawn. */
export function waveComposition(wave) {
  const total = Math.min(WAVE.maxAlive, Math.round(WAVE.baseCount + (wave - 1) * WAVE.countStep + Math.floor(wave / 3)));
  const brutes = wave >= 4 ? Math.floor((wave - 1) / 3) : 0;
  const wisps = wave >= 2 ? Math.min(Math.floor(wave / 2) + 1, Math.max(0, total - brutes - 1)) : 0;
  const shades = Math.max(1, total - brutes - wisps);
  return { shade: shades, wisp: wisps, brute: brutes, total: shades + wisps + brutes };
}

export function waveTimer(wave) {
  return Math.max(WAVE.minTimer, WAVE.baseTimer - (wave - 1) * WAVE.timerStep);
}

/** Rendering / juice tunables. */
export const FX = {
  shakeDecay: 6.2,
  maxParticles: 420,
};

export const UI = {
  /** Fraction of screen width reserved for the casting half. */
  castZoneX: 0.46,
  layout: {
    barW: 232,
    barH: 16,
    pad: 18,
  },
};
