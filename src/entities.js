/**
 * RUNE PRESSURE - entity factories and geometry helpers.
 * Pure data and math. No DOM, no imports beyond config.
 */

import { ENEMY, PLAYER } from './config.js';

let nextId = 1;
export function resetIds() {
  nextId = 1;
}
export function newId() {
  return nextId++;
}

export function makePlayer(x, y) {
  return {
    id: newId(),
    x,
    y,
    vx: 0,
    vy: 0,
    hp: PLAYER.maxHp,
    maxHp: PLAYER.maxHp,
    mana: PLAYER.maxMana,
    maxMana: PLAYER.maxMana,
    radius: PLAYER.radius,
    aimX: 0, // last non-zero movement direction; aimed spells use it
    aimY: -1,
    invuln: 0,
    slowT: 0,
    slowFactor: 1,
    flash: 0,
    hurt: 0,
    healing: 0,
    /** Strides travelled, and the velocity the walk cycle leans into. */
    gait: 0,
    vxNow: 0,
    vyNow: 0,
    speedNow: 0,
    /**
     * Which way this actor last faced, as -1 or +1.
     *
     * The art is drawn facing LEFT when unflipped, so the renderer mirrors it to
     * face right. This field exists because a creature standing still still has
     * to face somewhere: without it, every stop snapped back to the unflipped
     * art and the wizard span round the moment you let go of the stick.
     */
    faceX: 1,
  };
}

export function makeEnemy(type, x, y, rng = Math.random) {
  const base = ENEMY[type] ?? ENEMY.shade;
  return {
    id: newId(),
    type,
    x,
    y,
    vx: 0,
    vy: 0,
    hp: base.hp,
    maxHp: base.hp,
    radius: base.radius,
    armor: base.armor,
    color: base.color,
    speed: base.speed,
    contactDps: base.contactDps,
    score: base.score,
    slowT: 0,
    slowFactor: 1,
    stun: 0,
    kx: 0,
    ky: 0,
    fireT: base.fireInterval ? base.fireInterval * (0.4 + rng() * 0.6) : 0,
    strafe: rng() < 0.5 ? -1 : 1,
    hitFlash: 0,
    spawnT: 0.45,
    bob: rng() * Math.PI * 2,
    /**
     * Gait: how far this creature has actually travelled, in "strides". The
     * renderer drives the walk cycle off this rather than off a clock, because
     * a clock cannot tell walking from being shoved - and a creature that steps
     * at a fixed rate while sliding across the floor is exactly what makes
     * movement read as ice-skating. `bob` stays for the idle animation.
     */
    gait: rng() * Math.PI * 2,
    /** Measured last-frame velocity, so the renderer can lean into the move. */
    vxNow: 0,
    vyNow: 0,
    speedNow: 0,
    /** Which way this actor last faced, as -1 or +1. See makePlayer. */
    faceX: 1,
  };
}

/**
 * A mark left on the arena floor: scorch from an explosion, frost from a freeze.
 *
 * Purely cosmetic and deliberately inert - it carries no damage, no slow and no
 * collision, so an after-effect can never quietly become a balance change. The
 * simulation only ages and culls them.
 */
export function makeDecal(x, y, opts = {}) {
  return {
    id: newId(),
    kind: opts.kind ?? 'scorch',
    x,
    y,
    r: opts.r ?? 90,
    ttl: opts.ttl ?? 6,
    maxTtl: opts.ttl ?? 6,
    color: opts.color ?? '#ffb03d',
    rot: opts.rot ?? 0,
    /** Seeded per decal so its irregular edge and flicker never animate. */
    seed: opts.seed ?? 0,
  };
}

/**
 * A player projectile. Carries whatever impact payload the spell needs, so the
 * projectile update stays a single generic path.
 */
