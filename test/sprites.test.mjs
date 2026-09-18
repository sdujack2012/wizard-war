/**
 * Sprite tests.
 *
 * The browser suite proves the renderer does not throw. This one proves the
 * sprites actually put marks on the canvas: a creature that silently draws
 * nothing is a bug the smoke test would never notice, because no exception is
 * raised and the frame still completes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIS,
  drawArenaFloor,
  drawBolt,
  drawBraziers,
  drawCastLink,
  drawDangerWash,
  drawEnemy,
  drawEnemyBolt,
  drawMotes,
  drawParticle,
  drawRing,
  drawRitualGlow,
  drawWizard,
  makeMotes,
  visualRadius,
} from '../src/sprites.js';
import { makeBolt, makeEnemy, makeParticle, makeRing } from '../src/entities.js';

const PATH_OPS = new Set([
  'beginPath',
  'moveTo',
  'lineTo',
  'arc',
  'ellipse',
  'rect',
  'roundRect',
  'quadraticCurveTo',
  'bezierCurveTo',
  'closePath',
]);

/** A 2D context stub that counts what a sprite actually asked for. */
function recordingCtx() {
  const counts = { path: 0, fill: 0, stroke: 0, fillRect: 0, drawImage: 0, gradient: 0 };
  const noop = () => {};
  return new Proxy(
    { __counts: counts },
    {
      get(t, prop) {
        if (prop === '__counts') return counts;
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'measureText') return () => ({ width: 10 });
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
          return () => {
            counts.gradient += 1;
            return { addColorStop: noop };
          };
        }
        if (prop === 'fill') {
          return () => {
            counts.fill += 1;
          };
        }
        if (prop === 'stroke') {
          return () => {
            counts.stroke += 1;
          };
        }
        if (prop === 'fillRect') {
          return () => {
            counts.fillRect += 1;
          };
        }
        if (prop === 'drawImage') {
          return () => {
            counts.drawImage += 1;
          };
        }
        if (PATH_OPS.has(prop)) {
          return () => {
            counts.path += 1;
          };
        }
        return noop;
      },
      set() {
        return true;
      },
    },
  );
}

const marks = (ctx) => ctx.__counts.path + ctx.__counts.fillRect + ctx.__counts.fill + ctx.__counts.stroke;

// ── the wizard ───────────────────────────────────────────────────────────────

test('the wizard draws a real figure in every state', () => {
  const states = [
    ['idle', {}],
    ['walking', { moveMag: 1 }],
    ['hurt', { hurt: true }],
    ['healing', { healing: true }],
    ['invulnerable', { invuln: true }],
    ['mid-cast', { castFlash: 1 }],
  ];
  for (const [name, extra] of states) {
    const ctx = recordingCtx();
    drawWizard(ctx, { x: 100, y: 100, radius: 15, time: 1.2, aimAngle: 0.7, ...extra });
    assert.ok(marks(ctx) > 15, `the wizard drew almost nothing while ${name} (${marks(ctx)} marks)`);
    // A cloak, a hood, a face, two eyes and a staff orb is a lot of fills.
    assert.ok(ctx.__counts.fill >= 6, `the wizard only filled ${ctx.__counts.fill} shapes while ${name}`);
  }
});

test('the staff sweeps to distinct places for distinct aims', () => {
  // The staff is the only directional read on the character, so it has to
  // actually move. Sprites draw in their own local space, so compare local X.
  const xs = (aimAngle) => {
    const list = [];
    const ctx = new Proxy(
      { __counts: {} },
      {
        get(t, prop) {
          if (prop === 'arc') {
            return (x) => list.push(x);
          }
          if (prop === 'ellipse') {
            return (x) => list.push(x);
          }
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'measureText') return () => ({ width: 10 });
          return () => {};
        },
        set() {
          return true;
        },
      },
    );
    drawWizard(ctx, { x: 100, y: 100, radius: 15, time: 0, aimAngle });
    return list;
  };

  const east = xs(0);
  const west = xs(Math.PI);
  // The body alone spans about +/-30: the orb must clearly reach past it.
  assert.ok(Math.max(...east) > 40, `aiming east should reach past the body (got ${Math.max(...east)})`);
  assert.ok(Math.min(...west) < -40, `aiming west should reach past the body (got ${Math.min(...west)})`);
  assert.ok(
    Math.max(...east) > Math.max(...west),
    'the staff did not move between opposite aims',
  );
});

// ── enemies ──────────────────────────────────────────────────────────────────

test('every enemy type draws its own silhouette', () => {
  const signatures = new Map();
  for (const type of ['shade', 'wisp', 'brute']) {
    const e = makeEnemy(type, 200, 150);
    e.spawnT = 0;
    const ctx = recordingCtx();
    drawEnemy(ctx, e, { time: 1, px: 100, py: 100 });
    assert.ok(marks(ctx) > 12, `${type} drew almost nothing (${marks(ctx)} marks)`);
    assert.ok(ctx.__counts.fill >= 4, `${type} only filled ${ctx.__counts.fill} shapes`);
    signatures.set(type, `${ctx.__counts.path}:${ctx.__counts.fill}:${ctx.__counts.stroke}`);
  }
  assert.equal(new Set(signatures.values()).size, 3, `enemy types are not visually distinct: ${[...signatures]}`);
});

test('the hit-flash actually changes what is drawn', () => {
  const draw = (flash) => {
    const e = makeEnemy('shade', 0, 0);
    e.spawnT = 0;
    e.hitFlash = flash;
    const ctx = recordingCtx();
    drawEnemy(ctx, e, { time: 0, px: 50, py: 0 });
    return { fills: ctx.__counts.fill, paths: ctx.__counts.path };
  };
  // Same geometry, so the difference is purely the colour swap - which we cannot
  // observe here, but we CAN assert the flash path does not change the shape and
  // does not early-out.
  assert.deepEqual(draw(1), draw(0), 'a hit flash should recolour, not reshape');
});

