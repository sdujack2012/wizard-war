/**
 * RUNE PRESSURE - the rune set and the spell grammar.
 *
 * Pure data + pure functions. No DOM, no imports: loadable in Node for tests.
 *
 * ── The grammar (this is the puzzle layer) ──────────────────────────────────
 * A phrase is 1 base rune, optionally followed by up to MAX-1 SPLIT modifiers.
 *   IGNIS              -> one bolt
 *   IGNIS SPLIT        -> three bolts
 *   IGNIS SPLIT SPLIT  -> five bolts
 * Two base runes in a row, or SPLIT in first position, is a broken phrase and
 * BACKFIRES: you lose HP and half your mana. That is the whole point - reading
 * the grammar correctly, fast, while something is chewing on your ankles.
 *
 * Phrases auto-discharge CAST.window seconds after your last stroke, so a
 * partial phrase fires as what it is. Knowing how long your phrase is *is* the
 * skill.
 */

/** Direction constants duplicated as names for readability in the table. */
const E = 0;
const SE = 1;
const S = 2;
const SW = 3;
const W = 4;
const NW = 5;
const N = 6;
const NE = 7;

/** Sentinel chain value: recognised by closed-loop detection, not by direction. */
export const CIRCLE = 'circle';

/**
 * The six runes.
 *
 * `shape` is a normalised polyline (0..1 box) used to draw the grimoire icon -
 * and the shapes are exactly the strokes the recogniser expects, so the codex
 * is literally a traceable guide.
 */
export const RUNES = [
  {
    id: 'ignis',
    name: 'IGNIS',
    epithet: 'the flame',
    chain: [NE, SE],
    cost: 12,
    color: '#ff7a3d',
    glow: '#ffd0a8',
    role: 'base',
    blurb: 'A spear of fire. The workhorse.',
    shape: [
      [0.1, 0.9],
      [0.5, 0.1],
      [0.9, 0.9],
    ],
  },
  {
    id: 'glacies',
    name: 'GLACIES',
    epithet: 'the frost',
    chain: [SW, SE],
    cost: 16,
    color: '#6fd8ff',
    glow: '#cdf4ff',
    role: 'base',
    blurb: 'A ring of frost. Chills everything it touches.',
    shape: [
      [0.85, 0.1],
      [0.15, 0.5],
      [0.85, 0.9],
    ],
  },
  {
    id: 'terra',
    name: 'TERRA',
    epithet: 'the bulwark',
    chain: [S, E],
    cost: 14,
    color: '#8be08b',
    glow: '#dbffdb',
    role: 'base',
    blurb: 'Raises a stone wall. It blocks bolts, too.',
    shape: [
      [0.25, 0.1],
      [0.25, 0.85],
      [0.9, 0.85],
    ],
  },
  {
    id: 'ventus',
    name: 'VENTUS',
    epithet: 'the passage',
    chain: [E, SW, E],
    cost: 10,
    color: '#b78bff',
    glow: '#e6d9ff',
    role: 'base',
    blurb: 'A dash that cuts through what it crosses.',
    shape: [
      [0.12, 0.15],
      [0.88, 0.15],
      [0.12, 0.85],
      [0.88, 0.85],
    ],
  },
  {
    id: 'nova',
    name: 'NOVA',
    epithet: 'the unmaking',
    chain: CIRCLE,
    cost: 30,
    color: '#ff6bd6',
    glow: '#ffd6f4',
    role: 'base',
    blurb: 'Draw a closed circle. Everything near you is unmade.',
    shape: null, // rendered as a true circle
  },
  {
    id: 'split',
    name: 'SPLIT',
    epithet: 'the fork',
    chain: [SE, SW],
    cost: 8,
    color: '#ffe066',
    glow: '#fff6c2',
    role: 'modifier',
    blurb: 'Fork the rune before it. Adds two more of everything.',
    shape: [
      [0.15, 0.1],
      [0.85, 0.5],
      [0.15, 0.9],
    ],
  },
];

export const RUNE_BY_ID = Object.fromEntries(RUNES.map((r) => [r.id, r]));

/** Templates in the shape `classifyStroke` expects. */
export const RUNE_TEMPLATES = RUNES.map((r) => ({ id: r.id, chain: r.chain }));

export const BASE_RUNES = RUNES.filter((r) => r.role === 'base');
export const MODIFIER_RUNES = RUNES.filter((r) => r.role === 'modifier');

/** Key bindings for desktop play (drawing is the real input; these are a shortcut). */
export const RUNE_HOTKEYS = {
  1: 'ignis',
  2: 'glacies',
  3: 'terra',
  4: 'ventus',
  5: 'nova',
  6: 'split',
};