export function makeBolt(x, y, vx, vy, spec, color) {
  return {
    id: newId(),
    kind: spec.kind ?? 'spark',
    x,
    y,
    vx,
    vy,
    radius: spec.radius ?? 8,
    damage: spec.damage ?? 10,
    ttl: spec.ttl ?? 1.4,
    color,
    life: 0,
    /** Fireball: damage everything within blastRadius of the impact point. */
    blastRadius: spec.blastRadius ?? 0,
    blastDamage: spec.blastDamage ?? 0,
    /** Waterball: shove and drench. */
    knockback: spec.knockback ?? 0,
    slow: spec.slow ?? 0,
    slowDur: spec.slowDur ?? 0,
    /** Cosmetic: sparks are thin darts, orbs are fat. */
    fat: (spec.radius ?? 8) >= 15,
  };
}

export function makeEnemyBolt(x, y, vx, vy, spec, color) {
  return {
    id: newId(),
    x,
    y,
    vx,
    vy,
    radius: spec.boltRadius ?? 8,
    damage: spec.boltDamage ?? 8,
    ttl: 3.2,
    color,
    life: 0,
  };
}

/** An expanding damage ring (FREEZE), or a purely visual shockwave. */
export function makeRing(x, y, spec, color, kind = 'frost') {
  return {
    id: newId(),
    kind,
    x,
    y,
    r: spec.startR ?? 8,
    maxR: spec.radius ?? 140,
    damage: spec.damage ?? 0,
    slow: spec.slow ?? 0,
    slowDur: spec.slowDur ?? 0,
    stun: spec.stun ?? 0,
    expandSpeed: spec.expandSpeed ?? 340,
    ttl: spec.ttl ?? 1.0,
    maxTtl: spec.ttl ?? 1.0,
    hit: new Set(),
    color,
    /** Random phase so repeated impacts do not land on the same star rotation. */
    seedAngle: Math.random() * Math.PI * 2,
  };
}

/**
 * A cosmetic particle.
 * `shape` selects the sprite ('dot' | 'ember' | 'shard' | 'droplet' | 'mote'),
 * so a fireball impact does not look identical to a freeze.
 */
export function makeParticle(x, y, vx, vy, opts = {}) {
  return {
    x,
    y,
    vx,
    vy,
    life: opts.life ?? 0.5,
    maxLife: opts.life ?? 0.5,
    size: opts.size ?? 3,
    color: opts.color ?? '#fff',
    drag: opts.drag ?? 2.4,
    shape: opts.shape ?? 'dot',
    angle: opts.angle ?? 0,
    spin: opts.spin ?? 0,
  };
}

/** Floating combat text (damage, spell names, "+28"). */
export function makeText(x, y, text, color, opts = {}) {
  return {
    x,
    y,
    text,
    color,
    life: opts.life ?? 0.9,
    maxLife: opts.life ?? 0.9,
    size: opts.size ?? 18,
    vy: opts.vy ?? -34,
  };
}

// ── geometry ────────────────────────────────────────────────────────────────

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function circleOverlap(ax, ay, ar, bx, by, br) {
  const dx = bx - ax;
  const dy = by - ay;
  const rr = ar + br;
  return dx * dx + dy * dy <= rr * rr;
}

/**
 * A right-angled distance, as `sqrt(dx*dx + dy*dy)`.
 *
 * Deliberately NOT `Math.hypot`. `hypot` is correctly rounded and guards against
 * overflow, and this game needs neither: coordinates are arena-sized, so nothing
 * is ever near the overflow point. What it does cost is agreement. The two forms
 * disagree on about 40% of realistic inputs by up to 1e-13, and that is enough to
 * move an enemy a hair differently each frame until a threshold comparison lands
 * one frame early - which turns "the Godot port reproduces the simulation
 * exactly" into "the port is usually close". Same arithmetic in both languages is
 * worth more here than a marginally better-rounded number, and the explicit form
 * is several times faster anyway.
 *
 * The port in ../rune-pressure-godot uses `sqrt(dx*dx + dy*dy)` for the same
 * reason, and `test_traces.gd` is what holds the two to it.
 */
export function dist2(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Normalise a vector; returns [x, y, length]. */
export function norm2(x, y) {
  const len = Math.sqrt(x * x + y * y);
  if (len === 0) return [0, 0, 0];
  return [x / len, y / len, len];
}
