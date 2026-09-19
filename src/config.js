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
/**
 * Movement animation: what makes a moving creature look like it is *walking*
 * rather than being dragged around on a tray.
 *
 * The walk cycle is driven by DISTANCE TRAVELLED, not by a clock. A clock keeps
 * ticking while a creature is pinned against a wall, is being shoved, or is
 * standing still with a key held, and the feet keep stepping on the spot. Tying
 * the cycle to strides means the legs move exactly as fast as the ground goes by,
 * which is the whole trick - and it costs nothing, because the simulation already
 * knows how far everything moved this frame.
 */
export const MOTION = {
  /**
   * World units per stride, per creature - one stride is two steps.
   *
   * This is the number that decides how fast the legs move, and it is a
   * compromise: the mage covers 232 units a second, so a physically honest
   * stride would put the feet through four and a half steps a second and read as
   * panicked scurrying. These values give roughly three steps a second at full
   * speed, which looks like running. Feet slipping slightly is the price; the
   * alternative - a fixed cadence - is the ice-skating this replaced.
   */
  stride: { wizard: 110, shade: 54, wisp: 70, brute: 48 },
  /** Vertical lift of the body at the top of each stride, as a fraction of R. */
  lift: 0.038,
  /**
   * How far the body tilts into its direction of travel, in radians, at full
   * speed. This was 0.16 rad and read as the character tipping over rather than
   * running: a 3/4-view figure pivots around its feet, not its middle.
   */
  lean: 0.075,
  /** Squash on the footfall and stretch between them, as a fraction of R. */
  squash: 0.03,
  /** Below this fraction of full speed there is no walk cycle at all: idle sway only. */
  moveThreshold: 0.18,
  /** Footfall dust: how many puffs per stride, and how many particles each. */
  dustPerStride: 2,
  dustParticles: 2,
};

/**
 * After-effects: what a spell leaves behind once the flash is over.
 *
 * A decal is inert - no damage, no slow, no collision - so this can never become
 * a stealth balance change. `ttl` is what makes it an after-effect rather than a
 * particle: the arena keeps the mark long after the ring has gone.
 */
export const DECAL = {
  /** Hard cap on live decals. The oldest is dropped, so a long run cannot creep. */
  max: 26,
  /**
   * Scorch and rime radii, tuned for a BRIGHT arena.
   *
   * These were authored for the old near-black floor, where a large opaque
   * scorch read as damage. On pale flagstone the same values punch a hole in
   * the playfield and out-shout every character standing on it: 132px at 9
   * seconds with 26 live decals turns the arena into a field of black blobs.
   * Both are now smaller, shorter-lived, and much closer in value to the stone
   * they sit on - see drawDecal.
   */
  explosion: { r: 92, ttl: 5.5 },
  freeze: { r: 118, ttl: 5.0 },
};

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
  /**
   * Target centre of the casting half, as a fraction of screen width.
   *
   * The wheel is the right thumb's control, and the right thumb rests at the
   * edge of the glass, so the target sits hard right. This is a *target*, not a
   * promise: on a narrow phone the wheel is wide enough that the target would
   * push the outer element circle off the screen, so Renderer.wheelLayout()
   * pulls it back inside `edgePad` of the right edge. On any realistic
   * landscape device the fit clamp is what decides the position, and the wheel
   * ends up flush right.
   */
  centerXFrac: 0.88,
  centerYFrac: 0.5,
  ringRadiusFrac: 0.245, // of the smaller screen dimension...
  ringRadiusMin: 72, // ...clamped, so it is thumb-sized on every device
  ringRadiusMax: 138,
  elementRadiusFrac: 0.44, // of the ring radius
  focusRadiusFrac: 0.42, // of the ring radius
  hitPadding: 1.16, // extra forgiveness on the tap targets
  iconScale: 0.62,
  /** Backing plate overhang past the outermost circle edge, in screen px. */
  platePad: 14,
  /** Gap kept between that plate and the right edge of the screen, in screen
   *  px, so the glow ring is never clipped by the bezel. */
  edgePad: 10,
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
  /**
   * Cast confirmation: the circles that made the spell light up in the order
   * they were pressed.
   *
   * A recipe is three taps the player has to remember having made, and the spell
   * itself fires away from the wheel - so without this the reward for a correct
   * sequence is invisible at the moment it lands. FIRE+FIRE+WIND lighting FIRE,
   * FIRE, WIND in turn is also the only place the game ever confirms the ORDER
   * was right rather than just the set.
   */
  castGlowDur: 0.44,
  /** Gap between consecutive circles, so the order is readable at a glance. */
  castGlowStagger: 0.12,
};

