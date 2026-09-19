/**
 * RUNE PRESSURE - deterministic game simulation.
 *
 * Deliberately free of DOM, canvas and audio references: `main.js` drives it
 * with real input and draws the result, while `node --test` drives it with
 * synthetic input. That keeps the rules testable and the renderer honest.
 *
 * Timing note: the wave clock runs on REAL seconds while the simulation runs on
 * scaled seconds, so the brief cast flourish never buys the player clock time.
 */

import { CHARGE, DECAL, ENEMY, FX, MOTION, PLAYER, SEQUENCE, TIME, WAVE, WORLD, waveComposition, waveTimer } from './config.js';
import {
  ELEMENT_BY_ID,
  FOCUS_SPELL,
  MAX_SEQUENCE,
  SPELL_BY_ID,
  chargeLevel,
  chargedSparkCost,
  chargedSparkSpec,
  isLivePrefix,
  matchSequence,
  reachableSpells,
  spellSpec,
} from './spells.js';
import {
  circleOverlap,
  clamp,
  dist2,
  makeBolt,
  makeEnemy,
  makeEnemyBolt,
  makeParticle,
  makeDecal,
  makePlayer,
  makeRing,
  makeText,
  newId,
  norm2,
  resetIds,
} from './entities.js';

const STATE = {
  /**
   * The splash is the boot screen: full-bleed key art and the logo, shown before
   * anything else and before the audio context has been unlocked. It exists so
   * the first thing on screen is the game rather than a wall of instructions -
   * and because the tap that dismisses it is the gesture that unlocks audio on
   * mobile, which has to be a deliberate press rather than an accidental one.
   */
  SPLASH: 'splash',
  TITLE: 'title',
  PLAYING: 'playing',
  /**
   * The spell book is a REFERENCE screen, not a menu: it freezes the wave so the
   * recipes can be read and, more to the point, watched - the wheel keeps
   * demonstrating the gesture while the world holds still. It is deliberately a
   * state rather than a flag, so every system that already refuses to act
   * outside PLAYING (casting, spawning, the sequence idle timer) is paused by
   * construction instead of by one more condition that could be forgotten.
   */
  SPELLBOOK: 'spellbook',
  GAMEOVER: 'gameover',
};
export { STATE };

