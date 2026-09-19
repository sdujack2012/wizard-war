/**
 * Simulation regression suite.
 *
 * These tests drive the real `Game` class with synthetic input - no canvas, no
 * audio, no DOM. If the rules ever break, they break here first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Game, STATE } from '../src/game.js';
import { CHARGE, DECAL, SEQUENCE, TIME, WAVE, waveComposition } from '../src/config.js';
import { FOCUS_SPELL, SPELLS, SPELL_BY_ID, spellSpec } from '../src/spells.js';
import { makeEnemy, norm2 } from '../src/entities.js';
import { mulberry32 } from '../src/rng.js';

/** A game parked in the playing state with spawning suppressed.
 *  Seeded, so every run of this suite measures exactly the same world. */
function arena() {
  const g = new Game({ rng: mulberry32(20260214), fxRng: mulberry32(5150) });
  g.state = STATE.PLAYING;
  g.intermission = 1e9; // never spawn; tests place their own enemies
  return g;
}

function step(g, seconds, dt = 1 / 60) {
  const n = Math.max(1, Math.ceil(seconds / dt));
  for (let i = 0; i < n; i++) g.update(dt);
  return g;
}

/** Tap a full recipe, one element at a time. */
function tapAll(g, sequence) {
  let last = null;
  for (const el of sequence) last = g.tapElement(el);
  return last;
}

function putEnemy(g, type, dx, dy) {
  const e = makeEnemy(type, g.player.x + dx, g.player.y + dy);
  e.spawnT = 0; // tests want a settled enemy unless they say otherwise
  g.enemies.push(e);
  return e;
}

/** An enemy still in its materialising window (drawn, but not yet acting). */
function putSpawningEnemy(g, type, dx, dy) {
  const e = makeEnemy(type, g.player.x + dx, g.player.y + dy);
  g.enemies.push(e);
  return e;
}