/**
 * Drag-through casting.
 *
 * A press that lands on an element opens a stroke; dragging on across the wheel
 * fires each element the thumb passes through. This exists because the tap
 * scheme's cost is blind travel, and the wheel is wide: on a 375px-tall phone
 * the two radial recipes (EXPLOSION, FREEZE) are 314px of thumb movement, 84%
 * of the screen height, executed while watching the arena rather than the
 * wheel. Sweeping one arc replaces that with a single gesture.
 *
 * Taps are untouched. A stroke is a second way to say the same thing, so a
 * player who ignores it loses nothing.
 */
export const STROKE = {
  /**
   * A pointermove is walked as a segment, sampled this often, because a flick
   * across a 130px chord can arrive as ONE coalesced event. Testing only the
   * endpoint would silently skip every circle the thumb actually crossed.
   */
  samplePx: 8,
  /** Cap on samples per event, so a pathological jump cannot cost a frame. */
  maxSamples: 24,
  /**
   * Re-arming the circle you just fired: two of the five recipes repeat an
   * element, so a stroke has to be able to press the same circle twice. Both
   * gates below must pass, because a press landing near a circle's rim wobbles
   * across its boundary and must not read as two taps.
   */
  rearmMs: 95,
  /**
   * ...and the wobble must also be real travel, not just slow: a finger resting
   * on a rim drifts across it for much longer than 95ms without meaning to tap
   * twice.
   */
  rearmPx: 18,
  /**
   * Hold-to-repeat.
   *
   * Three of the five recipes open with a doubled element, and asking a thumb to
   * leave a circle and come back mid-sweep is a worse answer than simply waiting
   * on it. Holding on a circle re-fires it every `repeatMs`, which turns
   * FIRE+FIRE+WIND into "press FIRE, wait for the second tick, drag to WIND" -
   * one press and one drag, no excursion, nothing to aim at.
   *
   * Each repeat rides the ordinary `element` game event, so it buzzes and clicks
   * exactly like a tap rather than being a special case the feedback layer has
   * to know about.
   */
  repeatMs: 500,
};

/**
 * The charged centre circle.
 *
 * Holding the centre circle winds SPARK up; releasing throws everything you
 * charged into one shot. The centre was the one control with no depth - tap it
 * as fast as the cooldown allows and nothing else was ever true of it - so the
 * hold gives the fallback a second, deliberate mode without adding a sixth
 * circle to learn.
 *
 * ── What the hold buys, and what it must NOT buy ────────────────────────────
 * It buys BURST and REACH, never efficiency. SPARK is deliberately the worst
 * damage-per-mana on the wheel (0.75, where the cheapest recipe returns 0.9);
 * that is what stops "spam the centre" from being the optimal attack and makes
 * the recipe puzzle matter. A charged shot therefore scales its cost along with
 * its damage, and lands at the SAME 0.74 ratio - so a full charge is a big
 * number and a big bill, and the wheel keeps its reason to exist. Held time is
 * the real price: a second of standing still while the wave closes in.
 *
 * Efficiency is not a guess: `test/spells.test.mjs` asserts a fully charged
 * SPARK is never more damage-per-mana than the cheapest recipe.
 */