export class Game {
  /**
   * @param {{rng?: () => number, fxRng?: () => number}} [opts]
   *   `rng` drives gameplay (spawns, enemy setup) and `fxRng` drives cosmetics
   *   only. Keeping them separate means a balance change cannot silently
   *   reshuffle a seeded run, and a particle cannot move an enemy.
   */
  constructor(opts = {}) {
    this.rng = opts.rng ?? Math.random;
    this.fxRng = opts.fxRng ?? Math.random;
    this.world = { ...WORLD };
    this.reset();
    // Boot screen; reset() leaves us on TITLE, which is what startRun wants.
    this.state = STATE.SPLASH;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  reset() {
    resetIds();
    this.state = STATE.TITLE;
    this.time = 0;
    this.timeScale = 1;
    this.shake = 0;
    this.hitStop = 0;
    this.resolveSlow = 0;
    this.moveX = 0;
    this.moveY = 0;

    this.player = makePlayer(this.world.w / 2, this.world.h / 2);
    this.enemies = [];
    this.bolts = [];
    this.ebolts = [];
    this.rings = [];
    this.particles = [];
    this.texts = [];
    this.linkBolts = []; // cosmetic arcs from the wheel to the caster
    /** Scorch and frost marks left on the floor. Inert: no damage, no collision. */
    this.decals = [];

    /** The element taps entered so far, as element ids. */
    this.sequence = [];
    this.seqIdle = 0;
    this.seqLock = 0;
    this.sparkCd = 0;
    this.breakFlash = 0;

    /**
     * The charged centre circle. `charge` is REAL seconds held (not scaled
     * seconds: the player's thumb does not run in slow motion), and `chargeT`
     * is that mapped to 0..1 for the HUD and the shot.
     */
    this.charging = false;
    this.charge = 0;
    this.chargeT = 0;
    /** Latched so the "full" tell fires once per wind-up, not every frame. */
    this.chargeFull = false;

    /**
     * Which recipe the spell book is currently demonstrating, or null for none.
     * Only meaningful in STATE.SPELLBOOK, and the wheel reads it directly.
     */
    this.spellBookSelected = null;
    /**
     * Seconds since that choice, so the demonstrated gesture can move. Reset by
     * selectSpell, and advanced on REAL time - the book is a paused reference
     * screen, so its animation must not inherit the world's slow motion.
     */
    this.spellBookT = 0;

    /**
     * The circles that made the last cast, lit in the order they were pressed:
     * { seq, t } or null. See SEQUENCE.castGlowDur for why this exists.
     */
    this.castGlow = null;

    this.wave = 0;
    this.waveTimer = 0;
    this.intermission = 0;
    this.overtimeCount = 0;

    this.score = 0;
    this.stats = { kills: 0, casts: 0, sparks: 0, charged: 0, breaks: 0, fizzles: 0, heals: 0, killedBy: null };
    this.banner = null;
    this.events = [];
    this.flashT = 0;
    this.flashColor = '#fff';
    this.lastCast = null; // {id, name, color, t} for the HUD flourish
  }

  /** Leave the splash for the how-to-play screen. A no-op once past it. */
  dismissSplash() {
    if (this.state !== STATE.SPLASH) return false;
    this.state = STATE.TITLE;
    return true;
  }

  startRun() {
    this.reset();
    this.state = STATE.PLAYING;
    this.intermission = WAVE.firstDelay;
    this.wave = 0;
    this.banner = { text: 'PREPARE THE CIRCLE', sub: 'wave 1 incoming', t: 2.0, max: 2.0, color: '#e8c07a' };
    this.emit({ type: 'run-start' });
    return this;
  }

  /**
   * Open the spell book, freezing the wave. Only ever from play, so the book
   * cannot be opened over the splash, the title or a death screen.
   *
   * The partial recipe is deliberately LEFT ALONE. Reading the book is not an
   * action; a player who pauses mid-cast to check a recipe should find the same
   * taps waiting when they come back, and since updateSequence is part of the
   * PLAYING branch the idle timer is frozen too - so it cannot quietly expire
   * while they read.
   */
  openSpellBook() {
    if (this.state !== STATE.PLAYING) return false;
    this.state = STATE.SPELLBOOK;
    this.setMove(0, 0);
    this.cancelCharge();
    this.banner = null;
    this.emit({ type: 'spellbook-open' });
    return true;
  }

  closeSpellBook() {
    if (this.state !== STATE.SPELLBOOK) return false;
    this.state = STATE.PLAYING;
    this.spellBookSelected = null;
    this.emit({ type: 'spellbook-close' });
    return true;
  }

  /**
   * Choose a recipe to watch. Selecting the one already showing puts the wheel
   * back to plain, so the book can be read without a gesture permanently drawn
   * over the controls.
   */
  selectSpell(id) {
    if (this.state !== STATE.SPELLBOOK) return false;
    this.spellBookSelected = this.spellBookSelected === id ? null : id;
    this.spellBookT = 0;
    this.emit({ type: 'spellbook-select', spell: this.spellBookSelected });
    return true;
  }

  emit(ev) {
    this.events.push(ev);
  }

  drainEvents() {
    if (!this.events.length) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  // ── input API ─────────────────────────────────────────────────────────────

  /**
   * Movement intent. Each component is in [-1, 1], and the MAGNITUDE is
   * meaningful: 0.4 means 40% speed. Facing follows the direction only.
   *
   * Preserving magnitude is what makes the stick analog. Normalising here would
   * silently throw away the whole low end of the control's range.
   */
  setMove(x, y) {
    const [nx, ny, len] = norm2(x, y);
    if (len > 0) {
      const mag = Math.min(1, len);
      this.moveX = nx * mag;
      this.moveY = ny * mag;
      this.player.aimX = nx;
      this.player.aimY = ny;
    } else {
      this.moveX = 0;
      this.moveY = 0;
    }
  }

  /**
   * Tap one of the four outer element circles.
   *
   * Three outcomes, and only three:
   *   - the taps now spell something  -> cast it
   *   - the taps are still a live prefix of some spell -> keep waiting
   *   - the taps cannot lead anywhere -> BREAK, and lose a beat
   *
   * @returns {{ok:boolean, reason:string, cast?:string}}
   */
  tapElement(elementId) {
    if (this.state !== STATE.PLAYING) return { ok: false, reason: 'not-playing' };
    // Defensive: reject anything that is not a known element id outright,
    // rather than letting a bad argument quietly become a broken sequence.
    if (!ELEMENT_BY_ID[elementId]) return { ok: false, reason: 'unknown-element' };
    if (this.seqLock > 0) return { ok: false, reason: 'locked' };

    const next = [...this.sequence, elementId];
    const spell = matchSequence(next);

    if (spell) {
      this.sequence = [];
      this.seqIdle = 0;
      this.castSpell(spell);
      return { ok: true, reason: '', cast: spell.id };
    }

    if (isLivePrefix(next) && next.length <= MAX_SEQUENCE) {
      this.sequence = next;
      this.seqIdle = SEQUENCE.idleTimeout;
      this.emit({ type: 'element', element: elementId, index: next.length - 1 });
      return { ok: true, reason: '' };
    }

    this.breakSequence(next);
    return { ok: false, reason: 'broken' };
  }

  /**
   * Press the centre circle: begin winding SPARK up.
   *
   * The press does NOT wipe a partial recipe. The wheel's hit circles tile
   * their disc almost exactly - the seam between an element's inner reach and
   * the centre's outer reach measures 0.2px on every device tried - so the
   * shortest path between two opposite elements runs straight through the
   * centre, and on EXPLOSION and FREEZE that path is half the journey. A thumb
   * that clipped the middle used to lose the whole recipe for it, which
   * punished the geometry rather than the player. The recipe is spent only when
   * the wind-up is actually committed to, at release - see releaseCharge().
   */
  beginCharge() {
    if (this.state !== STATE.PLAYING) return { ok: false, reason: 'not-playing' };
    if (this.seqLock > 0) return { ok: false, reason: 'locked' };
    if (this.sparkCd > 0) return { ok: false, reason: 'cooldown' };
    if (this.charging) return { ok: false, reason: 'charging' };

    this.charging = true;
    this.charge = 0;
    this.chargeT = 0;
    this.chargeFull = false;
    // Deliberately leaves `sequence` and `seqIdle` alone: the idle timer keeps
    // running through the wind-up, so a recipe still expires on its own clock
    // rather than being preserved indefinitely by holding the centre.
    this.emit({ type: 'charge-start' });
    return { ok: true, reason: '' };
  }

  /**
   * Release the centre circle: fire what you wound up.
   *
   * A hold inside `CHARGE.tapTime` is the old SPARK - same damage, same cost,
   * same cooldown - because a panic button whose price depends on how long you
   * happened to press it is not a panic button. Past that the shot scales all
   * the way to CHARGE.*, and the cost scales with it (see config.js for why the
   * charged shot must never be more damage-per-mana than a recipe).
   */
  releaseCharge() {
    if (!this.charging) return { ok: false, reason: 'not-charging' };
    const held = this.charge;
    this.charging = false;
    this.charge = 0;
    this.chargeFull = false;

    if (this.state !== STATE.PLAYING) {
      this.chargeT = 0;
      return { ok: false, reason: 'not-playing' };
    }
    if (this.seqLock > 0) {
      this.chargeT = 0;
      return { ok: false, reason: 'locked' };
    }
    if (this.sparkCd > 0) {
      this.chargeT = 0;
      return { ok: false, reason: 'cooldown' };
    }

    const t = chargeLevel(held);
    const cost = chargedSparkCost(t);
    this.chargeT = 0;

    if (this.player.mana < cost) {
      this.fizzle({ ...FOCUS_SPELL, cost });
      return { ok: false, reason: 'mana' };
    }

    this.player.mana -= cost;
    this.sparkCd = SEQUENCE.sparkCooldown + t * CHARGE.extraCooldown;
    this.stats.sparks += 1;
    if (t > 0) this.stats.charged += 1;
    // A committed wind-up spends the recipe; a tap does not. `t > 0` is exactly
    // "held past CHARGE.tapTime", so a panic tap that clipped the centre leaves
    // whatever you were building intact.
    if (t > 0) this.clearSequence();
    this.castSpark(FOCUS_SPELL.color, chargedSparkSpec(t));
    this.emit({ type: 'spark', charge: t, cost });
    return { ok: true, reason: '', charge: t, cost };
  }

  /**
   * Abandon a wind-up without firing. Losing focus, alt-tabbing or a cancelled
   * pointer must not throw a shot the player did not ask for.
   */
  cancelCharge() {
    if (!this.charging) return false;
    this.charging = false;
    this.charge = 0;
    this.chargeT = 0;
    this.chargeFull = false;
    this.emit({ type: 'charge-cancel' });
    return true;
  }

  /** Real-time wind-up. Called before the hit-stop early-out: freezing the
   *  world on an impact must not freeze the player's thumb. */
  updateCharge(dtReal) {
    if (!this.charging) return;
    this.charge = Math.min(CHARGE.time, this.charge + dtReal);
    this.chargeT = chargeLevel(this.charge);
    if (!this.chargeFull && this.chargeT >= 1) {
      this.chargeFull = true;
      this.emit({ type: 'charge-full' });
    }
  }

  /**
   * Tap the centre circle: SPARK, immediately. Kept as the one-call shorthand -
   * a press and an instant release, which is exactly a tap - so keyboard
   * bindings, tests and anything else that just wants "shoot now" need not know
   * that a charge exists.
   */
  tapFocus() {
    const began = this.beginCharge();
    if (!began.ok) return began;
    return this.releaseCharge();
  }

  /** Abandon the current taps. No penalty; the idle timer does this anyway. */
  clearSequence() {
    if (!this.sequence.length) return false;
    this.sequence = [];
    this.seqIdle = 0;
    this.emit({ type: 'sequence-clear' });
    return true;
  }

  // ── casting ───────────────────────────────────────────────────────────────

  /**
   * A tap that leads nowhere. Costs TIME, never HP: the wheel is a knowledge
   * puzzle, and a fat-finger on a five-button pad should not be a health bar
   * event. The lock is the punishment, and the wave clock keeps running.
   */
  breakSequence(attempted) {
    this.sequence = [];
    this.seqIdle = 0;
    this.seqLock = SEQUENCE.breakLock;
    this.breakFlash = SEQUENCE.breakFlashDur;
    this.stats.breaks += 1;
    this.banner = { text: 'NO SUCH SPELL', sub: '', t: 0.55, max: 0.55, color: '#ff6b81', small: true };
    this.emit({ type: 'sequence-break', attempted });
  }

  castSpell(spell) {
    if (this.player.mana < spell.cost) {
      this.fizzle(spell);
      return;
    }
    this.player.mana -= spell.cost;
    const spec = spellSpec(spell.id);
    this.execute(spec, spell);
    this.stats.casts += 1;
    this.resolveSlow = TIME.resolveSlowDur;
    this.lastCast = { id: spell.id, name: spell.name, color: spell.color, t: 0.9 };
    // Light the circles that made it, in the order they were pressed.
    this.castGlow = { seq: spell.sequence.slice(), t: 0 };
    this.emit({ type: 'cast', spell: spell.id, spec });
  }

  fizzle(spell) {
    this.seqLock = 0.4;
    this.stats.fizzles += 1;
    this.pushText(this.player.x, this.player.y - 34, 'NOT ENOUGH MANA', '#6fd8ff', { size: 15, life: 0.9 });
    this.emit({ type: 'fizzle', spell: spell.id, cost: spell.cost, mana: this.player.mana });
  }

  execute(spec, spell) {
    const p = this.player;
    const spellColor = SPELL_BY_ID[spell.id]?.color ?? spell.color ?? '#ffffff';

    switch (spec.kind) {
      case 'spark': {
        this.castSpark(spellColor);
        return;
      }
      case 'heal': {
        const before = p.hp;
        p.hp = Math.min(p.maxHp, p.hp + spec.heal);
        const gained = Math.round(p.hp - before);
        p.healing = 0.6;
        this.stats.heals += 1;
        this.pushText(p.x, p.y - 36, gained > 0 ? `+${gained}` : 'FULL', '#7bd88f', { size: 20, life: 1.0 });
        this.burst(p.x, p.y, 26, '#7bd88f', 120, 'mote');
        this.rings.push(makeRing(p.x, p.y, { radius: 70, expandSpeed: 190, ttl: 0.6, startR: 10 }, '#7bd88f', 'heal'));
        this.emit({ type: 'heal', amount: gained });
        return;
      }
      case 'explosion': {
        this.burstAoe(p.x, p.y, spec.radius + 14, spec.damage, spec.minDamage, null, {
          knockback: spec.knockback,
          stun: spec.stun,
          from: { x: p.x, y: p.y },
        });
        // Three layers, because one ring reads as a bubble bursting rather than
        // as a detonation: a white-hot shockwave that outruns the fire, the
        // jagged fire ring itself, and a slow dust front left behind by both.
        this.rings.push(
          makeRing(p.x, p.y, { radius: spec.radius * 0.62, startR: 6, expandSpeed: 1450, ttl: 0.16, damage: 0 }, '#ffffff', 'blast'),
        );
        this.rings.push(
          makeRing(
            p.x,
            p.y,
            { radius: spec.radius, startR: spec.radius * 0.14, expandSpeed: spec.radius / 0.22, ttl: 0.45, damage: 0 },
            spellColor,
            'nova',
          ),
        );
        this.rings.push(
          makeRing(p.x, p.y, { radius: spec.radius * 1.5, startR: spec.radius * 0.3, expandSpeed: 220, ttl: 0.9, damage: 0 }, '#9a8f86', 'shockdust'),
        );
        this.hitStop = spec.hitStop;
        this.shake = Math.max(this.shake, spec.shake);
        this.flashT = 0.16;
        this.flashColor = spellColor;
        this.burst(p.x, p.y, 44, spellColor, 340, 'ember');
        // Sparks carry further and faster than embers, and slow smoke rises out
        // of the crater afterwards - the "after" half of the explosion.
        this.burst(p.x, p.y, 16, '#ffe9b0', 620, 'spark');
        this.smoke(p.x, p.y, 14, spec.radius);
        this.addDecal(p.x, p.y, 'scorch', DECAL.explosion.r, DECAL.explosion.ttl, spellColor);
        this.emit({ type: 'explosion' });
        return;
      }
      case 'freeze': {
        this.rings.push(
          makeRing(
            p.x,
            p.y,
            {
              radius: spec.radius,
              startR: 12,
              expandSpeed: spec.expandSpeed,
              ttl: spec.ttl,
              damage: spec.damage,
              slow: spec.slow,
              slowDur: spec.slowDur,
              stun: spec.stun,
            },
            spellColor,
            'frost',
          ),
        );
        // The crystal front is led by a thin bright rim, and the ground it
        // passes over freezes solid - long after the wave is gone.
        this.rings.push(
          makeRing(p.x, p.y, { radius: spec.radius, startR: 10, expandSpeed: spec.expandSpeed * 1.06, ttl: 0.28, damage: 0 }, '#ffffff', 'frostrim'),
        );
        this.shake = Math.max(this.shake, spec.shake);
        this.burst(p.x, p.y, 22, spellColor, 200, 'shard');
        this.burst(p.x, p.y, 10, '#ffffff', 300, 'crystal');
        this.vapour(p.x, p.y, 16, spec.radius);
        this.addDecal(p.x, p.y, 'frost', DECAL.freeze.r, DECAL.freeze.ttl, spellColor);
        this.emit({ type: 'freeze' });
        return;
      }
      default: {
        // Aimed projectiles: fireball and waterball (spark handled above).
        const [dx, dy] = this.aimVector();
        const muzzle = this.muzzleFor(p.radius + (spec.radius ?? 8) + 4);
        this.bolts.push(
          makeBolt(p.x + dx * muzzle, p.y + dy * muzzle, dx * spec.speed, dy * spec.speed, spec, spellColor),
        );
        this.linkBolts.push({ x1: p.x, y1: p.y, x2: p.x + dx * muzzle, y2: p.y + dy * muzzle, ttl: 0.18, max: 0.18, color: spellColor });
        this.shake = Math.max(this.shake, 5);
        this.burst(p.x + dx * muzzle, p.y + dy * muzzle, 12, spellColor, 160, spec.kind === 'waterball' ? 'droplet' : 'ember');
        this.emit({ type: 'projectile', spell: spell.id });
      }
    }
  }

  /**
   * Direction an aimed spell will actually travel.
   *
   * It targets the nearest enemy, and only falls back to your facing when the
   * arena is empty. This matters more than it looks: there is no aiming stick,
   * and `setMove()` overwrites the facing vector every frame, so a
   * movement-derived aim means a spell fired while strafing flies off
   * perpendicular to whatever you were trying to hit. Auto-targeting the nearest
   * threat keeps the skill in the wheel - where it belongs - instead of in an
   * invisible requirement to stand still and face the right way.
   */
  aimVector() {
    const target = this.nearestEnemy();
    if (target) {
      const [dx, dy, len] = norm2(target.x - this.player.x, target.y - this.player.y);
      if (len > 0) return [dx, dy];
    }
    // NOTE: `ay || -1` would be a bug - a due-east aim has ay === 0, which is
    // falsy and would silently rotate every horizontal cast 45 degrees north.
    const [ax, ay, alen] = norm2(this.player.aimX, this.player.aimY);
    return alen > 0 ? [ax, ay] : [0, -1];
  }

  /** Direction to the nearest living enemy, or null. */
  nearestEnemy() {
    let best = null;
    let bestD = Infinity;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = dist2(this.player.x, this.player.y, e.x, e.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * How far in front of the caster an aimed shot actually leaves.
   *
   * The offset exists so a bolt does not appear inside the wizard. It must never
   * push the bolt PAST the thing it is aimed at, though. An enemy in contact
   * range is closer than the muzzle, so the shot spawned on the far side of it
   * and flew away - which made every melee enemy that reached you completely
   * immune to aimed fire, the panic button included. Clamping by the target's
   * distance is what keeps "auto-aimed, so it always lands" true.
   */
  muzzleFor(base) {
    const target = this.nearestEnemy();
    if (!target) return base;
    const d = dist2(this.player.x, this.player.y, target.x, target.y);
    return Math.min(base, Math.max(0, d - target.radius * 0.5));
  }

  /**
   * SPARK, or a charged SPARK: the centre circle. Auto-aimed, so it always
   * lands - which is what makes it a real fallback rather than a wasted tap.
   * The spec is a parameter so the charged shot reuses this path exactly.
   */
  castSpark(color = FOCUS_SPELL.color, spec = spellSpec('spark')) {
    const p = this.player;
    const [dx, dy] = this.aimVector();
    const muzzle = this.muzzleFor(p.radius + 6);
    this.bolts.push(makeBolt(p.x + dx * muzzle, p.y + dy * muzzle, dx * spec.speed, dy * spec.speed, spec, color));
    // SPARK has no recipe, so its one circle is the centre - which still gets the
    // confirmation, because "nothing lit up" and "the cast failed" look alike.
    this.castGlow = { seq: ['focus'], t: 0 };
    this.linkBolts.push({ x1: p.x, y1: p.y, x2: p.x + dx * muzzle, y2: p.y + dy * muzzle, ttl: 0.14, max: 0.14, color });
    // A charged release should be felt in the frame it leaves: the plain dart
    // barely moves the camera, a full charge kicks it.
    this.shake = Math.max(this.shake, 1.6 + (spec.radius - 6) * 0.55);
  }

  // ── main update ───────────────────────────────────────────────────────────

  update(dtRealRaw) {
    const dtReal = Math.min(Math.max(dtRealRaw, 0), TIME.maxFrame);

    // `shakeDecay` lives in FX, not TIME. Reading TIME.shakeDecay produced
    // `0 * undefined = NaN` on the first update and poisoned the field for the
    // rest of the run, so `shake > 0.2` was never true and screen shake never
    // fired at all. Found by porting; noted because a NaN that fails a `>`
    // comparison is the quietest possible way for a feature to be dead.
    this.shake = Math.max(0, this.shake - this.shake * FX.shakeDecay * dtReal - 2 * dtReal);
    this.flashT = Math.max(0, this.flashT - dtReal);
    if (this.banner) {
      this.banner.t -= dtReal;
      if (this.banner.t <= 0) this.banner = null;
    }
    if (this.lastCast) {
      this.lastCast.t -= dtReal;
      if (this.lastCast.t <= 0) this.lastCast = null;
    }

    // Real seconds, and before the hit-stop bail-out below: the wind-up belongs
    // to the thumb, so neither slow motion nor a frozen impact frame may stretch
    // or stall it.
    this.updateCharge(dtReal);

    // The book's demonstration runs on real seconds too, for the same reason:
    // it is a paused screen, so it must not inherit the world's time scale.
    if (this.state === STATE.SPELLBOOK) this.spellBookT += dtReal;

    if (this.hitStop > 0) {
      // Clamped, like every other countdown in this file. An unclamped one leaves
      // a residue whose SIGN is arbitrary - `x - dt` where x came from a chain of
      // earlier subtractions lands on +1e-16 as readily as -1e-16 - and that sign
      // then decides whether the timer has elapsed. Both outcomes are defensible
      // in isolation and they cost a frame of gameplay, which is exactly the kind
      // of ambiguity that makes a port impossible to verify. Surfaced by the
      // Godot port; see the same fix on e.slowT and e.stun below.
      this.hitStop = Math.max(0, this.hitStop - dtReal);
      return;
    }

    const scale = this.resolveSlow > 0 ? TIME.resolving : TIME.normal;
    this.timeScale = scale;
    this.resolveSlow = Math.max(0, this.resolveSlow - dtReal);

    // The cast glow belongs to the SPELL's moment, so it runs on SCALED time with
    // the rest of the resolution: the confirmation should land in step with the
    // effect it is confirming, slow motion included. It is applied here, after
    // `scale` exists - reading it a line earlier would be a temporal dead zone
    // error rather than a stale value, which is the kind of mistake a syntax
    // check cannot see.
    if (this.castGlow) {
      this.castGlow.t += dtReal * scale;
      const life = SEQUENCE.castGlowDur + (this.castGlow.seq.length - 1) * SEQUENCE.castGlowStagger;
      if (this.castGlow.t > life) this.castGlow = null;
    }

    const dt = dtReal * scale;
    this.time += dt;

    if (this.state !== STATE.PLAYING) {
      this.updateFx(dt);
      return;
    }

    this.updateWave(dtReal);
    this.updatePlayer(dt);
    this.updateSequence(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updateRings(dt);
    this.updateFx(dt);
  }

  updateWave(dtReal) {
    if (this.intermission > 0 && this.enemies.length === 0) {
      this.intermission -= dtReal;
      if (this.intermission <= 0) {
        this.spawnWave(this.wave + 1);
      }
      return;
    }

    if (this.wave === 0) return;

    this.waveTimer -= dtReal;

    if (this.enemies.length === 0 && this.intermission <= 0) {
      const bonus = WAVE.clearBonus + Math.round(Math.max(0, this.waveTimer) * 10);
      this.score += bonus;
      this.emit({ type: 'wave-clear', wave: this.wave, bonus });
      this.banner = { text: `WAVE ${this.wave} CLEARED`, sub: `+${bonus}`, t: 1.6, max: 1.6, color: '#8be08b' };
      this.intermission = WAVE.intermission;
      this.overtimeCount = 0;
      return;
    }

    if (this.waveTimer <= 0) {
      this.overtimeCount += 1;
      this.damagePlayer(WAVE.overtimeDamage, 'overtime');
      this.waveTimer = WAVE.overtimeTimer;
      this.shake = Math.max(this.shake, 14);
      this.flashT = 0.25;
      this.flashColor = '#b23a2e';
      this.pushText(this.player.x, this.player.y - 46, 'THE CLOCK BITES', '#b23a2e', { size: 20, life: 1.2 });
      const comp = waveComposition(this.wave);
      const extra = Math.min(WAVE.overtimeSpawns, Math.max(1, Math.round(comp.total * 0.2)));
      this.spawnEnemies('shade', extra);
      this.emit({ type: 'overtime', count: this.overtimeCount });
    }
  }

  spawnWave(n) {
    this.wave = n;
    this.waveTimer = waveTimer(n);
    this.overtimeCount = 0;
    const comp = waveComposition(n);
    let spawned = 0;
    for (const [type, count] of Object.entries(comp)) {
      if (type === 'total') continue;
      spawned += this.spawnEnemies(type, count);
    }
    this.banner = {
      text: `WAVE ${n}`,
      sub: `${spawned} hostiles · ${Math.round(this.waveTimer)}s`,
      t: 1.5,
      max: 1.5,
      color: '#e8c07a',
    };
    this.emit({ type: 'wave-start', wave: n, composition: comp, time: this.waveTimer });
  }

  spawnEnemies(type, count) {
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      if (this.enemies.length >= WAVE.maxAlive) break;
      if (!ENEMY[type]) continue;
      const pos = this.findSpawnPoint();
      this.enemies.push(makeEnemy(type, pos.x, pos.y, this.rng));
      spawned += 1;
    }
    return spawned;
  }

  findSpawnPoint() {
    const m = WAVE.spawnMargin;
    let best = { x: m, y: m };
    let bestD = -1;
    for (let attempt = 0; attempt < 32; attempt++) {
      const t = this.rng() * 4;
      let x;
      let y;
      if (t < 1) {
        x = m + (this.world.w - 2 * m) * t;
        y = m;
      } else if (t < 2) {
        x = this.world.w - m;
        y = m + (this.world.h - 2 * m) * (t - 1);
      } else if (t < 3) {
        x = this.world.w - m - (this.world.w - 2 * m) * (t - 2);
        y = this.world.h - m;
      } else {
        x = m;
        y = this.world.h - m - (this.world.h - 2 * m) * (t - 3);
      }
      const d = dist2(this.player.x, this.player.y, x, y);
      if (d > bestD) {
        bestD = d;
        best = { x, y };
      }
      if (d >= WAVE.minSpawnDist) return { x, y };
    }
    return best;
  }

  updatePlayer(dt) {
    const p = this.player;
    p.invuln = Math.max(0, p.invuln - dt);
    p.hurt = Math.max(0, p.hurt - dt);
    p.flash = Math.max(0, p.flash - dt);
    p.healing = Math.max(0, p.healing - dt);
    p.slowT = Math.max(0, p.slowT - dt);
    p.slowFactor = p.slowT > 0 ? p.slowFactor : 1;
    p.mana = Math.min(p.maxMana, p.mana + PLAYER.manaRegen * dt);

    const speed = PLAYER.speed * p.slowFactor;
    const fromX = p.x;
    const fromY = p.y;
    p.x += this.moveX * speed * dt;
    p.y += this.moveY * speed * dt;
    p.x = clamp(p.x, p.radius, this.world.w - p.radius);
    p.y = clamp(p.y, p.radius, this.world.h - p.radius);

    // Measured AFTER clamping, so walking into a wall does not keep the legs
    // going: the walk cycle is driven by ground actually covered.
    this.measureTravel(p, fromX, fromY, dt, MOTION.stride.wizard);
  }

  /**
   * Record how far an actor actually travelled this frame, advance its walk
   * cycle by that distance, and kick up dust on each footfall.
   *
   * Shared by the player and the enemies because every creature in this game
   * moves the same way - the only difference is how long a stride is.
   */
  measureTravel(actor, fromX, fromY, dt, stride) {
    const dx = actor.x - fromX;
    const dy = actor.y - fromY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    actor.speedNow = dt > 0 ? dist / dt : 0;
    if (dist > 1e-6) {
      actor.vxNow = dx / dt;
      actor.vyNow = dy / dt;
    } else {
      // Decay rather than snap: an actor that stops dead would otherwise stop
      // leaning in the same frame, which pops.
      actor.vxNow *= 0.6;
      actor.vyNow *= 0.6;
    }

    const before = actor.gait;
    actor.gait += dist / stride;

    // Footfalls land twice per stride (left foot, right foot).
    const crossings = Math.floor(actor.gait * MOTION.dustPerStride / 2) - Math.floor(before * MOTION.dustPerStride / 2);
    if (crossings <= 0 || dist <= 0) return;
    if (actor.speedNow < PLAYER.speed * MOTION.moveThreshold * 0.5) return;

    for (let i = 0; i < Math.min(crossings, 2); i++) {
      this.footfall(actor, fromX, fromY);
    }
  }

  /** A small puff of dust where a foot just landed. Cosmetic only. */
  footfall(actor, fromX, fromY) {
    const r = this.fxRng;
    for (let i = 0; i < MOTION.dustParticles; i++) {
      const a = r() * Math.PI * 2;
      const sp = 8 + r() * 26;
      this.particles.push(
        makeParticle(
          fromX + (r() - 0.5) * actor.radius,
          actor.y + actor.radius * 0.7 + (r() - 0.5) * 4,
          Math.cos(a) * sp,
          Math.sin(a) * sp * 0.4 - 6,
          {
            life: 0.32 + r() * 0.26,
            size: 2 + r() * 2.6,
            color: '#8b9bb4',
            shape: 'dust',
            drag: 3.4,
          },
        ),
      );
    }
  }

  updateSequence(dt) {
    if (this.seqLock > 0) {
      this.seqLock -= dt;
      if (this.seqLock < 0) this.seqLock = 0;
    }
    if (this.sparkCd > 0) this.sparkCd = Math.max(0, this.sparkCd - dt);
    if (this.breakFlash > 0) this.breakFlash = Math.max(0, this.breakFlash - dt);

    if (this.sequence.length) {
      this.seqIdle -= dt;
      // An abandoned recipe fades away silently. No penalty for changing your
      // mind, because that is not a mistake - it is a decision.
      if (this.seqIdle <= 0) {
        this.sequence = [];
        this.emit({ type: 'sequence-expire' });
      }
    }
  }

  updateEnemies(dt) {
    const p = this.player;
    for (const e of this.enemies) {
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      e.bob += dt * 4;
      const fromX = e.x;
      const fromY = e.y;
      // A materialising enemy does not act or deal damage yet.
      const spawning = e.spawnT > 0;
      if (spawning) e.spawnT -= dt;
      if (e.slowT > 0) {
        e.slowT = Math.max(0, e.slowT - dt);
        if (e.slowT <= 0) e.slowFactor = 1;
      }
      if (e.stun > 0) e.stun = Math.max(0, e.stun - dt);

      // Knockback decays exponentially.
      e.x += e.kx * dt;
      e.y += e.ky * dt;
      const decay = Math.exp(-7 * dt);
      e.kx *= decay;
      e.ky *= decay;

      if (!spawning && e.stun <= 0) {
        const [ux, uy, d] = norm2(p.x - e.x, p.y - e.y);
        const speed = e.speed * e.slowFactor;
        if (e.type === 'wisp') {
          const standoff = ENEMY.wisp.standoff;
          if (d > standoff + 40) {
            e.x += ux * speed * dt;
            e.y += uy * speed * dt;
          } else if (d < standoff - 40) {
            e.x -= ux * speed * dt;
            e.y -= uy * speed * dt;
          } else {
            e.x += -uy * e.strafe * speed * dt;
            e.y += ux * e.strafe * speed * dt;
          }
          e.fireT -= dt;
          if (e.fireT <= 0 && d < standoff + 180) {
            e.fireT = ENEMY.wisp.fireInterval * (0.75 + this.rng() * 0.5);
            const spec = ENEMY.wisp;
            this.ebolts.push(makeEnemyBolt(e.x, e.y, ux * spec.boltSpeed, uy * spec.boltSpeed, spec, spec.color));
            this.emit({ type: 'enemy-fire' });
          }
        } else {
          e.x += ux * speed * dt;
          e.y += uy * speed * dt;
        }
      }

      // Enemies shoulder past each other instead of stacking into one blob.
      for (const o of this.enemies) {
        if (o === e || o.id <= e.id) continue;
        const dx = o.x - e.x;
        const dy = o.y - e.y;
        const minD = e.radius + o.radius;
        const dd = Math.sqrt(dx * dx + dy * dy);
        if (dd > 0 && dd < minD) {
          const push = ((minD - dd) / 2) * 0.6;
          const nx = dx / dd;
          const ny = dy / dd;
          e.x -= nx * push;
          e.y -= ny * push;
          o.x += nx * push;
          o.y += ny * push;
        }
      }

      e.x = clamp(e.x, e.radius, this.world.w - e.radius);
      e.y = clamp(e.y, e.radius, this.world.h - e.radius);

      // Walk cycle from ground actually covered, same as the player. Measured
      // after the shove-apart and the clamp, so a crowd shuffling against each
      // other still moves its feet at the speed it is really moving.
      this.measureTravel(e, fromX, fromY, dt, MOTION.stride[e.type] ?? MOTION.stride.shade);

      if (!spawning && circleOverlap(p.x, p.y, p.radius, e.x, e.y, e.radius)) {
        this.damagePlayer(e.contactDps * dt, e.type);
      }
    }
  }

  updateProjectiles(dt) {
    const p = this.player;

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.ttl -= dt;
      b.life += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.ttl <= 0 || b.x < -40 || b.y < -40 || b.x > this.world.w + 40 || b.y > this.world.h + 40) {
        this.bolts.splice(i, 1);
        continue;
      }
      let consumed = false;
      // Breaking immediately after damageEnemy() splices this.enemies is safe;
      // the reverse loop plus the break is what keeps it safe.
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (!circleOverlap(b.x, b.y, b.radius, e.x, e.y, e.radius)) continue;
        this.damageEnemy(e, b.damage, { source: b.blastRadius > 0 ? 'fireball' : 'bolt' });

        if (b.knockback > 0) {
          const [knx, kny] = norm2(e.x - b.x, e.y - b.y);
          e.kx += knx * b.knockback;
          e.ky += kny * b.knockback;
        }
        if (b.slow > 0) {
          e.slowFactor = Math.min(e.slowFactor, 1 - b.slow);
          e.slowT = Math.max(e.slowT, b.slowDur);
        }
        if (b.blastRadius > 0) {
          this.burstAoe(b.x, b.y, b.blastRadius, b.blastDamage, b.blastDamage, e, {
            knockback: 120,
            knockbackFrom: { x: b.x, y: b.y },
          });
          this.burst(b.x, b.y, 18, b.color, 220, 'ember');
          this.rings.push(
            makeRing(
              b.x,
              b.y,
              {
                radius: b.blastRadius * 0.78,
                startR: b.blastRadius * 0.34,
                expandSpeed: b.blastRadius * 3.4,
                ttl: 0.26,
                damage: 0,
              },
              b.color,
              'impactfire',
            ),
          );
          this.shake = Math.max(this.shake, 6);
        } else {
          this.burst(b.x, b.y, 7, b.color, 150, b.kind === 'waterball' ? 'droplet' : b.kind === 'fireball' ? 'ember' : 'dot');
          // Water arrives as a mass, so its splash spreads fast and stops: a
          // hit, not a bomb.
          this.rings.push(
            makeRing(
              b.x,
              b.y,
              {
                radius: b.radius * 2.7,
                startR: b.radius * 1.5,
                expandSpeed: b.radius * 7,
                ttl: 0.22,
                damage: 0,
              },
              b.color,
              'impactwater',
            ),
          );
        }
        // The sound of the spell ARRIVING. Emitted from here rather than derived
        // from the cast, because a projectile that misses never reaches this
        // point - which is exactly the distinction the cue exists to make.
        this.emit({ type: 'spell-hit', spell: b.kind });
        consumed = true;
        break;
      }
      if (consumed) this.bolts.splice(i, 1);
    }

    for (let i = this.ebolts.length - 1; i >= 0; i--) {
      const b = this.ebolts[i];
      b.ttl -= dt;
      b.life += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.ttl <= 0 || b.x < -40 || b.y < -40 || b.x > this.world.w + 40 || b.y > this.world.h + 40) {
        this.ebolts.splice(i, 1);
        continue;
      }
      if (circleOverlap(b.x, b.y, b.radius, p.x, p.y, p.radius)) {
        if (p.invuln <= 0) this.damagePlayer(b.damage, 'bolt');
        this.burst(b.x, b.y, 8, b.color, 160, 'dot');
        this.ebolts.splice(i, 1);
      }
    }
  }

