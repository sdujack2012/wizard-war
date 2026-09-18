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
  };
}

/**
 * A player projectile. Carries whatever impact payload the spell needs, so the
 * projectile update stays a single generic path.
 */
export function makeBolt(x, y, vx, vy, spec, color) {
  return {
    id: newId(),
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
  };
}

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

/** Normalise a vector; returns [x, y, length]. */
export function norm2(x, y) {
  const len = Math.hypot(x, y);
  if (len === 0) return [0, 0, 0];
  return [x / len, y / len, len];
}