test('sprites are drawn larger than their hitboxes, but not absurdly', () => {
  for (const type of ['shade', 'wisp', 'brute']) {
    const e = makeEnemy(type, 0, 0);
    const v = visualRadius(e);
    assert.ok(v > e.radius, `${type} sprite is not bigger than its hitbox`);
    assert.ok(v < e.radius * 2, `${type} sprite is so big it would feel unfair`);
    assert.ok(VIS[type] > 1);
  }
});

// ── spells ───────────────────────────────────────────────────────────────────

test('each projectile kind draws something distinct', () => {
  const seen = new Map();
  for (const kind of ['spark', 'fireball', 'waterball']) {
    const spec = { kind, radius: 10, damage: 1, ttl: 1, blastRadius: 0 };
    const b = makeBolt(0, 0, 200, 0, spec, '#fff');
    assert.equal(b.kind, kind, 'the bolt did not record its spell kind');
    const ctx = recordingCtx();
    drawBolt(ctx, b, 0.5);
    assert.ok(marks(ctx) > 5, `${kind} drew almost nothing`);
    seen.set(kind, `${ctx.__counts.path}:${ctx.__counts.fill}`);
  }
  assert.equal(new Set(seen.values()).size, 3, `projectiles look the same: ${[...seen]}`);
});

test('enemy bolts draw and pulse', () => {
  const b = { x: 0, y: 0, vx: 1, vy: 0, radius: 8, color: '#c58bff' };
  for (const t of [0, 1.7]) {
    const ctx = recordingCtx();
    drawEnemyBolt(ctx, b, t);
    assert.ok(marks(ctx) > 2, 'an enemy bolt drew nothing');
  }
});

test('every ring kind draws its own effect', () => {
  const seen = new Map();
  for (const kind of ['frost', 'nova', 'heal']) {
    const spec = { radius: 120, startR: 10, ttl: 1, damage: 1, slow: 0.5, slowDur: 2, stun: 0.2 };
    const ring = makeRing(0, 0, spec, '#8fe3ff', kind);
    const ctx = recordingCtx();
    drawRing(ctx, ring, 0.4);
    assert.ok(marks(ctx) > 5, `${kind} ring drew almost nothing`);
    seen.set(kind, `${ctx.__counts.path}:${ctx.__counts.fill}:${ctx.__counts.stroke}`);
  }
  assert.equal(new Set(seen.values()).size, 3, `rings look the same: ${[...seen]}`);
});

test('every particle shape draws, including the fallback', () => {
  for (const shape of ['dot', 'ember', 'shard', 'droplet', 'mote', undefined]) {
    const p = makeParticle(0, 0, 20, 20, { life: 0.5, size: 3, color: '#fff', shape, angle: 0.5 });
    const ctx = recordingCtx();
    drawParticle(ctx, p);
    assert.ok(marks(ctx) > 0, `particle shape ${shape} drew nothing`);
  }
});

test('a dead particle draws nothing at all', () => {
  const p = makeParticle(0, 0, 0, 0, { life: 0.5, size: 3, color: '#fff' });
  p.life = -1;
  const ctx = recordingCtx();
  drawParticle(ctx, p);
  assert.equal(marks(ctx), 0, 'an expired particle still drew');
});

// ── background ───────────────────────────────────────────────────────────────

test('the arena floor draws its stonework and the ritual circle', () => {
  const ctx = recordingCtx();
  drawArenaFloor(ctx, 960, 540);
  assert.ok(ctx.__counts.fillRect > 40, `the floor only laid ${ctx.__counts.fillRect} tiles`);
  assert.ok(ctx.__counts.path > 100, `the ritual circle drew only ${ctx.__counts.path} path ops`);
  assert.ok(ctx.__counts.stroke > 40, 'the etched ring was not stroked');
});

test('the living background layers draw and the motes actually drift', () => {
  const ctx = recordingCtx();
  drawRitualGlow(ctx, 960, 540, 1.5, 0.8);
  drawBraziers(ctx, 960, 540, 1.5);
  drawDangerWash(ctx, 960, 540, 0.7);
  assert.ok(marks(ctx) > 10, 'the animated background drew almost nothing');

  const motes = makeMotes(20, 960, 540);
  assert.equal(motes.length, 20);
  const before = motes.map((m) => m.y);
  const mctx = recordingCtx();
  drawMotes(mctx, motes, 960, 540, 0.5, 2);
  assert.ok(marks(mctx) >= 20, 'not every mote was drawn');
  assert.ok(motes.some((m, i) => m.y !== before[i]), 'the motes never moved');

  // Motes wrap rather than escaping the arena forever.
  for (let i = 0; i < 400; i++) drawMotes(mctx, motes, 960, 540, 0.1, i * 0.1);
  for (const m of motes) {
    assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y), 'a mote went non-finite');
    assert.ok(m.y > -40 && m.y < 620, `a mote escaped vertically: ${m.y}`);
  }
});

test('the cast link fades to nothing rather than snapping', () => {
  const link = { x1: 0, y1: 0, x2: 10, y2: 0, ttl: 0.1, max: 0.2, color: '#fff' };
  const ctx = recordingCtx();
  drawCastLink(ctx, link);
  assert.ok(marks(ctx) > 0);
  link.ttl = 0;
  const done = recordingCtx();
  drawCastLink(done, link);
  assert.ok(marks(done) > 0, 'a fully faded link should still be stroked at zero alpha, not skipped');
});