  updateRings(dt) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.ttl -= dt;
      if (ring.r < ring.maxR) ring.r = Math.min(ring.maxR, ring.r + ring.expandSpeed * dt);
      if (ring.damage > 0) {
        // Backwards by index: damageEnemy() splices this.enemies.
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const e = this.enemies[j];
          if (ring.hit.has(e.id)) continue;
          const d = dist2(ring.x, ring.y, e.x, e.y);
          if (d <= ring.r + e.radius) {
            ring.hit.add(e.id);
            this.damageEnemy(e, ring.damage, { source: ring.kind });
            if (ring.slow > 0) {
              e.slowFactor = Math.min(e.slowFactor, 1 - ring.slow);
              e.slowT = Math.max(e.slowT, ring.slowDur);
            }
            if (ring.stun > 0) e.stun = Math.max(e.stun, ring.stun);
          }
        }
      }
      if (ring.ttl <= 0) this.rings.splice(i, 1);
    }
  }

  updateFx(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      q.life -= dt;
      if (q.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      const drag = Math.exp(-q.drag * dt);
      q.vx *= drag;
      q.vy *= drag;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.spin) q.angle += q.spin * dt;
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.texts.splice(i, 1);
        continue;
      }
      t.y += t.vy * dt;
      t.vy *= 0.94;
    }
    for (let i = this.linkBolts.length - 1; i >= 0; i--) {
      const l = this.linkBolts[i];
      l.ttl -= dt;
      if (l.ttl <= 0) this.linkBolts.splice(i, 1);
    }
    // Decals outlive everything else on purpose: the scorch is still there when
    // the next wave walks over it.
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.ttl -= dt;
      if (d.ttl <= 0) this.decals.splice(i, 1);
    }
    if (this.particles.length > 420) this.particles.splice(0, this.particles.length - 420);
  }

  // ── damage plumbing ───────────────────────────────────────────────────────

  /**
   * Radial burst. Iterates backwards by index because damageEnemy() splices
   * this.enemies - an ascending for...of silently skips every enemy after a kill.
   */
  burstAoe(x, y, radius, maxDamage, minDamage, exclude, opts = {}) {
    let hits = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      // A materialising enemy is drawn on screen, so it must be hittable.
      // Only its AI and its contact damage wait for the spawn to finish.
      if (e === exclude || e.dead) continue;
      const d = dist2(x, y, e.x, e.y);
      if (d > radius + e.radius) continue;
      const falloff = clamp(1 - d / radius, 0, 1);
      this.damageEnemy(e, minDamage + (maxDamage - minDamage) * falloff, { source: 'aoe' });
      if (opts.knockback) {
        const from = opts.knockbackFrom ?? opts.from ?? { x, y };
        const [nx, ny] = norm2(e.x - from.x, e.y - from.y);
        e.kx += nx * opts.knockback * (0.4 + 0.6 * falloff);
        e.ky += ny * opts.knockback * (0.4 + 0.6 * falloff);
      }
      if (opts.stun) e.stun = Math.max(e.stun, opts.stun);
      hits += 1;
    }
    return hits;
  }

  damageEnemy(e, amount, meta = {}) {
    if (e.dead) return;
    const dealt = amount * (1 - (e.armor ?? 0));
    e.hp -= dealt;
    e.hitFlash = 0.14;
    if (meta.source === 'aoe' || meta.source === 'fireball') {
      this.pushText(e.x, e.y - e.radius - 6, String(Math.round(dealt)), '#ffd9a8', { size: 14 });
    }
    if (e.hp <= 0) {
      e.dead = true;
      const idx = this.enemies.indexOf(e);
      if (idx >= 0) this.enemies.splice(idx, 1);
      this.stats.kills += 1;
      this.score += e.score;
      this.burst(e.x, e.y, 18, e.color, 190, 'dot');
      this.pushText(e.x, e.y - e.radius, `+${e.score}`, e.color, { size: 14, life: 0.7 });
      this.emit({ type: 'kill', enemy: e.type, score: e.score });
    }
  }

  damagePlayer(amount, source) {
    if (this.state !== STATE.PLAYING) return;
    const p = this.player;
    if (p.invuln > 0 && source === 'bolt') return;
    p.hp -= amount;
    p.hurt = Math.max(p.hurt, 0.22);
    if (amount >= 2) this.emit({ type: 'player-hit', amount, source });
    if (p.hp <= 0) {
      p.hp = 0;
      this.killPlayer(source);
    }
  }

  killPlayer(source) {
    if (this.state === STATE.GAMEOVER) return;
    this.state = STATE.GAMEOVER;
    this.sequence = [];
    this.stats.killedBy = source;
    this.shake = 26;
    this.flashT = 0.4;
    this.flashColor = '#b23a2e';
    this.burst(this.player.x, this.player.y, 60, '#e8c07a', 300, 'mote');
    this.emit({ type: 'death', source, wave: this.wave, score: this.score });
  }

  pushText(x, y, text, color, opts) {
    this.texts.push(makeText(x, y, text, color, opts));
  }

  /**
   * Cosmetic particle spray.
   * `shape` picks the sprite so each element leaves its own fingerprint: embers
   * for fire, splinters for ice, droplets for water, motes for healing.
   */
  burst(x, y, count, color, speed, shape = 'dot') {
    for (let i = 0; i < count; i++) {
      const a = this.fxRng() * Math.PI * 2;
      const s = speed * (0.35 + this.fxRng() * 0.85);
      this.particles.push(
        makeParticle(x, y, Math.cos(a) * s, Math.sin(a) * s, {
          life: 0.32 + this.fxRng() * 0.5,
          size: 1.6 + this.fxRng() * 3.4,
          color,
          shape,
          angle: this.fxRng() * Math.PI * 2,
          spin: (this.fxRng() - 0.5) * 12,
        }),
      );
    }
  }

  /** Slow, rising smoke: the half of an explosion that happens afterwards. */
  smoke(x, y, count, radius) {
    for (let i = 0; i < count; i++) {
      const a = this.fxRng() * Math.PI * 2;
      const d = this.fxRng() * radius * 0.7;
      this.particles.push(
        makeParticle(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.6, Math.cos(a) * 14, -18 - this.fxRng() * 26, {
          life: 0.9 + this.fxRng() * 1.1,
          size: 6 + this.fxRng() * 12,
          color: '#3a3630',
          shape: 'smoke',
          drag: 0.8,
          spin: (this.fxRng() - 0.5) * 2.4,
          angle: this.fxRng() * Math.PI * 2,
        }),
      );
    }
  }

  /** Cold vapour sublimating off a freeze: slow, bright, drifting upward. */
  vapour(x, y, count, radius) {
    for (let i = 0; i < count; i++) {
      const a = this.fxRng() * Math.PI * 2;
      const d = this.fxRng() * radius * 0.8;
      this.particles.push(
        makeParticle(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.6, Math.cos(a) * 10, -12 - this.fxRng() * 20, {
          life: 1.0 + this.fxRng() * 1.2,
          size: 5 + this.fxRng() * 11,
          color: '#bfeaff',
          shape: 'vapour',
          drag: 0.7,
          spin: (this.fxRng() - 0.5) * 1.6,
          angle: this.fxRng() * Math.PI * 2,
        }),
      );
    }
  }

  /**
   * Leave a mark on the floor. Oldest first out at the cap, so a long run with
   * a lot of casting cannot slowly accumulate decals until the frame budget dies.
   */
  addDecal(x, y, kind, r, ttl, color) {
    this.decals.push(
      makeDecal(x, y, {
        kind,
        r,
        ttl,
        color,
        rot: this.fxRng() * Math.PI * 2,
        seed: Math.floor(this.fxRng() * 100000),
      }),
    );
    if (this.decals.length > DECAL.max) this.decals.splice(0, this.decals.length - DECAL.max);
  }

  // ── read-only helpers for the HUD ─────────────────────────────────────────

  get enemiesRemaining() {
    return this.enemies.length;
  }

  /** Spells still reachable from the taps entered so far. */
  get reachable() {
    return reachableSpells(this.sequence);
  }

  /** True when the next element tap would complete a spell. */
  get oneAwayFromCast() {
    return this.sequence.length === MAX_SEQUENCE - 1 && this.reachable.length > 0;
  }
}