/**
 * Can `runeId` legally extend `pending`?
 * @returns {{ok:boolean, reason:string}}
 */
export function canAppend(pending, runeId, maxRunes = 3) {
  const rune = RUNE_BY_ID[runeId];
  if (!rune) return { ok: false, reason: 'unknown' };
  if (pending.length >= maxRunes) return { ok: false, reason: 'phrase-full' };
  if (pending.length === 0) {
    return rune.role === 'base' ? { ok: true, reason: '' } : { ok: false, reason: 'orphan-modifier' };
  }
  return rune.role === 'modifier' ? { ok: true, reason: '' } : { ok: false, reason: 'second-base' };
}

/** Total mana cost of a phrase. */
export function phraseCost(pending) {
  return pending.reduce((sum, id) => sum + (RUNE_BY_ID[id]?.cost ?? 0), 0);
}

/**
 * Validate a complete phrase.
 * @returns {{ok:boolean, reason:string, base:string|null, splits:number, cost:number}}
 */
export function validatePhrase(pending, maxRunes = 3) {
  const cost = phraseCost(pending);
  if (!pending.length) return { ok: false, reason: 'empty', base: null, splits: 0, cost: 0 };
  if (pending.length > maxRunes) return { ok: false, reason: 'phrase-full', base: null, splits: 0, cost };
  const first = RUNE_BY_ID[pending[0]];
  if (!first) return { ok: false, reason: 'unknown', base: null, splits: 0, cost };
  if (first.role !== 'base') return { ok: false, reason: 'orphan-modifier', base: null, splits: 0, cost };
  let splits = 0;
  for (let i = 1; i < pending.length; i++) {
    const r = RUNE_BY_ID[pending[i]];
    if (!r || r.role !== 'modifier') return { ok: false, reason: 'second-base', base: first.id, splits, cost };
    splits += 1;
  }
  return { ok: true, reason: '', base: first.id, splits, cost };
}

/** Human-readable phrase, e.g. "IGNIS + SPLIT". */
export function formatPhrase(pending) {
  return pending.map((id) => RUNE_BY_ID[id]?.name ?? '???').join(' + ');
}

/**
 * The concrete numbers a validated phrase produces.
 * Splits scale *everything* about the base rune - more projectiles, a wider
 * ring, a longer dash, a taller wall - so the modifier never feels wasted.
 */
export function spellSpec(base, splits = 0) {
  const s = Math.max(0, Math.min(2, splits));
  switch (base) {
    case 'ignis':
      return {
        kind: 'bolt',
        name: s ? `IGNIS ${'SPLIT '.repeat(s).trim()}` : 'IGNIS',
        count: 1 + 2 * s,
        damage: 14,
        speed: 430,
        radius: 8,
        spread: s ? 0.15 + 0.07 * s : 0,
        ttl: 1.35,
      };
    case 'glacies':
      return {
        kind: 'frost',
        name: s ? `GLACIES ${'SPLIT '.repeat(s).trim()}` : 'GLACIES',
        radius: 112 + 46 * s,
        damage: 6,
        slow: 0.42,
        slowDur: 1.9 + 0.7 * s,
        expandSpeed: 330,
        ttl: 1.1,
      };
    case 'terra':
      return {
        kind: 'wall',
        name: s ? `TERRA ${'SPLIT '.repeat(s).trim()}` : 'TERRA',
        count: 1 + 2 * s,
        hp: 70,
        ttl: 9,
        length: 78,
        thickness: 18,
        distance: 66,
        arc: 0.42,
      };
    case 'ventus':
      return {
        kind: 'dash',
        name: s ? `VENTUS ${'SPLIT '.repeat(s).trim()}` : 'VENTUS',
        distance: 185 + 72 * s,
        duration: 0.26,
        damage: 12,
        iframes: 0.42,
        trailDamageRadius: 30,
      };
    case 'nova':
      return {
        kind: 'nova',
        name: s ? `NOVA ${'SPLIT '.repeat(s).trim()}` : 'NOVA',
        radius: 168 + 52 * s,
        damage: 34,
        minDamage: 12,
        knockback: 330,
        rings: 1 + s,
        stun: 0.35 + 0.15 * s,
      };
    default:
      return null;
  }
}

/** Flat list of every castable spell, for the codex screen. */
export function allSpells() {
  const out = [];
  for (const base of BASE_RUNES) {
    for (let s = 0; s <= 2; s++) {
      const spec = spellSpec(base.id, s);
      out.push({ ...spec, base: base.id, splits: s, cost: phraseCost([base.id, ...Array(s).fill('split')]) });
    }
  }
  return out;
}

/** Longest phrase the grammar permits, precomputed for UI layout. */
export const MAX_PHRASE = 3;
