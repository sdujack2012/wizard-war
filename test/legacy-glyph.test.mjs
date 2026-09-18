/**
 * RETIRED MECHANISM - regression suite for the glyph-casting build.
 *
 * RUNE PRESSURE now casts from an element wheel with tap sequences, so nothing
 * in `src/` imports these modules any more. They are kept, working and tested,
 * because there is no version control in this project and a freehand stroke
 * recogniser is a genuinely useful thing to still have around.
 *
 * Safe to delete `src/legacy/`, this file, and its package.json entry if you
 * are certain the wheel is here to stay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIR_VEC,
  bounds,
  chainDistance,
  classifyStroke,
  densifyPolyline,
  dirDistance,
  jitter,
  pathLength,
  quantizeDir,
  strokeToChain,
  substitutionCost,
} from '../src/legacy/glyph-recognizer.js';
import { RUNES, RUNE_TEMPLATES, RUNE_BY_ID } from '../src/legacy/runes.js';

const SIZE = 120;
const ORIGIN = { x: 240, y: 260 };

/** Turn a rune's normalised guide shape into a synthetic trace. */
function traceOf(runeId, { size = SIZE, seed = 1, noise = 0, step = 4 } = {}) {
  const rune = RUNE_BY_ID[runeId];
  assert.ok(rune, `unknown rune ${runeId}`);
  const pts = rune.shape.map(([nx, ny]) => ({ x: ORIGIN.x + nx * size, y: ORIGIN.y + ny * size }));
  let out = densifyPolyline(pts, step);
  if (noise > 0) out = jitter(out, noise, seed);
  return out;
}

/** Synthetic circle trace: `samples` points around a radius. */
function circleTrace({ radius = 62, samples = 56, sweep = Math.PI * 2, seed = 1, noise = 0 } = {}) {
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const a = (i / samples) * sweep;
    pts.push({ x: ORIGIN.x + Math.cos(a) * radius, y: ORIGIN.y + Math.sin(a) * radius });
  }
  return noise > 0 ? jitter(pts, noise, seed) : pts;
}

// ── direction encoding ───────────────────────────────────────────────────────

test('direction encoding maps the 8 compass points to the documented indices', () => {
  assert.equal(quantizeDir(1, 0), 0, 'E');
  assert.equal(quantizeDir(1, 1), 1, 'SE');
  assert.equal(quantizeDir(0, 1), 2, 'S');
  assert.equal(quantizeDir(-1, 1), 3, 'SW');
  assert.equal(quantizeDir(-1, 0), 4, 'W');
  assert.equal(quantizeDir(-1, -1), 5, 'NW');
  assert.equal(quantizeDir(0, -1), 6, 'N');
  assert.equal(quantizeDir(1, -1), 7, 'NE');
  assert.equal(quantizeDir(0, 0), -1, 'zero vector is not a direction');
  // DIR_VEC must agree with quantizeDir, or the renderer's arrows would lie.
  DIR_VEC.forEach(([x, y], i) => assert.equal(quantizeDir(x, y), i, `DIR_VEC[${i}]`));
});

test('adjacent directions are cheap to confuse, reversals are not', () => {
  assert.equal(substitutionCost(0, 0), 0);
  assert.equal(substitutionCost(0, 1), 1);
  assert.equal(substitutionCost(0, 2), 2.5);
  assert.equal(substitutionCost(0, 4), 6);
  assert.equal(dirDistance(0, 7), 1, 'wraps around the compass');
  assert.equal(dirDistance(0, 4), 4, 'opposites are maximally far');
});

// ── positive recognition ─────────────────────────────────────────────────────

test('every rune is recognised from its own clean guide shape', () => {
  for (const rune of RUNES) {
    const pts = rune.chain === 'circle' ? circleTrace() : traceOf(rune.id);
    const res = classifyStroke(pts, RUNE_TEMPLATES);
    assert.equal(res.id, rune.id, `${rune.name} misread (chain ${JSON.stringify(res.chain)}, kind ${res.kind})`);
    assert.ok(res.confidence >= 0.6, `${rune.name} low confidence ${res.confidence}`);
  }
});

test('recognition survives realistic digitiser noise', () => {
  for (const noise of [0.5, 1.5, 2.5]) {
    for (const rune of RUNES) {
      const pts = rune.chain === 'circle' ? circleTrace({ noise, seed: 7 }) : traceOf(rune.id, { noise, seed: 7 });
      const res = classifyStroke(pts, RUNE_TEMPLATES);
      assert.equal(res.id, rune.id, `${rune.name} misread at noise=${noise} (got ${res.id}, chain ${res.chain})`);
    }
  }
});

test('recognition is scale invariant across phone-sized strokes', () => {
  for (const size of [54, 90, 160, 240]) {
    for (const id of ['ignis', 'glacies', 'terra', 'ventus', 'split']) {
      const res = classifyStroke(traceOf(id, { size }), RUNE_TEMPLATES);
      assert.equal(res.id, id, `${id} misread at size=${size}`);
    }
  }
});

