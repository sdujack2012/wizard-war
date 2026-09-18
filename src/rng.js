/**
 * RUNE PRESSURE - deterministic pseudo-random numbers.
 *
 * The simulation takes its randomness from an injected generator so a run can
 * be replayed exactly. That makes the test suite reproducible, and it is the
 * groundwork for a seeded daily challenge later.
 *
 * Gameplay and cosmetics draw from SEPARATE streams on purpose: adding a
 * particle or changing a burst size must never shift where the next enemy
 * spawns, or every balance change would silently reshuffle the tests.
 */

/** Fast, well-distributed 32-bit PRNG. Returns a function yielding [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any string into a 32-bit seed. For shareable seeds like "2026-02-14". */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