export const CHARGE = {
  /**
   * Hold time, in seconds, that takes the shot from a plain tap to full charge.
   * Measured from the moment the tap threshold is passed, so the full wind-up
   * is `time` seconds of thumb-down.
   */
  time: 0.9,
  /**
   * Holds shorter than this are a TAP and fire today's SPARK, to the point and
   * for the point: the centre circle is the panic button, and a panic button
   * whose cost and damage depend on how long you happened to press it is not a
   * panic button.
   */
  tapTime: 0.12,
  /** At full charge. Everything below is interpolated from the plain SPARK. */
  damage: 34,
  radius: 12,
  speed: 900,
  ttl: 1.6,
  knockback: 220,
  cost: 46,
  /** Extra cooldown on top of SEQUENCE.sparkCooldown, at full charge. */
  extraCooldown: 0.28,
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
    // The wind-up has to be felt, not watched: the charge ring is on the thumb
    // that is covering it. A light touch on the press, and a distinct pattern
    // when it is fully wound so you can release on feel.
    chargeStart: { ms: 6, cooldown: 0.2 },
    chargeFull: { ms: [12, 30, 16], cooldown: 0.3 },
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

/**
 * The painted art layer (see src/assets.js and README "Visuals").
 *
 * The vector art in sprites.js is sized off each entity's radius; these numbers
 * map the painted bitmaps onto the same footprint so swapping between the two
 * cannot move a character or change what a hit looks like. All of them are
 * multiples of the drawn radius `R` (entity radius x VIS), so they scale with
 * the creatures rather than with the screen.
 */
export const ART = {
  /**
   * Drawn height, as a multiple of R. The bitmaps are trimmed to their content,
   * so this is the whole silhouette, not a sprite-sheet cell.
   */
  height: { wizard: 2.5, shade: 2.35, wisp: 2.5, brute: 2.5 },
  /**
   * Where the sprite's bottom edge sits, as a multiple of R below the entity
   * position. The vector art stands the wizard's hem at +0.92R and the wraith's
   * at +0.95R; the wisp floats, so it hangs nearer its own centre.
   */
  foot: { wizard: 1.02, shade: 1.1, wisp: 0.4, brute: 1.08 },
  /**
   * How far a painted creature tilts toward the player, in radians, at full
   * lean. The bitmaps can only lean, not turn: a full rotation of a
   * three-quarter-view character reads as falling over.
   */
  leanAngle: 0.22,
  /** Screen-relative flip so a painted creature can face left or right. */
  mirror: true,
  /**
   * How much the body squashes at a footfall and stretches between them, as a
   * fraction of its height. Small on purpose: past about 0.08 a walk starts to
   * look like a bounce.
   */
  walkSquash: 0.05,
  /** Walk poses per creature, if the alternate bitmaps are present. */
  poses: { wizard: ['b', 'c'], shade: ['b', 'c'], brute: ['b', 'c'] },
  /** Painted brazier: drawn size and inset from the arena corner, in world px. */
  brazier: { w: 82, h: 104, inset: 46 },
  /**
   * Shade laid over the painted floor. It was 0.34 for the dark painted arena,
   * which needed pushing back so the characters could read; the anime arena is
   * bright and high-key on purpose, and shading it that hard would undo the whole
   * style. Contrast now comes from the art's own ink outlines instead.
   */
  floorShade: 0.06,
  /**
   * A soft scrim under each painted creature. Dark sprites on mid-dark stone
   * otherwise dissolve into the flagstones; this is the cheap stand-in for the
   * vector art's hard silhouette edges.
   */
  contactShade: 0.22,
};

export const UI = {
  /** Fraction of screen width reserved for the casting half. */
  castZoneX: 0.46,
  layout: {
    barW: 232,
    barH: 16,
    pad: 18,
  },
  /**
   * The spell book: a corner button, and the reference card it opens.
   *
   * The button shares the bottom-left corner with the movement thumb, so it is
   * treated as a CLICK, not a press: it only counts if the pointer goes down and
   * comes back up without travelling. A drag that starts on it is a movement
   * attempt and the stick wins, which is what keeps a corner of the walking zone
   * from becoming a trap.
   */
  spellBook: {
    /** Button edge, as a fraction of the shorter screen side. */
    sizeFrac: 0.135,
    sizeMin: 46,
    sizeMax: 68,
    /** Gap from the corner, and from whatever sits above it. */
    pad: 12,
    gap: 10,
    /** A corner tap must not travel further than this, or last longer. */
    clickSlopPx: 12,
    clickMaxMs: 450,
    /**
     * The card holds the left of the screen, deliberately: the wheel is where
     * the gesture is demonstrated, so the two must never overlap.
     */
    cardWFrac: 0.52,
    cardMaxW: 540,
    /** Row height is solved to fit every spell on the shortest phone. */
    rowMin: 30,
    rowMax: 54,
    /**
     * The demonstrated gesture is ANIMATED, not a still diagram: a thumb
     * travelling the path teaches a sweep in a way a static arrow cannot, and it
     * shows the hold as a pause rather than as a symbol to decode.
     *
     * Seconds per beat. A repeated circle dwells for STROKE.repeatMs instead of
     * `pressS`, so the animation waits exactly as long as the real control does.
     */
    pressS: 0.34,
    moveS: 0.5,
    endHoldS: 0.85,
  },
};

/**
 * The line the player actually draws.
 *
 * The wheel already shows which CIRCLES a swipe passed through. This is the
 * finger's own path - where it curved, where it overshot - which is the thing
 * being judged while the thumb is still down and the thumb itself is covering
 * the evidence.
 */
export const TRAIL = {
  /** Seconds the drawn line lingers after the thumb lifts. */
  ttl: 0.3,
  /** Points kept. The tail is short because a long one reads as a smear. */
  maxPoints: 40,
  /** How much of the tail is visible, as a fraction of the kept points. */
  tailFrac: 0.55,
};
