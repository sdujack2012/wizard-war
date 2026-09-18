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

import { ENEMY, PLAYER, SEQUENCE, TIME, WAVE, WORLD, waveComposition, waveTimer } from './config.js';
import {
  ELEMENT_BY_ID,
  FOCUS_SPELL,
  MAX_SEQUENCE,
  SPELL_BY_ID,
  isLivePrefix,
  matchSequence,
  reachableSpells,
  spellSpec,
} from './spells.js';
import {
  circleOverlap,
  clamp,
  makeBolt,
  makeEnemy,
  makeEnemyBolt,
  makeParticle,
  makePlayer,
  makeRing,
  makeText,
  newId,
  norm2,
  resetIds,
} from './entities.js';

const STATE = { TITLE: 'title', PLAYING: 'playing', GAMEOVER: 'gameover' };
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

    /** The element taps entered so far, as element ids. */
    this.sequence = [];
    this.seqIdle = 0;
    this.seqLock = 0;
    this.sparkCd = 0;
    this.breakFlash = 0;

    this.wave = 0;
    this.waveTimer = 0;
    this.intermission = 0;
    this.overtimeCount = 0;

    this.score = 0;
    this.stats = { kills: 0, casts: 0, sparks: 0, breaks: 0, fizzles: 0, heals: 0, killedBy: null };
    this.banner = null;
    this.events = [];
    this.flashT = 0;
    this.flashColor = '#fff';
    this.lastCast = null; // {id, name, color, t} for the HUD flourish
  }

  startRun() {
    this.reset();
    this.state = STATE.PLAYING;
    this.intermission = WAVE.firstDelay;
    this.wave = 0;
    this.banner = { text: 'PREPARE THE CIRCLE', sub: 'wave 1 incoming', t: 2.0, max: 2.0, color: '#8fe3ff' };
    this.emit({ type: 'run-start' });
    return this;
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
   * Tap the centre circle: SPARK.
   *
   * Weak, cheap, auto-aimed, and always available. It also wipes any partial
   * sequence, so it doubles as the panic button when you have lost track of a
   * recipe - which is the entire risk/reward of the wheel.
   */
  tapFocus() {
    if (this.state !== STATE.PLAYING) return { ok: false, reason: 'not-playing' };
    if (this.seqLock > 0) return { ok: false, reason: 'locked' };
    if (this.sparkCd > 0) return { ok: false, reason: 'cooldown' };

    if (this.player.mana < FOCUS_SPELL.cost) {
      this.fizzle(FOCUS_SPELL);
      return { ok: false, reason: 'mana' };
    }

    this.player.mana -= FOCUS_SPELL.cost;
    this.sparkCd = SEQUENCE.sparkCooldown;
    this.sequence = [];
    this.seqIdle = 0;
    this.stats.sparks += 1;
    this.castSpark();
    this.emit({ type: 'spark' });
    return { ok: true, reason: '' };
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
        this.rings.push(
          makeRing(p.x, p.y, { radius: spec.radius, startR: spec.radius * 0.14, expandSpeed: spec.radius / 0.22, ttl: 0.45, damage: 0 }, spellColor, 'nova'),
        );
        this.hitStop = spec.hitStop;
        this.shake = Math.max(this.shake, spec.shake);
        this.flashT = 0.16;
        this.flashColor = spellColor;
        this.burst(p.x, p.y, 44, spellColor, 340, 'ember');
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
        this.shake = Math.max(this.shake, spec.shake);
        this.burst(p.x, p.y, 22, spellColor, 200, 'shard');
        this.emit({ type: 'freeze' });
        return;
      }
      default: {
        // Aimed projectiles: fireball and waterball (spark handled above).
        const [dx, dy] = this.aimVector();
        const muzzle = p.radius + (spec.radius ?? 8) + 4;
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
      const d = Math.hypot(e.x - this.player.x, e.y - this.player.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * SPARK: the centre circle. Weak, but it always lands - which is what makes
   * it a real fallback rather than a wasted tap.
   */
  castSpark(color = FOCUS_SPELL.color) {
    const p = this.player;
    const spec = spellSpec('spark');
    const [dx, dy] = this.aimVector();
    const muzzle = p.radius + 6;
    this.bolts.push(makeBolt(p.x + dx * muzzle, p.y + dy * muzzle, dx * spec.speed, dy * spec.speed, spec, color));
    this.linkBolts.push({ x1: p.x, y1: p.y, x2: p.x + dx * muzzle, y2: p.y + dy * muzzle, ttl: 0.14, max: 0.14, color });
    this.shake = Math.max(this.shake, 1.6);
  }

  // ── main update ───────────────────────────────────────────────────────────

  update(dtRealRaw) {
    const dtReal = Math.min(Math.max(dtRealRaw, 0), TIME.maxFrame);

    this.shake = Math.max(0, this.shake - this.shake * TIME.shakeDecay * dtReal - 2 * dtReal);
    this.flashT = Math.max(0, this.flashT - dtReal);
    if (this.banner) {
      this.banner.t -= dtReal;
      if (this.banner.t <= 0) this.banner = null;
    }
    if (this.lastCast) {
      this.lastCast.t -= dtReal;
      if (this.lastCast.t <= 0) this.lastCast = null;
    }

    if (this.hitStop > 0) {
      this.hitStop -= dtReal;
      return;
    }

    const scale = this.resolveSlow > 0 ? TIME.resolving : TIME.normal;
    this.timeScale = scale;
    this.resolveSlow = Math.max(0, this.resolveSlow - dtReal);

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
      this.flashColor = '#ff4d6d';
      this.pushText(this.player.x, this.player.y - 46, 'THE CLOCK BITES', '#ff4d6d', { size: 20, life: 1.2 });
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
      color: '#8fe3ff',
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
      const d = Math.hypot(x - this.player.x, y - this.player.y);
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
    p.x += this.moveX * speed * dt;
    p.y += this.moveY * speed * dt;
    p.x = clamp(p.x, p.radius, this.world.w - p.radius);
    p.y = clamp(p.y, p.radius, this.world.h - p.radius);
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
      // A materialising enemy does not act or deal damage yet.
      const spawning = e.spawnT > 0;
      if (spawning) e.spawnT -= dt;
      if (e.slowT > 0) {
        e.slowT -= dt;
        if (e.slowT <= 0) e.slowFactor = 1;
      }
      if (e.stun > 0) e.stun -= dt;

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
        const dd = Math.hypot(dx, dy);
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
          this.shake = Math.max(this.shake, 6);
        } else {
          this.burst(b.x, b.y, 7, b.color, 150, b.kind === 'waterball' ? 'droplet' : b.kind === 'fireball' ? 'ember' : 'dot');
        }
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
          const d = Math.hypot(e.x - ring.x, e.y - ring.y);
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
      const d = Math.hypot(e.x - x, e.y - y);
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
    this.flashColor = '#ff4d6d';
    this.burst(this.player.x, this.player.y, 60, '#8fe3ff', 300, 'mote');
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
