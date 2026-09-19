/**
 * The painted art layer.
 *
 * The whole point of `assets.js` is that the game must not depend on it: the
 * suite runs in Node, where there is no Image constructor and no canvas, and the
 * game still has to boot, render and be playable. These tests pin that down, and
 * pin the two draw-path bugs that only a human looking at the screen would
 * otherwise catch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ASSETS, AssetStore, makeSurface } from '../src/assets.js';
import { drawElementGlyph } from '../src/render.js';

/** A minimal recording 2D context: enough to see fill vs stroke. */
function recorder() {
  const calls = [];
  const target = {
    calls,
    beginPath: () => calls.push('beginPath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    closePath: () => calls.push('closePath'),
    rect: () => calls.push('rect'),
    arc: () => calls.push('arc'),
    quadraticCurveTo: () => calls.push('quadraticCurveTo'),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    fillRect: () => calls.push('fillRect'),
    drawImage: () => calls.push('drawImage'),
  };
  return target;
}

// ── the store must survive having no platform at all ──────────────────────────

test('the asset store loads nothing, and throws nothing, without an Image constructor', async () => {
  delete globalThis.Image; // Node: this is the normal state of affairs
  const store = new AssetStore();
  assert.equal(store.state, 'idle');
  await store.load();
  assert.equal(store.state, 'unsupported');
  assert.equal(store.count, 0);
  for (const id of Object.keys(ASSETS)) {
    assert.equal(store.get(id), null, `${id} reported an image that does not exist`);
    assert.equal(store.variant(id, '#ffffff', 1), null, `${id} produced a tinted variant`);
  }
});

test('a failed decode is treated as a missing asset, not as a zero-sized one', () => {
  const store = new AssetStore();
  store.images.set('wizard', { width: 0, height: 0 });
  assert.equal(store.get('wizard'), null, 'a zero-sized image must fall back to the vector art');
});

test('the manifest points at files that are actually on disk', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  for (const [id, src] of Object.entries(ASSETS)) {
    // Asset URLs carry a `?v=` cache-buster; the query is not part of the path.
    const path = join(here, '..', src.replace(/^\.[/\\]/, '').split('?')[0]);
    const bytes = await readFile(path).catch(() => null);
    assert.ok(bytes, `${id} -> ${src} is in the manifest but not in the repo`);
    assert.ok(bytes.length > 512, `${id} -> ${src} is suspiciously small (${bytes?.length} bytes)`);
  }
});

test('tinted variants are built once and then reused', () => {
  const surfaces = [];
  globalThis.document = {
    createElement: () => {
      const ctx = recorder();
      const surface = { width: 0, height: 0, getContext: () => ctx };
      surfaces.push(surface);
      return surface;
    },
  };
  try {
    const store = new AssetStore();
    store.images.set('wizard', { width: 168, height: 320 });
    const a = store.variant('wizard', '#ffffff', 1);
    const b = store.variant('wizard', '#ffffff', 1);
    assert.ok(a, 'no variant surface was produced');
    assert.equal(a, b, 'the variant was rebuilt instead of cached');
    assert.equal(surfaces.length, 1, `built ${surfaces.length} surfaces for one variant`);
    assert.ok(a.getContext().calls.includes('drawImage'), 'the variant never drew the source sprite');
  } finally {
    delete globalThis.document;
  }
});

test('makeSurface returns null rather than throwing on a platform with no canvas', () => {
  delete globalThis.OffscreenCanvas;
  delete globalThis.document;
  assert.equal(makeSurface(10, 10), null);
});

// ── the glyph bug that a screenshot caught ───────────────────────────────────

test('every element glyph actually marks the canvas', () => {
  // WIND is three open strokes, and the shared tail of this function called
  // fill() on it: an open path has no area, so WIND drew *nothing at all* and
  // its circle sat on the wheel looking empty. Filling and stroking are not
  // interchangeable, and the difference is invisible to every logic test.
  for (const id of ['fire', 'water', 'earth', 'wind', 'focus']) {
    const ctx = recorder();
    drawElementGlyph(ctx, 0, 0, 20, id);
    const marks = ctx.calls.includes('fill') || ctx.calls.includes('stroke');
    assert.ok(marks, `the ${id} glyph marked nothing on the canvas`);
  }

  const wind = recorder();
  drawElementGlyph(wind, 0, 0, 20, 'wind');
  assert.ok(wind.calls.includes('stroke'), 'WIND must be stroked');
  assert.ok(!wind.calls.includes('fill'), 'WIND filled an open path, which draws nothing');

  for (const id of ['fire', 'water', 'earth', 'focus']) {
    const ctx = recorder();
    drawElementGlyph(ctx, 0, 0, 20, id);
    assert.ok(ctx.calls.includes('fill'), `${id} should be a filled shape`);
    assert.ok(!ctx.calls.includes('stroke'), `${id} should not be stroked`);
  }
});

test('every asset URL carries the cache-busting version', async () => {
  const { ART_VERSION } = await import('../src/assets.js');
  assert.ok(ART_VERSION, 'ART_VERSION must be set');
  for (const [id, src] of Object.entries(ASSETS)) {
    assert.match(
      src,
      new RegExp(`[?&]v=${ART_VERSION}$`),
      `${id} -> ${src} is not versioned, so a returning player would keep the old file`,
    );
  }
});

test('the music track is versioned too, or a re-render never reaches anyone', async () => {
  const { MUSIC } = await import('../src/audio.js');
  const { ART_VERSION } = await import('../src/assets.js');
  assert.match(MUSIC.src, new RegExp(`[?&]v=${ART_VERSION}$`), `MUSIC.src is not versioned: ${MUSIC.src}`);
});
