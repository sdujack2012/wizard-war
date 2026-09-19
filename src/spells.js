/**
 * RUNE PRESSURE - the element wheel and the spell recipes.
 *
 * Pure data + pure functions, plus the balance table in config.js. No DOM:
 * loadable in Node for tests.
 *
 * ── The mechanism ───────────────────────────────────────────────────────────
 * Five circles on the right-hand control:
 *
 *        FIRE
 *   WIND   ◎   WATER        ◎ = the focus circle
 *        EARTH
 *
 * Tapping the centre circle fires SPARK: a weak, auto-aimed shot that always
 * works and needs no knowledge. Cheap, reliable, small. HOLDING it winds a
 * heavier shot up, released on lift, scaling with how long you held.
 *
 * Tapping the four outer circles in a specific ORDER casts a spell. That is the
 * whole puzzle: the recipes must be recalled and executed while enemies close
 * in, and a wrong tap breaks the chain.
 *
 * ── The grammar (this is what makes it learnable) ───────────────────────────
 *
 *   DOUBLE + ONE   -> an AIMED spell       (two of a kind, then a third)
 *   THREE DISTINCT -> a RADIAL spell       (erupts around you)
 *
 * A player who has forgotten a recipe can still reason their way to the right
 * shape: "I need it to hit everything near me, so it must be three different
 * elements." That is the difference between five arbitrary codes and a system.
 *
 * ── Why these exact orders ──────────────────────────────────────────────────
 * Every one of the four elements must be able to START a spell, otherwise half
 * the wheel is dead as an opener and the first tap carries no information. The
 * two radial spells are pure re-orderings of the same three elements, so this
 * costs nothing in flavour: still fire + water + earth for the blast, still
 * water + wind + earth for the deep freeze.
 */

import { CHARGE } from './config.js';


/** The four outer circles, clockwise from the top. */
export const ELEMENTS = [
  {
    id: 'fire',
    name: 'FIRE',
    color: '#d9531e',
    glow: '#f0b184',
    angle: -Math.PI / 2, // 12 o'clock
    blurb: 'Heat. Feeds destruction and mends flesh.',
  },
  {
    id: 'water',
    name: 'WATER',
    color: '#2f6fae',
    glow: '#a8cfe6',
    angle: 0, // 3 o'clock
    blurb: 'Flow. Quenches, cleanses, and freezes.',
  },
  {
    id: 'earth',
    name: 'EARTH',
    color: '#5f8a4a',
    glow: '#bcd4a8',
    angle: Math.PI / 2, // 6 o'clock
    blurb: 'Weight. Gives a spell its mass.',
  },
  {
    id: 'wind',
    name: 'WIND',
    color: '#8f7bb5',
    glow: '#d3c6e6',
    angle: Math.PI, // 9 o'clock
    blurb: 'Breath. Carries fire and carries cold.',
  },
];

export const ELEMENT_BY_ID = Object.fromEntries(ELEMENTS.map((e) => [e.id, e]));

/** Longest recipe the mechanism allows. */
export const MAX_SEQUENCE = 3;

/**
 * The five castable spells, plus the centre circle.
 *
 * `role` is derived from the sequence shape, not hand-authored, so the grammar
 * can never drift away from the data.
 */
export const SPELLS = [
  {
    id: 'fireball',
    name: 'FIREBALL',
    sequence: ['fire', 'fire', 'wind'],
    cost: 24,
    kind: 'fireball',
    color: '#d9531e',
    blurb: 'Wind-fed flame. Bursts on impact.',
  },
  {
    id: 'waterball',
    name: 'WATERBALL',
    sequence: ['water', 'water', 'earth'],
    cost: 20,
    kind: 'waterball',
    color: '#2f6fae',
    blurb: 'Heavy water. Hurts and drenches.',
  },
  {
    id: 'heal',
    name: 'HEAL',
    sequence: ['water', 'water', 'fire'],
    cost: 26,
    kind: 'heal',
    color: '#6fae63',
    blurb: 'Warm water. Closes your wounds.',
  },
  {
    id: 'explosion',
    name: 'EXPLOSION',
    sequence: ['earth', 'fire', 'water'],
    cost: 36,
    kind: 'explosion',
    color: '#e09a35',
    blurb: 'Steam and shrapnel. Erupts around you.',
  },
  {
    id: 'freeze',
    name: 'FREEZE',
    sequence: ['wind', 'water', 'earth'],
    cost: 30,
    kind: 'freeze',
    color: '#9fd4e8',
    blurb: 'A cold wave. Everything nearby slows to a crawl.',
  },
];

/**
 * The centre circle. Always available, deliberately weak: it is the fallback
 * for when you cannot remember a recipe, and the reason committing to a
 * three-tap sequence is a real decision rather than a formality.
 */
export const FOCUS_SPELL = {
  id: 'spark',
  name: 'SPARK',
  sequence: [],
  cost: 8,
  kind: 'spark',
  color: '#ece0c4',
  blurb: 'A weak dart. Always available.',
};

export const SPELL_BY_ID = Object.fromEntries([...SPELLS, FOCUS_SPELL].map((s) => [s.id, s]));

/** Derived from the sequence shape so the grammar cannot drift from the data. */
export function roleOf(sequence) {
  if (!sequence || sequence.length < 2) return 'focus';
  const [a, b] = sequence;
  if (a === b) return 'aimed';
  return sequence.length >= 3 ? 'radial' : 'focus';
}