test('a segment drawn 45 degrees sloppy still reads as intended', () => {
  // TERRA is [S, E]; draw the first leg south-east instead of due south.
  const sloppy = densifyPolyline([
    { x: ORIGIN.x, y: ORIGIN.y },
    { x: ORIGIN.x + 66, y: ORIGIN.y + 66 },
    { x: ORIGIN.x + 150, y: ORIGIN.y + 66 },
  ]);
  const res = classifyStroke(sloppy, RUNE_TEMPLATES);
  assert.equal(res.id, 'terra');
  assert.ok(res.cost <= 1.0, `expected a forgiving cost, got ${res.cost}`);
});

test('the NOVA circle is detected even when drawn slightly open', () => {
  const open = circleTrace({ sweep: Math.PI * 1.82 });
  const res = classifyStroke(open, RUNE_TEMPLATES);
  assert.equal(res.id, 'nova');
  assert.equal(res.kind, 'circle');
});

// ── negative / adversarial ───────────────────────────────────────────────────

test('mirrored strokes do not silently become the wrong rune', () => {
  // GLACIES is [SW, SE]; SPLIT is [SE, SW]. They are mirrors, so a reversed
  // draw must fail rather than cast the other spell in your face.
  const glaciesChain = RUNE_BY_ID.glacies.chain;
  const splitChain = RUNE_BY_ID.split.chain;
  assert.equal(strokeToChain(traceOf('glacies')).join(','), glaciesChain.join(','));
  assert.equal(strokeToChain(traceOf('split')).join(','), splitChain.join(','));
  assert.ok(chainDistance(glaciesChain, splitChain) > 1.0, 'mirror images must be far apart');
});

/** Mirror a trace about its own centre - a true "drew it upside down". */
function flipY(points) {
  const cy = bounds(points).cy;
  return points.map((p) => ({ x: p.x, y: 2 * cy - p.y }));
}

test('upside-down guide shapes are rejected, never quietly read as another rune', () => {
  for (const rune of RUNES) {
    if (rune.chain === 'circle') continue;
    const res = classifyStroke(flipY(traceOf(rune.id)), RUNE_TEMPLATES);
    assert.equal(res.id, null, `${rune.name} flipped vertically resolved to ${res.id}`);
  }
});

test('the grimoire icon shapes match the chains the recogniser expects', () => {
  // If these ever drift apart the codex starts lying to the player, which is
  // the single most confusing bug this game could have.
  for (const rune of RUNES) {
    if (rune.chain === 'circle') {
      assert.equal(rune.shape, null, 'the circle rune is drawn as a true circle, not a polyline');
      continue;
    }
    assert.ok(Array.isArray(rune.shape), `${rune.name} needs a guide polyline`);
    const chain = strokeToChain(traceOf(rune.id));
    assert.deepEqual(chain, rune.chain, `${rune.name} icon draws ${chain} but expects ${rune.chain}`);
  }
});

test('a scribble is neither a rune nor a circle', () => {
  const zig = [];
  for (let i = 0; i <= 40; i++) {
    zig.push({ x: ORIGIN.x + i * 4, y: ORIGIN.y + (i % 2 === 0 ? -22 : 22) });
  }
  const res = classifyStroke(zig, RUNE_TEMPLATES);
  assert.equal(res.id, null, `scribble matched ${res.id}`);
  assert.notEqual(res.kind, 'circle');
});

test('a closed shape made of straight legs is not mistaken for a circle', () => {
  // A square is closed and long, but its turning is abrupt - not a circle.
  const square = densifyPolyline([
    { x: 200, y: 200 },
    { x: 320, y: 200 },
    { x: 320, y: 320 },
    { x: 200, y: 320 },
    { x: 200, y: 200 },
  ]);
  assert.notEqual(classifyStroke(square, RUNE_TEMPLATES).kind, 'circle');
});

test('a tap is reported as a tap, not as garbage', () => {
  const tap = [
    { x: 100, y: 100 },
    { x: 101, y: 101 },
    { x: 101.5, y: 100.5 },
  ];
  const res = classifyStroke(tap, RUNE_TEMPLATES);
  assert.equal(res.kind, 'tap');
  assert.equal(res.id, null);
});

test('a straight line matches nothing', () => {
  const line = densifyPolyline([
    { x: 100, y: 100 },
    { x: 260, y: 100 },
  ]);
  const res = classifyStroke(line, RUNE_TEMPLATES);
  assert.equal(res.id, null);
});

// ── chain extraction details ─────────────────────────────────────────────────

test('tiny direction wobble is pruned away instead of splitting a segment', () => {
  const pts = densifyPolyline([
    { x: 200, y: 200 },
    { x: 200, y: 300 },
    { x: 300, y: 300 },
  ]);
  // Inject a 5px sideways twitch mid-leg: far below the pruning threshold.
  const withTwitch = pts.map((p, i) => (i === 25 ? { x: p.x + 5, y: p.y } : p));
  assert.deepEqual(strokeToChain(withTwitch), [2, 0], 'should still be south then east');
});

test('path length and bounds are measured on the raw trace', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 3, y: 4 },
    { x: 3, y: 14 },
  ];
  assert.equal(pathLength(pts), 15);
  const b = bounds(pts);
  assert.deepEqual([b.w, b.h], [3, 14]);
});
