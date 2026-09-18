/**
 * THE WHEEL - element, recipe and grammar tests.
 *
 * The recipes are the puzzle layer: if a sequence changes by accident, or two
 * sequences become confusable, the game stops being learnable. These tests pin
 * the design down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ELEMENTS,
  ELEMENT_BY_ID,
  ELEMENT_HOTKEYS,
  FOCUS_SPELL,
  MAX_SEQUENCE,
  SPELLS,
  SPELL_BY_ID,
  formatSequence,
  isLivePrefix,
  matchSequence,
  reachableSpells,
  roleOf,
  spellSpec,
} from '../src/spells.js';
import { PLAYER } from '../src/config.js';

const seq = (id) => SPELL_BY_ID[id].sequence;

// ── the wheel ────────────────────────────────────────────────────────────────

test('the wheel has four elements, one per compass point', () => {
  assert.equal(ELEMENTS.length, 4);
  const angles = ELEMENTS.map((e) => e.angle);
  assert.equal(new Set(angles).size, 4, 'two elements share a position on the wheel');
  assert.deepEqual(
    ELEMENTS.map((e) => e.id),
    ['fire', 'water', 'earth', 'wind'],
  );
  for (const el of ELEMENTS) {
    assert.ok(el.color && el.name && el.blurb, `${el.id} is missing presentation data`);
    assert.ok(Number.isFinite(el.angle));
  }
});

test('every element is reachable from the keyboard too', () => {
  const bound = Object.values(ELEMENT_HOTKEYS);
  assert.equal(new Set(bound).size, 4);
  for (const el of ELEMENTS) assert.ok(bound.includes(el.id), `${el.id} has no hotkey`);
});

test('the centre circle is a real, cheap, weak fallback', () => {
  assert.equal(FOCUS_SPELL.sequence.length, 0, 'the centre must not need a recipe');
  const spec = spellSpec('spark');
  assert.ok(spec.damage > 0, 'a fallback that does nothing is not a fallback');
  assert.equal(spec.autoAim, true, 'there is no aiming stick, so SPARK must aim itself');
  // Weaker than the cheapest *damaging* spell, or the wheel would be pointless.
  // HEAL has no damage at all, so it is excluded from the comparison.
  const damaging = SPELLS.map((s) => spellSpec(s.id).damage ?? 0).filter((d) => d > 0);
  const cheapest = Math.min(...damaging);
  assert.ok(spec.damage < cheapest, `SPARK (${spec.damage}) is not weaker than the cheapest spell (${cheapest})`);
});

// ── the recipes ──────────────────────────────────────────────────────────────

test('the five spells are exactly the ones designed', () => {
  // A deliberate tripwire: if a sequence is edited by accident, this fails and
  // the diff shows precisely what moved.
  assert.deepEqual(seq('fireball'), ['fire', 'fire', 'wind']);
  assert.deepEqual(seq('waterball'), ['water', 'water', 'earth']);
  assert.deepEqual(seq('heal'), ['water', 'water', 'fire']);
  assert.deepEqual(seq('explosion'), ['earth', 'fire', 'water']);
  assert.deepEqual(seq('freeze'), ['wind', 'water', 'earth']);
  assert.equal(SPELLS.length, 5);
});

test('no two spells share a recipe, and none is a prefix of another', () => {
  const seen = new Set();
  for (const s of SPELLS) {
    const key = s.sequence.join('>');
    assert.ok(!seen.has(key), `duplicate recipe: ${s.name}`);
    seen.add(key);
  }
  // Every recipe is the same length, so no completion can be ambiguous.
  for (const s of SPELLS) assert.equal(s.sequence.length, MAX_SEQUENCE, `${s.name} has the wrong length`);
});

test('all four elements can START a spell', () => {
  // The original draft started every recipe with water or fire, which left half
  // the wheel dead as an opener and made the first tap carry little information.
  const openers = new Set(SPELLS.map((s) => s.sequence[0]));
  assert.equal(openers.size, 4, `only ${[...openers].join(', ')} can open a spell`);
  for (const el of ELEMENTS) assert.ok(openers.has(el.id), `${el.id} can never open a spell`);
});

test('the grammar holds: doubled means aimed, three distinct means radial', () => {
  for (const s of SPELLS) {
    const distinct = new Set(s.sequence).size;
    if (s.sequence[0] === s.sequence[1]) {
      assert.equal(roleOf(s.sequence), 'aimed', `${s.name} should be aimed`);
      assert.equal(distinct, 2, `${s.name} doubles an element and adds a third`);
    } else {
      assert.equal(roleOf(s.sequence), 'radial', `${s.name} should be radial`);
      assert.equal(distinct, 3, `${s.name} must use three different elements`);
    }
  }
  const aimed = SPELLS.filter((s) => roleOf(s.sequence) === 'aimed');
  const radial = SPELLS.filter((s) => roleOf(s.sequence) === 'radial');
  assert.equal(aimed.length, 3);
  assert.equal(radial.length, 2);
});

test('every element is used, and no spell is all one element', () => {
  const used = new Set(SPELLS.flatMap((s) => s.sequence));
  assert.equal(used.size, 4, 'some element is never used by any spell');
  for (const s of SPELLS) assert.ok(new Set(s.sequence).size >= 2, `${s.name} is a single repeated element`);
});

test('the two radial spells are re-orderings only, not different ingredients', () => {
  // Keeping the ingredient sets intact is what lets EARTH and WIND lead without
  // changing what the spells are made of.
  assert.deepEqual([...seq('explosion')].sort(), ['earth', 'fire', 'water']);
  assert.deepEqual([...seq('freeze')].sort(), ['earth', 'water', 'wind']);
});

test('each spell has presentation data and a positive cost', () => {
  for (const s of SPELLS) {
    assert.ok(s.name && s.color, `${s.id} is missing presentation data`);
    assert.ok(s.cost > 0, `${s.id} is free`);
    assert.ok(s.blurb, `${s.id} has no codex blurb`);
    assert.equal(SPELL_BY_ID[s.id], s);
  }
});

// ── sequence matching ────────────────────────────────────────────────────────

test('a complete recipe matches exactly one spell', () => {
  for (const s of SPELLS) {
    assert.equal(matchSequence(s.sequence)?.id, s.id);
  }
  assert.equal(matchSequence([]), null);
  assert.equal(matchSequence(['fire']), null, 'a partial recipe must not cast');
  assert.equal(matchSequence(['fire', 'wind', 'fire']), null, 'an invented recipe must not cast');
});

test('live prefixes accept only taps that can still lead somewhere', () => {
  assert.equal(isLivePrefix([]), true);
  assert.equal(isLivePrefix(['water']), true, 'water opens two spells');
  assert.equal(isLivePrefix(['water', 'water']), true, 'double water still leads to HEAL or WATERBALL');
  assert.equal(isLivePrefix(['earth', 'fire']), true, 'leads to EXPLOSION');
  assert.equal(isLivePrefix(['wind', 'water']), true, 'leads to FREEZE');

  assert.equal(isLivePrefix(['wind', 'wind']), false, 'no spell opens wind, wind');
  assert.equal(isLivePrefix(['earth', 'water']), false, 'no spell opens earth, water');
  assert.equal(isLivePrefix(['fire', 'water']), false, 'no spell opens fire, water');

  // A full-length recipe is never a *live* prefix; it either casts or breaks.
  assert.equal(isLivePrefix(['fire', 'fire', 'wind']), false);
});

test('reachable spells narrow as the recipe is tapped', () => {
  assert.equal(reachableSpells([]).length, 5);
  assert.deepEqual(
    reachableSpells(['water']).map((s) => s.id).sort(),
    ['heal', 'waterball'],
  );
  assert.deepEqual(
    reachableSpells(['water', 'water']).map((s) => s.id).sort(),
    ['heal', 'waterball'],
  );
  assert.deepEqual(
    reachableSpells(['earth']).map((s) => s.id),
    ['explosion'],
  );
  assert.deepEqual(
    reachableSpells(['wind']).map((s) => s.id),
    ['freeze'],
  );
  // `reachable` means "whose recipe begins with these taps", so a completed
  // recipe reports exactly itself - that is what lights the finished row up.
  assert.deepEqual(
    reachableSpells(['water', 'water', 'fire']).map((s) => s.id),
    ['heal'],
  );
  assert.equal(reachableSpells(['water', 'water', 'wind']).length, 0, 'a dead end reaches nothing');
});

test('formatting a recipe reads as the player would say it', () => {
  assert.equal(formatSequence(['fire', 'fire', 'wind']), 'FIRE + FIRE + WIND');
  assert.equal(formatSequence(['wind', 'water', 'earth']), 'WIND + WATER + EARTH');
});

// ── numbers ──────────────────────────────────────────────────────────────────

test('SPARK is the fallback, never the right answer for damage', () => {
  // Sustained output in this game is mana-limited, not cooldown-limited. If
  // SPARK returned more damage per point of mana than a real spell, mashing the
  // centre circle would be the optimal strategy and the whole wheel would be
  // decoration. This is a design invariant, not a nitpick.
  const spark = spellSpec('spark');
  const sparkEff = spark.damage / FOCUS_SPELL.cost;
  const sparkDps = (PLAYER.manaRegen / FOCUS_SPELL.cost) * spark.damage;

  for (const id of ['fireball', 'waterball']) {
    const spell = SPELL_BY_ID[id];
    const spec = spellSpec(id);
    const eff = spec.damage / spell.cost;
    const dps = (PLAYER.manaRegen / spell.cost) * spec.damage;
    assert.ok(eff > sparkEff, `${spell.name} (${eff.toFixed(2)}/mana) is no better than SPARK (${sparkEff.toFixed(2)}/mana)`);
    assert.ok(dps > sparkDps, `${spell.name} (${dps.toFixed(1)} dps) does not out-damage SPARK (${sparkDps.toFixed(1)} dps)`);
  }
});

test('a radial spell pays off the moment it catches more than one enemy', () => {
  const spec = spellSpec('explosion');
  const perTarget = spec.minDamage;
  const spell = SPELL_BY_ID.explosion;
  // Even at the weakest point of its falloff, two targets beat SPARK per mana.
  const sparkEff = spellSpec('spark').damage / FOCUS_SPELL.cost;
  assert.ok((perTarget * 2) / spell.cost > sparkEff, 'EXPLOSION is not worth landing on two enemies');
});

test('every spell has a spec with the numbers the simulation needs', () => {
  for (const id of ['spark', 'fireball', 'waterball', 'heal', 'explosion', 'freeze']) {
    const spec = spellSpec(id);
    assert.ok(spec, `${id} has no spec`);
    assert.ok(spec.kind, `${id} has no kind`);
  }
  assert.equal(spellSpec('nonsense'), null);
  assert.ok(spellSpec('heal').heal > 0);
  assert.ok(spellSpec('freeze').slow > 0 && spellSpec('freeze').slowDur > 0);
  assert.ok(spellSpec('explosion').radius > spellSpec('fireball').blastRadius, 'the radial spell should be wider');
  // Mana cost must track power, or one spell dominates.
  const dmg = (id) => spellSpec(id).damage ?? 0;
  assert.ok(SPELL_BY_ID.explosion.cost > SPELL_BY_ID.waterball.cost);
  assert.ok(dmg('explosion') > dmg('waterball'));
  assert.ok(dmg('fireball') > dmg('spark'));
});