/** Human-readable recipe, e.g. "FIRE + FIRE + WIND". */
export function formatSequence(sequence) {
  return sequence.map((id) => ELEMENT_BY_ID[id]?.name ?? '?').join(' + ');
}

/** Total mana cost of a partially built sequence, for the HUD. */
export function costOf(sequence) {
  const spell = matchSequence(sequence);
  return spell ? spell.cost : 0;
}

/**
 * The spell a completed sequence casts, or null.
 * All recipes are the same length, so there is no longest-match ambiguity.
 */
export function matchSequence(sequence) {
  if (!sequence || sequence.length === 0) return null;
  return SPELLS.find((s) => s.sequence.length === sequence.length && s.sequence.every((id, i) => id === sequence[i])) ?? null;
}

/** True while the taps so far could still become some spell. */
export function isLivePrefix(sequence) {
  if (!sequence || sequence.length === 0) return true;
  if (sequence.length >= MAX_SEQUENCE) return false;
  return SPELLS.some((s) => sequence.every((id, i) => s.sequence[i] === id));
}

/** Spells still reachable from the current taps - drives the recipe chart. */
export function reachableSpells(sequence = []) {
  if (!sequence.length) return SPELLS.slice();
  return SPELLS.filter((s) => sequence.every((id, i) => s.sequence[i] === id));
}

/**
 * Concrete numbers for a spell. All the balance for the wheel lives here.
 */
export function spellSpec(id) {
  switch (id) {
    case 'spark':
      return {
        kind: 'spark',
        // Deliberately inefficient: 0.75 damage per point of mana, where the
        // cheapest real spell returns 0.9 and FIREBALL returns 1.08. Sustained
        // output is mana-limited, so SPARK must lose on throughput or the wheel
        // stops being worth using. Its only edge is that it needs no recipe.
        damage: 6,
        speed: 640,
        radius: 6,
        ttl: 1.1,
        autoAim: true,
      };
    case 'fireball':
      return {
        kind: 'fireball',
        damage: 26,
        speed: 395,
        radius: 13,
        ttl: 1.6,
        blastRadius: 64,
        blastDamage: 16,
      };
    case 'waterball':
      return {
        kind: 'waterball',
        damage: 18,
        speed: 315,
        radius: 17,
        ttl: 1.8,
        knockback: 430,
        slow: 0.5,
        slowDur: 2.0,
      };
    case 'heal':
      return {
        kind: 'heal',
        heal: 28,
      };
    case 'explosion':
      return {
        kind: 'explosion',
        radius: 172,
        damage: 42,
        minDamage: 16,
        knockback: 360,
        stun: 0.4,
        hitStop: 0.1,
        shake: 18,
      };
    case 'freeze':
      return {
        kind: 'freeze',
        radius: 215,
        damage: 12,
        slow: 0.7,
        slowDur: 3.0,
        stun: 0.6,
        expandSpeed: 340,
        ttl: 1.1,
        shake: 10,
      };
    default:
      return null;
  }
}

/**
 * ── The charged centre circle ───────────────────────────────────────────────
 * `held` is seconds of real thumb-down time. The first `CHARGE.tapTime` of it
 * is a tap and nothing else: below that, a charged shot IS a SPARK, so the
 * panic button stays predictable. Past the threshold the wind-up ramps linearly
 * to full over the remaining `CHARGE.time`.
 *
 * Returns 0..1, ready to hand to the functions below or draw as a ring.
 */
export function chargeLevel(held) {
  const past = held - CHARGE.tapTime;
  if (!(past > 0)) return 0;
  const span = Math.max(1e-6, CHARGE.time - CHARGE.tapTime);
  return past >= span ? 1 : past / span;
}

/**
 * The spec a charged SPARK fires with. `t = 0` reproduces the plain SPARK
 * exactly, so a tap is not a special case anywhere downstream - it is just
 * charge 0, and every number here is interpolated from `spellSpec('spark')`.
 */
export function chargedSparkSpec(t) {
  const base = spellSpec('spark');
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (k === 0) return base;
  const lerp = (from, to) => from + (to - from) * k;
  return {
    ...base,
    damage: lerp(base.damage, CHARGE.damage),
    radius: lerp(base.radius, CHARGE.radius),
    speed: lerp(base.speed, CHARGE.speed),
    ttl: lerp(base.ttl, CHARGE.ttl),
    // A shove, not a crowd-clearer: the charged shot is a lance, and recipes
    // keep their monopoly on hitting more than one thing.
    knockback: lerp(0, CHARGE.knockback),
  };
}

/**
 * What that shot costs. Rounded, because the HUD prints it and the mana pool is
 * spent in whole points.
 */
export function chargedSparkCost(t) {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return Math.round(FOCUS_SPELL.cost + (CHARGE.cost - FOCUS_SPELL.cost) * k);
}

/** Damage per point of mana - the number that must never beat the recipes. */
export function damagePerMana(spec, cost) {
  return cost > 0 ? spec.damage / cost : Infinity;
}

/** Desktop key bindings for the four elements and the centre circle. */
export const ELEMENT_HOTKEYS = {
  1: 'fire',
  2: 'water',
  3: 'earth',
  4: 'wind',
};