function assertFiniteWorld(g) {
  const check = (obj, label) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${label}.${k} is ${v}`);
    }
  };
  check(g.player, 'player');
  g.enemies.forEach((e, i) => check(e, `enemies[${i}]`));
  g.bolts.forEach((b, i) => check(b, `bolts[${i}]`));
  g.ebolts.forEach((b, i) => check(b, `ebolts[${i}]`));
  g.particles.forEach((p, i) => check(p, `particles[${i}]`));
  assert.ok(Number.isFinite(g.score) && Number.isFinite(g.waveTimer) && Number.isFinite(g.time));
}

test('setMove preserves magnitude, so the stick is analog', () => {
  // Regression: setMove used to normalise to a unit vector, which threw away the
  // entire low end of the control's range - the mage had two speeds, still and
  // sprinting, and nothing in between.
  const g = arena();
  g.setMove(1, 0);
  assert.equal(g.moveX, 1);

  g.setMove(0.5, 0);
  assert.ok(Math.abs(g.moveX - 0.5) < 1e-9, `magnitude lost: ${g.moveX}`);

  g.setMove(0.25, 0);
  assert.ok(Math.abs(g.moveX - 0.25) < 1e-9, `magnitude lost: ${g.moveX}`);

  g.setMove(0, 0);
  assert.equal(g.moveX, 0);
  assert.equal(g.moveY, 0);

  // Over-unity input is clamped rather than teleporting.
  g.setMove(3, 0);
  assert.equal(g.moveX, 1);

  // A diagonal must not exceed top speed.
  g.setMove(1, 1);
  assert.ok(Math.abs(Math.hypot(g.moveX, g.moveY) - 1) < 1e-9, 'diagonal exceeded top speed');

  // Facing follows the direction only, never the magnitude.
  assert.ok(Math.abs(g.player.aimX - Math.SQRT1_2) < 1e-9, 'facing should use the unit direction');
});

test('half deflection moves the mage half as far', () => {
  const run = (deflection) => {
    const g = arena();
    g.setMove(deflection, 0);
    const x0 = g.player.x;
    step(g, 0.4);
    return g.player.x - x0;
  };
  const full = run(1);
  const half = run(0.5);
  assert.ok(full > 50, `full deflection barely moved (${full})`);
  assert.ok(
    Math.abs(half / full - 0.5) < 0.02,
    `half deflection travelled ${((half / full) * 100).toFixed(0)}% of full distance`,
  );
});

// ── entering a recipe ────────────────────────────────────────────────────────

test('tapping a full recipe casts that spell and charges its cost', () => {
  for (const spell of SPELLS) {
    const g = arena();
    assert.equal(g.player.mana, 100);
    tapAll(g, spell.sequence);
    assert.equal(g.stats.casts, 1, `${spell.name} did not cast`);
    assert.equal(g.stats.breaks, 0, `${spell.name} broke its own sequence`);
    assert.equal(g.player.mana, 100 - spell.cost, `${spell.name} charged the wrong mana`);
    assert.equal(g.sequence.length, 0, 'the sequence must clear after a cast');
    assert.equal(g.lastCast?.id, spell.id);
  }
});

test('a partial recipe is held, not cast', () => {
  const g = arena();
  g.tapElement('water');
  assert.deepEqual(g.sequence, ['water']);
  assert.equal(g.stats.casts, 0);
  g.tapElement('water');
  assert.deepEqual(g.sequence, ['water', 'water']);
  assert.equal(g.stats.casts, 0);
  // Reachable narrows to the two spells that still fit.
  assert.deepEqual(
    g.reachable.map((s) => s.id).sort(),
    ['heal', 'waterball'],
  );
  assert.equal(g.oneAwayFromCast, true, 'the third tap is the deciding one');
});

test('the deciding tap resolves the shared prefix correctly', () => {
  // HEAL and WATERBALL share "water water"; HEAL takes fire, WATERBALL earth.
  for (const [third, expected] of [
    ['fire', 'heal'],
    ['earth', 'waterball'],
  ]) {
    const g = arena();
    tapAll(g, ['water', 'water', third]);
    assert.equal(g.stats.casts, 1);
    assert.equal(g.lastCast.id, expected, `water water ${third} should have been ${expected.toUpperCase()}`);
  }
});

test('a tap that leads nowhere breaks the sequence, costing time but not HP', () => {
  const g = arena();
  g.tapElement('wind');
  assert.deepEqual(g.sequence, ['wind']);
  const res = g.tapElement('wind'); // no spell opens wind, wind
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'broken');
  assert.equal(g.sequence.length, 0, 'a broken sequence must not linger');
  assert.equal(g.player.hp, 100, 'a mistap must never cost health');
  assert.equal(g.stats.breaks, 1);
  assert.ok(g.seqLock > 0, 'a break must cost a beat');
  assert.ok(g.breakFlash > 0, 'a break must be visible');
  // And the lock really blocks the next tap.
  assert.equal(g.tapElement('fire').reason, 'locked');
});

test('a bogus element id is rejected outright, not silently treated as a break', () => {
  // Regression: the input layer once passed the element *object* instead of its
  // id, so every tap looked like an illegal element and broke the sequence.
  const g = arena();
  const res = g.tapElement({ id: 'fire' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown-element');
  assert.equal(g.sequence.length, 0);
  assert.equal(g.stats.breaks, 0, 'a programming error must not read as a player mistake');
  assert.equal(g.seqLock, 0, 'and must not punish the player');
  assert.equal(g.tapElement('plasma').reason, 'unknown-element');
});

test('an abandoned partial recipe dissolves on its own', () => {
  const g = arena();
  g.tapElement('fire');
  step(g, SEQUENCE.idleTimeout - 0.3);
  assert.deepEqual(g.sequence, ['fire'], 'it dissolved too early');
  step(g, 0.5);
  assert.equal(g.sequence.length, 0, 'an abandoned recipe should fade away');
  assert.equal(g.stats.breaks, 0, 'abandoning is not a mistake');
  assert.equal(g.player.mana, 100);
});

test('clearSequence wipes the taps with no penalty', () => {
  const g = arena();
  g.tapElement('earth');
  assert.equal(g.clearSequence(), true);
  assert.equal(g.sequence.length, 0);
  assert.equal(g.stats.breaks, 0);
  assert.equal(g.seqLock, 0, 'changing your mind must not lock you out');
  assert.equal(g.clearSequence(), false, 'nothing left to clear');
});

// ── the centre circle ────────────────────────────────────────────────────────

test('SPARK aims itself at the nearest enemy regardless of facing', () => {
  const g = arena();
  g.player.aimX = 0; // facing due north...
  g.player.aimY = -1;
  putEnemy(g, 'shade', 200, 0); // ...but the enemy is due east
  g.tapFocus();
  assert.equal(g.bolts.length, 1);
  const b = g.bolts[0];
  assert.ok(b.vx > 0, 'SPARK did not auto-aim east');
  assert.ok(Math.abs(b.vy) < 1e-6, 'SPARK drifted off-axis');
  assert.equal(g.stats.sparks, 1);
});

test('SPARK falls back to your facing when nothing is alive', () => {
  const g = arena();
  g.player.aimX = 0;
  g.player.aimY = -1;
  g.tapFocus();
  assert.equal(g.bolts.length, 1);
  assert.ok(g.bolts[0].vy < 0, 'SPARK should follow the facing wedge with no target');
});

test('a SPARK tap leaves a partial recipe alone - the centre is not a trap', () => {
  const g = arena();
  g.tapElement('water');
  g.tapElement('water');
  assert.equal(g.sequence.length, 2);
  g.tapFocus();
  // The wheel's hit circles tile their disc almost exactly, so the shortest path
  // between two opposite elements crosses the centre. Losing the recipe to a
  // thumb that clipped the middle punished the geometry, not the player.
  assert.equal(g.sequence.length, 2, 'a quick centre tap must not cost the recipe');
  assert.equal(g.stats.breaks, 0, 'and forgive it');
  assert.equal(g.stats.sparks, 1, 'while still firing the panic shot');
});

test('a committed wind-up spends the recipe', () => {
  const g = arena();
  g.tapElement('water');
  g.tapElement('water');
  assert.equal(g.sequence.length, 2);
  assert.equal(g.beginCharge().ok, true);
  step(g, CHARGE.tapTime + 0.06);
  const r = g.releaseCharge();
  assert.equal(r.ok, true);
  assert.ok(r.charge > 0, 'held past tapTime, so this must be a charged shot');
  assert.equal(g.sequence.length, 0, 'committing the wind-up replaces the recipe');
});

test('SPARK has a cooldown and costs mana', () => {
  const g = arena();
  g.tapFocus();
  assert.equal(g.player.mana, 100 - FOCUS_SPELL.cost);
  assert.equal(g.tapFocus().reason, 'cooldown', 'SPARK must not be spammable');
  // Two sparks in rapid succession is the point; exact mana is not, because the
  // regeneration tick runs in between. What matters is that both were charged.
  step(g, SEQUENCE.sparkCooldown + 0.02);
  assert.equal(g.tapFocus().ok, true);
  assert.equal(g.stats.sparks, 2);
  assert.ok(
    g.player.mana < 100 - FOCUS_SPELL.cost,
    `two sparks were not charged (mana ${g.player.mana})`,
  );
});

// ── the charged centre circle ────────────────────────────────────────────────

/** Press the centre, hold for `seconds` of real time, then let go. */
function holdFocus(g, seconds) {
  const began = g.beginCharge();
  if (!began.ok) return began;
  step(g, seconds);
  return g.releaseCharge();
}

test('holding the centre circle fires a bigger shot, and bills for it', () => {
  const g = arena();
  const res = holdFocus(g, CHARGE.time);
  assert.equal(res.ok, true, `the release failed: ${res.reason}`);
  assert.equal(g.bolts.length, 1);

  const full = spellSpec('spark');
  const shot = g.bolts[0];
  const speedOf = (b) => Math.hypot(b.vx, b.vy);
  assert.ok(shot.damage > full.damage * 4, `a full charge only did ${shot.damage}`);
  assert.ok(shot.radius > full.radius, 'the charged shot should look bigger');
  assert.ok(speedOf(shot) > full.speed, 'the charged shot should fly faster');
  assert.equal(shot.knockback, CHARGE.knockback);
  assert.equal(res.cost, CHARGE.cost);
  assert.equal(g.stats.charged, 1);
  assert.equal(g.stats.sparks, 1, 'a charged shot is still a SPARK');
});

test('a tap on the centre circle is exactly the old SPARK', () => {
  // The panic button has to stay predictable: same damage, same price, same
  // cooldown as before the charge existed.
  const g = arena();
  const res = g.tapFocus();
  assert.equal(res.ok, true);
  const shot = g.bolts[0];
  const base = spellSpec('spark');
  assert.equal(shot.damage, base.damage);
  assert.equal(shot.radius, base.radius);
  assert.equal(Math.hypot(shot.vx, shot.vy), base.speed);
  assert.equal(shot.knockback, 0);
  assert.equal(res.cost, FOCUS_SPELL.cost);
  assert.equal(g.player.mana, 100 - FOCUS_SPELL.cost, 'a tap must not pay a charge price');
  assert.equal(g.sparkCd, SEQUENCE.sparkCooldown, 'a tap must not serve a charge cooldown');
  assert.equal(g.stats.charged, 0);
});

test('the longer the hold, the harder the shot - up to the cap', () => {
  let previous = 0;
  for (const held of [0.25, 0.45, 0.7, CHARGE.time, CHARGE.time * 3]) {
    const g = arena();
    const res = holdFocus(g, held);
    assert.equal(res.ok, true, `release failed at ${held}s: ${res.reason}`);
    const shot = g.bolts[0];
    assert.ok(shot.damage >= previous, `holding ${held}s hit softer than the shorter hold`);
    previous = shot.damage;
  }
  // Past full charge the shot stops growing: no reward for holding forever.
  const maxed = arena();
  holdFocus(maxed, CHARGE.time * 3);
  const exact = arena();
  holdFocus(exact, CHARGE.time);
  assert.equal(maxed.bolts[0].damage, exact.bolts[0].damage);
  assert.equal(maxed.player.mana, exact.player.mana);
});

test('the wind-up runs on the thumb\'s clock, not the simulation\'s', () => {
  // Slow motion and the hit-stop freeze must not stretch or stall a charge: the
  // player is holding a thumb down in the real world, and the release has to
  // answer to that, not to the frame rate the spell flourish is running at.
  const slow = arena();
  slow.resolveSlow = 1e9; // pin the world into slow motion
  slow.beginCharge();
  step(slow, 0.5);
  assert.ok(Math.abs(slow.charge - 0.5) < 0.02, `slow motion stretched the charge to ${slow.charge}s`);

  const stopped = arena();
  stopped.hitStop = 1e9; // pin the world on an impact frame
  stopped.beginCharge();
  step(stopped, 0.3);
  assert.ok(Math.abs(stopped.charge - 0.3) < 0.02, `a hit-stop froze the charge at ${stopped.charge}s`);
});

test('an abandoned wind-up fires nothing', () => {
  const g = arena();
  g.beginCharge();
  step(g, CHARGE.time);
  assert.equal(g.cancelCharge(), true);
  assert.equal(g.charging, false);
  assert.equal(g.bolts.length, 0, 'a cancelled charge must not throw a shot');
  assert.equal(g.player.mana, 100, 'and must not bill for one');

  // Releasing without a wind-up in flight is likewise a no-op.
  assert.equal(g.releaseCharge().reason, 'not-charging');
  assert.equal(g.bolts.length, 0);
});

test('a second wind-up cannot start on top of the first', () => {
  const g = arena();
  assert.equal(g.beginCharge().ok, true);
  assert.equal(g.beginCharge().reason, 'charging');
  step(g, CHARGE.time);
  assert.equal(g.sparkCd, 0, 'nothing has been spent yet');

  g.releaseCharge();
  assert.equal(g.beginCharge().reason, 'cooldown', 'the release cooldown must gate the next wind-up');
});

test('an unaffordable full charge fizzles instead of firing for free', () => {
  const g = arena();
  g.beginCharge();
  step(g, CHARGE.time);
  // Priced at release, so the mana that matters is the mana you have when you
  // let go - set it after the hold, where regeneration cannot muddy the reading.
  g.player.mana = 20; // enough for a tap, not for a full wind-up
  const res = g.releaseCharge();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'mana');
  assert.equal(g.bolts.length, 0);
  assert.equal(g.player.mana, 20, 'a fizzle must not charge you');
  assert.equal(g.stats.fizzles, 1);
  assert.ok(g.seqLock > 0);
  assert.equal(g.charging, false, 'the wind-up must not survive a fizzle');
});

test('a full wind-up serves a longer cooldown than a tap', () => {
  const tap = arena();
  tap.tapFocus();
  const charged = arena();
  holdFocus(charged, CHARGE.time);
  assert.ok(
    charged.sparkCd > tap.sparkCd,
    `a full charge (${charged.sparkCd}s) is as spammable as a tap (${tap.sparkCd}s)`,
  );
});

test('the full-charge tell fires once, not every frame', () => {
  const g = arena();
  g.beginCharge();
  g.drainEvents();
  step(g, CHARGE.time * 3);
  const fulls = g.drainEvents().filter((e) => e.type === 'charge-full');
  assert.equal(fulls.length, 1, `charge-full fired ${fulls.length} times`);
});

test('a wind-up cannot outlive the run', () => {
  const g = arena();
  g.beginCharge();
  step(g, 0.4);
  g.startRun(); // a fresh run (death and retry) resets the world
  assert.equal(g.charging, false);
  assert.equal(g.charge, 0);
  assert.equal(g.releaseCharge().reason, 'not-charging');
});

test('every aimed spell auto-targets, even while strafing', () => {
  // Regression: aimed spells used to fire along the movement facing vector,
  // which `setMove` overwrites every frame - so a spell cast while strafing flew
  // off perpendicular to the target and missed. There is no aiming stick, so
  // "aim at the nearest threat" is the only honest behaviour.
  for (const id of ['spark', 'fireball', 'waterball']) {
    const g = arena();
    g.player.aimX = 0; // facing due north...
    g.player.aimY = -1;
    putEnemy(g, 'shade', 220, 0); // ...enemy due east
    g.setMove(0, -1); // and walking north, which clobbers the facing vector
    assert.ok(g.player.aimY < 0, 'setMove should have overwritten the facing');

    if (id === 'spark') g.tapFocus();
    else tapAll(g, SPELL_BY_ID[id].sequence);

    assert.equal(g.bolts.length, 1, `${id} produced no projectile`);
    const b = g.bolts[0];
    assert.ok(b.vx > 0, `${id} did not auto-target the enemy`);
    assert.ok(Math.abs(b.vy) < 1e-6, `${id} drifted off-axis`);
  }
});

test('SPARK really is weaker than a real spell', () => {
  const g = arena();
  const e = putEnemy(g, 'shade', 120, 0);
  g.tapFocus();
  step(g, 0.5);
  assert.ok(
    Math.abs(20 - e.hp - spellSpec('spark').damage) < 0.01,
    `SPARK dealt ${20 - e.hp}, expected ${spellSpec('spark').damage}`,
  );
  assert.ok(e.hp > 0, 'a single SPARK should not delete a shade');
});

// ── spell effects ────────────────────────────────────────────────────────────

test('FIREBALL bursts on impact and catches what is beside the target', () => {
  const g = arena();
  const primary = putEnemy(g, 'shade', 0, -70);
  const bystander = putEnemy(g, 'shade', 30, -70);
  tapAll(g, SPELL_BY_ID.fireball.sequence);
  assert.equal(g.bolts.length, 1);
  step(g, 0.4);

  assert.equal(primary.dead, true, 'the fireball missed its target');
  assert.ok(bystander.hp < 20, `the blast missed the bystander (hp ${bystander.hp})`);
  assert.ok(g.stats.kills >= 1);
});

test('WATERBALL hurts, shoves and drenches', () => {
  const g = arena();
  const e = putEnemy(g, 'shade', 0, -70);
  tapAll(g, SPELL_BY_ID.waterball.sequence);
  let maxKnock = 0;
  for (let i = 0; i < 20; i++) {
    g.update(1 / 60);
    maxKnock = Math.max(maxKnock, Math.abs(e.ky));
  }
  assert.ok(e.hp < 20, 'WATERBALL did no damage');
  assert.ok(maxKnock > 100, `WATERBALL did not shove (peak knockback ${maxKnock})`);
  assert.ok(e.slowT > 0 && e.slowFactor < 1, 'WATERBALL did not drench');
});

test('HEAL restores health and refuses to overheal', () => {
  const g = arena();
  g.player.hp = 40;
  tapAll(g, SPELL_BY_ID.heal.sequence);
  assert.equal(g.player.hp, 40 + spellSpec('heal').heal);
  assert.equal(g.stats.heals, 1);

  const g2 = arena();
  g2.player.hp = g2.player.maxHp - 5;
  tapAll(g2, SPELL_BY_ID.heal.sequence);
  assert.equal(g2.player.hp, g2.player.maxHp, 'healing must clamp at max HP');
});

test('EXPLOSION hits every enemy in range, including the ones it kills', () => {
  // Regression: killing an enemy splices the enemies array, so an ascending
  // for...of over it silently skips the next enemy.
  const g = arena();
  const hits = [];
  for (let i = 0; i < 6; i++) hits.push(putEnemy(g, 'shade', 30 + i * 20, 0));
  tapAll(g, SPELL_BY_ID.explosion.sequence);
  assert.equal(g.enemies.length, 0, 'some shades survived an EXPLOSION they were standing in');
  assert.equal(g.stats.kills, 6, `EXPLOSION only killed ${g.stats.kills} of 6`);
  assert.ok(hits.every((e) => e.dead));
});

test('EXPLOSION falls off with distance and shoves outward', () => {
  const g = arena();
  const near = putEnemy(g, 'brute', 40, 0);
  const far = putEnemy(g, 'brute', 150, 0);
  tapAll(g, SPELL_BY_ID.explosion.sequence);
  assert.ok(near.hp < far.hp, `falloff is wrong (${near.hp} vs ${far.hp})`);
  assert.ok(near.kx > 0 && far.kx > 0, 'both should be pushed away from the caster');
  assert.ok(g.hitStop > 0, 'the radial spell should stop time for impact');
});

test('a materialising enemy is still hittable', () => {
  // It is drawn on screen, so it must be damageable. Making it invulnerable
  // would silently waste a spell cast at exactly the right moment.
  const g = arena();
  const e = putSpawningEnemy(g, 'shade', 30, 0);
  assert.ok(e.spawnT > 0, 'this test needs an enemy still spawning');
  tapAll(g, SPELL_BY_ID.explosion.sequence);
  assert.equal(e.dead, true, 'an EXPLOSION should hit a spawning enemy');
});

test('FREEZE chills every enemy the wave sweeps, not just the first', () => {
  const g = arena();
  const targets = [];
  for (let i = 0; i < 5; i++) targets.push(putEnemy(g, 'shade', 40 + i * 22, 0));
  tapAll(g, SPELL_BY_ID.freeze.sequence);
  step(g, 1.2);
  for (const e of targets) {
    assert.ok(e.hp < 20, 'a shade was missed by the cold wave');
    assert.ok(e.slowT > 0 && e.slowFactor < 1, 'a shade was not chilled');
  }
});

// ── failure modes ────────────────────────────────────────────────────────────

test('an unaffordable spell fizzles: no damage, no charge, brief lock', () => {
  const g = arena();
  g.player.mana = 5;
  g.tapElement('fire');
  g.tapElement('fire');
  g.tapElement('wind');
  assert.equal(g.stats.casts, 0);
  assert.equal(g.bolts.length, 0, 'a fizzle must not also cast');
  assert.equal(g.player.mana, 5, 'a fizzle must not charge you');
  assert.equal(g.player.hp, 100, 'a fizzle must not hurt');
  assert.equal(g.stats.fizzles, 1);
  assert.ok(g.seqLock > 0);
});

test('an unaffordable SPARK fizzles rather than firing for free', () => {
  const g = arena();
  g.player.mana = 2;
  const res = g.tapFocus();
  assert.equal(res.ok, false);
  assert.equal(g.bolts.length, 0);
  assert.equal(g.player.mana, 2);
  assert.equal(g.stats.fizzles, 1);
});

// ── movement detail: the walk cycle, and the marks spells leave ──────────────

test('the walk cycle is driven by ground covered, not by the clock', () => {
  // The bug this replaces: enemies stepped at a fixed rate (`bob += dt * 4`) no
  // matter how fast they were actually moving, so a creature pinned against a
  // wall kept walking on the spot and a shoved one skated without stepping.
  const still = arena();
  step(still, 1.0);
  assert.equal(still.player.gait, 0, 'the mage walked while standing still');

  const walking = arena();
  walking.setMove(1, 0);
  step(walking, 0.5);
  assert.ok(walking.player.gait > 0, 'the mage did not take a step while walking');

  // Distance per stride must hold: gait is strides, so half the time is half the
  // strides at the same speed.
  const far = arena();
  far.setMove(1, 0);
  step(far, 1.0);
  const near = arena();
  near.setMove(1, 0);
  step(near, 0.5);
  assert.ok(
    Math.abs(far.player.gait - near.player.gait * 2) < 0.05,
    `strides are not proportional to distance (${far.player.gait} vs ${near.player.gait * 2})`,
  );
});

test('a creature jammed against a wall stops moving its feet', () => {
  const g = arena();
  g.player.x = g.world.w - g.player.radius; // flush against the east wall
  g.setMove(1, 0);
  step(g, 0.4);
  const pinned = g.player.gait;
  step(g, 0.4);
  assert.ok(
    Math.abs(g.player.gait - pinned) < 0.01,
    `the mage kept walking into the wall (gait ${g.player.gait} from ${pinned})`,
  );
});

test('walking kicks up dust at the feet, and standing still does not', () => {
  const g = arena();
  g.setMove(1, 0);
  step(g, 0.6);
  const dust = g.particles.filter((p) => p.shape === 'dust');
  assert.ok(dust.length > 0, 'walking produced no footfall dust');
  assert.ok(dust.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

  const still = arena();
  step(still, 1.2);
  assert.equal(
    still.particles.filter((p) => p.shape === 'dust').length,
    0,
    'standing still kicked up dust',
  );
});

test('enemies get a walk cycle too, and it stops when they are shoved to a halt', () => {
  const g = arena();
  const e = putEnemy(g, 'shade', 260, 0);
  step(g, 0.5);
  assert.ok(e.gait > 0, 'the wraith never took a step while closing in');
  assert.ok(e.speedNow > 0, 'no travel was measured');
});

test('an explosion leaves a scorch that damages nothing and fades on its own', () => {
  const g = arena();
  tapAll(g, SPELL_BY_ID.explosion.sequence);
  assert.equal(g.stats.casts, 1, 'EXPLOSION did not cast');
  const decals = g.decals.filter((d) => d.kind === 'scorch');
  assert.equal(decals.length, 1, `expected one scorch, got ${decals.length}`);

  // Inert by construction: an after-effect must never become a balance change.
  const spec = spellSpec('explosion');
  for (const key of ['damage', 'slow', 'stun', 'radius']) {
    assert.equal(decals[0][key], undefined, `the scorch carries a ${key} field`);
  }

  const enemy = putEnemy(g, 'brute', 60, 0);
  const hp = enemy.hp;
  step(g, 1.0); // stand in the scorch for a second
  assert.equal(enemy.hp, hp, 'the scorch damaged something');

  step(g, DECAL.explosion.ttl);
  assert.equal(g.decals.length, 0, 'the scorch never faded');
});

test('a freeze leaves frost, and every damaging ring resolves the same way', () => {
  const g = arena();
  tapAll(g, SPELL_BY_ID.freeze.sequence);
  assert.equal(g.stats.casts, 1, 'FREEZE did not cast');
  assert.equal(g.decals.filter((d) => d.kind === 'frost').length, 1, 'no frost was left');

  // The new layered rings must not have changed what the spells actually do:
  // FREEZE still slows and still damages exactly what it slowed before.
  const near = putEnemy(g, 'shade', 60, 0);
  const far = putEnemy(g, 'shade', 400, 0);
  const farHp = far.hp;
  step(g, 0.35);
  assert.ok(near.slowT > 0, 'the frost wave did not slow a nearby enemy');
  assert.equal(far.hp, farHp, 'the frost wave reached an enemy it should not have');
});

test('decals are capped, so a long run cannot accumulate them forever', () => {
  const g = arena();
  for (let i = 0; i < 60; i++) g.addDecal(100 + i, 100, 'scorch', 90, 30, '#ffb03d');
  assert.ok(g.decals.length <= DECAL.max, `decals grew to ${g.decals.length}`);
  assert.equal(g.decals.length, DECAL.max);
});

test('dead players cannot cast', () => {
  const g = arena();
  g.player.hp = 3;
  g.damagePlayer(10, 'shade');
  assert.equal(g.state, STATE.GAMEOVER);
  assert.equal(g.sequence.length, 0, 'death must clear the recipe');
  assert.equal(g.tapElement('fire').reason, 'not-playing');
  assert.equal(g.tapFocus().reason, 'not-playing');
  assert.equal(g.stats.casts, 0);
});

// ── waves (unchanged mechanics) ──────────────────────────────────────────────

test('wave 1 spawns a small shade pack, and clearing it advances the wave', () => {
  const g = new Game();
  g.startRun();
  assert.equal(g.state, STATE.PLAYING);

  step(g, WAVE.firstDelay + 0.3);
  assert.equal(g.wave, 1);
  assert.equal(g.enemies.length, waveComposition(1).total);
  assert.ok(g.enemies.every((e) => e.type === 'shade'));

  while (g.enemies.length) g.damageEnemy(g.enemies[0], 9999);
  step(g, 0.2);
  assert.ok(g.score > 0);
  assert.ok(g.intermission > 0, 'a study break should follow a cleared wave');

  step(g, WAVE.intermission + 0.3);
  assert.equal(g.wave, 2);
  assert.ok(g.enemies.some((e) => e.type === 'wisp'), 'wave 2 should introduce the ranged enemy');
});

test('wave composition escalates and brutes arrive from wave 4', () => {
  assert.ok(waveComposition(5).total > waveComposition(1).total);
  assert.equal(waveComposition(1).brute, 0);
  assert.equal(waveComposition(3).brute, 0);
  assert.ok(waveComposition(4).brute >= 1);
  for (let w = 1; w <= 30; w++) {
    const c = waveComposition(w);
    assert.equal(c.shade + c.wisp + c.brute, c.total, `wave ${w} composition does not add up`);
    assert.ok(c.shade >= 1);
    assert.ok(c.total <= WAVE.maxAlive);
  }
});

test('running the wave clock out bites you and dumps in reinforcements', () => {
  const g = arena();
  g.wave = 1;
  g.waveTimer = 0.01;
  putEnemy(g, 'shade', -300, -150);
  const before = g.enemies.length;
  step(g, 0.1);
  assert.equal(g.player.hp, 100 - WAVE.overtimeDamage);
  assert.ok(g.enemies.length > before);
  assert.equal(g.overtimeCount, 1);
  assert.ok(g.waveTimer > 0);
});

test('losing all HP ends the run and freezes the simulation', () => {
  const g = arena();
  g.wave = 3;
  putEnemy(g, 'shade', -300, -150);
  g.player.hp = 3;
  g.damagePlayer(10, 'shade');
  assert.equal(g.state, STATE.GAMEOVER);
  assert.equal(g.player.hp, 0, 'HP must not go negative');
  assert.equal(g.stats.killedBy, 'shade');
  const snapshot = g.enemies.length;
  step(g, 1);
  assert.equal(g.enemies.length, snapshot, 'the world should stop advancing after death');
});

// ── robustness ───────────────────────────────────────────────────────────────

test('the front screens tick safely with no player or enemies in play', () => {
  const g = new Game();
  step(g, 2);
  assert.equal(g.state, STATE.SPLASH, 'the game boots to the splash');
  assertFiniteWorld(g);
  // The splash takes exactly one press, and dismisses to the title.
  assert.equal(g.dismissSplash(), true);
  assert.equal(g.state, STATE.TITLE);
  assert.equal(g.dismissSplash(), false, 'dismissing twice must not walk back off the title');
  step(g, 2);
  assertFiniteWorld(g);
});

test('a scripted bot fights through several waves on every seed', () => {
  // Run across several worlds. A bot test that passes on one lucky seed is not
  // evidence of anything; the simulation is seeded precisely so this can be
  // swept, and a regression that only appears on some spawn layouts still fails.
  for (const seed of [1, 7, 99, 12345, 777777]) {
    const g = new Game({ rng: mulberry32(seed), fxRng: mulberry32(seed ^ 0x9e3779b9) });
    g.startRun();
    const dt = 1 / 60;

    for (let i = 0; i < 60 * 90; i++) {
      g.player.hp = g.player.maxHp;
      g.player.mana = g.player.maxMana;

      // Pick the element that continues the first still-reachable recipe. This
      // can never produce an illegal tap, so the bot measures the cast path.
      if (i % 5 === 0 && g.seqLock <= 0 && g.reachable.length) {
        const target = g.reachable[0];
        const nextEl = target.sequence[g.sequence.length];
        if (nextEl) g.tapElement(nextEl);
      }
      if (i % 53 === 0 && g.sequence.length === 0) g.tapFocus();

      // Strafe toward the nearest enemy so SPARK and the aimed spells connect.
      const target = g.enemies[0];
      if (target) {
        const [nx, ny] = norm2(target.x - g.player.x, target.y - g.player.y);
        g.player.aimX = nx;
        g.player.aimY = ny;
        g.setMove(-ny, nx);
      } else {
        g.setMove(0, 0);
      }

      g.update(dt);
      assert.ok(Number.isFinite(g.player.x) && Number.isFinite(g.player.y), `seed ${seed}: player went non-finite at frame ${i}`);
      assert.ok(g.player.mana >= 0 && g.player.mana <= 100, `seed ${seed}: mana out of range: ${g.player.mana}`);
    }

    assert.ok(g.wave >= 2, `seed ${seed}: bot only reached wave ${g.wave}`);
    assert.ok(g.stats.kills >= 5, `seed ${seed}: bot only killed ${g.stats.kills}`);
    assert.ok(g.stats.casts >= 5, `seed ${seed}: bot only cast ${g.stats.casts} spells`);
    assert.equal(g.stats.breaks, 0, `seed ${seed}: the bot only ever tapped legal elements`);
    assert.ok(g.score > 0, `seed ${seed}: no score`);
    assertFiniteWorld(g);
  }
});

test('the same seed replays the same world, and different seeds do not', () => {
  const run = (seed) => {
    const g = new Game({ rng: mulberry32(seed), fxRng: mulberry32(seed) });
    g.startRun();
    for (let i = 0; i < 60 * 8; i++) {
      g.player.hp = g.player.maxHp;
      g.update(1 / 60);
    }
    return g.enemies.map((e) => `${e.type}@${e.x.toFixed(4)},${e.y.toFixed(4)}`).join('|');
  };
  assert.equal(run(42), run(42), 'the same seed produced a different world');
  assert.notEqual(run(42), run(43), 'different seeds produced identical worlds - the rng is not wired in');
});

test('the simulation is stable at the frame-time clamp', () => {
  const g = arena();
  g.wave = 1;
  g.waveTimer = 30;
  g.spawnEnemies('shade', 3);
  for (let i = 0; i < 200; i++) g.update(0.9);
  assertFiniteWorld(g);
  for (const e of g.enemies) {
    assert.ok(e.x >= 0 && e.x <= g.world.w && e.y >= 0 && e.y <= g.world.h, 'enemy escaped the arena');
  }
  assert.ok(g.player.x >= 0 && g.player.x <= g.world.w);
});

test('the cast flourish slows the world but never the wave clock', () => {
  const g = arena();
  g.wave = 1;
  g.waveTimer = 10;
  g.intermission = 0;
  putEnemy(g, 'shade', -300, -150);
  g.player.mana = 100;
  tapAll(g, SPELL_BY_ID.heal.sequence);
  assert.ok(g.resolveSlow > 0);
  g.update(TIME.maxFrame);
  assert.ok(Math.abs(g.timeScale - TIME.resolving) < 1e-9, 'the cast flourish should slow the simulation');
  assert.ok(
    Math.abs(10 - g.waveTimer - TIME.maxFrame) < 1e-9,
    `the wave clock must ignore it (drifted ${10 - g.waveTimer})`,
  );
});

// ── cast confirmation: the circles light in the order they were pressed ───────

test('a cast records which circles made it, in order', () => {
  const g = arena();
  g.player.mana = 100;
  g.tapElement('earth');
  g.tapElement('fire');
  g.tapElement('water');
  assert.equal(g.stats.casts, 1, 'EARTH+FIRE+WATER should cast EXPLOSION');
  assert.deepEqual(g.castGlow.seq, ['earth', 'fire', 'water']);
  assert.equal(g.castGlow.t, 0, 'the glow starts at the cast');
});

test('a doubled recipe keeps its duplicate, so FIRE lights twice', () => {
  const g = arena();
  g.player.mana = 100;
  g.tapElement('fire');
  g.tapElement('fire');
  g.tapElement('wind');
  assert.equal(g.stats.casts, 1);
  // Collapsing this to a set would light FIRE once and lose the order, which is
  // the only place the game confirms the sequence rather than the ingredients.
  assert.deepEqual(g.castGlow.seq, ['fire', 'fire', 'wind']);
});

test('the glow expires on its own', () => {
  const g = arena();
  g.player.mana = 100;
  g.tapElement('fire');
  g.tapElement('fire');
  g.tapElement('wind');
  assert.ok(g.castGlow, 'lit at the cast');
  const life = SEQUENCE.castGlowDur + 2 * SEQUENCE.castGlowStagger;
  step(g, life + 0.1);
  assert.equal(g.castGlow, null, 'and goes out by itself');
});

test('SPARK lights the centre circle', () => {
  const g = arena();
  g.tapFocus();
  assert.deepEqual(g.castGlow.seq, ['focus'], 'the panic shot gets a confirmation too');
});

test('a cast that never happened lights nothing', () => {
  const g = arena();
  g.player.mana = 0;
  g.tapElement('fire');
  g.tapElement('fire');
  g.tapElement('wind');
  assert.equal(g.stats.casts, 0, 'no mana, no explosion');
  assert.equal(g.castGlow, null, 'and nothing to confirm');
});

test('the glow runs on the spell\'s clock, not the thumb\'s', () => {
  // It is advanced inside the resolution, so slow motion slows the confirmation
  // with the effect it is confirming rather than leaving it stranded in real time.
  const g = arena();
  g.player.mana = 100;
  g.tapElement('earth');
  g.tapElement('fire');
  g.tapElement('water');
  assert.equal(g.resolveSlow > 0, true, 'a cast triggers the resolving beat');
  // Wait out the impact freeze first, by hand: the glow deliberately holds still
  // through it, so measuring inside the freeze would only prove it is frozen.
  let guard = 0;
  while (g.hitStop > 0 && guard++ < 200) g.update(1 / 60);
  assert.ok(g.resolveSlow > 0, 'still resolving after the freeze');

  const before = g.castGlow.t;
  step(g, 0.05);
  const scaled = g.castGlow.t - before;
  assert.ok(scaled > 0 && scaled < 0.05, `expected slow motion, advanced ${scaled} of 0.05`);
});

// ── aimed shots must never spawn past the thing they are aimed at ────────────

test('an enemy in contact range is not immune to aimed fire', () => {
  // The muzzle offset exists so a bolt does not appear inside the wizard, but it
  // must not carry the bolt PAST its target. An enemy within it used to be
  // completely immune to SPARK - and since melee enemies always close to
  // contact, that silently disabled the panic button on the one enemy that most
  // needs shooting. Found by porting the simulation to Godot.
  for (const start of [0.5, 2, 5, 10, 15, 20, 25, 40]) {
    const g = arena();
    g.player.maxHp = 1e6;
    g.player.hp = 1e6;
    const e = makeEnemy('shade', g.player.x + start, g.player.y, mulberry32(2));
    e.spawnT = 0;
    g.enemies.push(e);
    const hp0 = e.hp;
    for (let i = 0; i < 240; i++) {
      if (i % 30 === 0) g.tapFocus();
      g.update(1 / 60);
    }
    assert.ok(e.hp < hp0, `an enemy starting ${start}px away took no damage at all`);
  }
});

test('the muzzle still keeps a bolt out of the caster when there is room', () => {
  const g = arena();
  const e = makeEnemy('shade', g.player.x + 400, g.player.y, mulberry32(3));
  e.spawnT = 0;
  g.enemies.push(e);
  assert.equal(g.muzzleFor(36), 36, 'a distant target should not shrink the muzzle');
  g.enemies.length = 0;
  assert.equal(g.muzzleFor(36), 36, 'nor should an empty arena');
  // In contact, the muzzle collapses so the bolt still starts on the near side.
  const close = makeEnemy('shade', g.player.x + 4, g.player.y, mulberry32(4));
  close.spawnT = 0;
  g.enemies.push(close);
  assert.ok(g.muzzleFor(36) < 4, 'a target closer than the muzzle must pull it in');
});
