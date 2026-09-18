/**
 * Browser smoke test.
 *
 * There is no real DOM here: we install a fake window/document/canvas whose 2D
 * context is a Proxy that records nothing but *does* honour save/restore. That
 * is enough to catch the class of bug the pure-logic tests cannot see - a
 * misspelled draw call, a renderer method that does not exist, an input handler
 * that throws, or a state leak through globalAlpha.
 *
 * The wheel is driven the way a thumb would drive it: through real pointer
 * events at the on-screen coordinates the renderer reports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// ── fake browser environment ─────────────────────────────────────────────────

function makeContext() {
  const state = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillStyle: '#000',
    strokeStyle: '#000',
    shadowBlur: 0,
    shadowColor: '#000',
    lineDashOffset: 0,
  };
  const calls = new Map();
  const stack = [];
  const gradient = { addColorStop() {} };

  const record = (name) => calls.set(name, (calls.get(name) ?? 0) + 1);
  const target = { ...state, __calls: calls };

  const api = {
    save() {
      stack.push({ ...target });
      record('save');
    },
    restore() {
      const s = stack.pop();
      if (s) {
        for (const [k, v] of Object.entries(s)) if (k !== '__calls') target[k] = v;
      }
      record('restore');
    },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => gradient,
    measureText: (t) => ({ width: String(t).length * 6 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  };

  return new Proxy(target, {
    get(t, prop) {
      if (prop in api) return api[prop];
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      return (...args) => {
        record(prop);
        void args;
      };
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
    has: () => true,
  });
}

function makeCanvas(w, h) {
  const ctx = makeContext();
  const listeners = new Map();
  return {
    clientWidth: w,
    clientHeight: h,
    width: w,
    height: h,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (arr) listeners.set(type, arr.filter((f) => f !== fn));
    },
    __ctx: ctx,
    __fire(type, ev) {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    },
  };
}

function installBrowser({ w = 900, h = 420 } = {}) {
  let rafCallback = null;
  let now = 0;
  const windowListeners = new Map();
  const store = new Map();

  const win = {
    innerWidth: w,
    innerHeight: h,
    devicePixelRatio: 2,
    requestAnimationFrame(fn) {
      rafCallback = fn;
      return 1;
    },
    cancelAnimationFrame() {
      rafCallback = null;
    },
    setTimeout(fn) {
      fn();
      return 1;
    },
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = windowListeners.get(type);
      if (arr) windowListeners.set(type, arr.filter((f) => f !== fn));
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
  };

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    performance: globalThis.performance,
    ResizeObserver: globalThis.ResizeObserver,
  };

  globalThis.window = win;
  globalThis.document = { hidden: false, addEventListener() {} };
  globalThis.performance = { now: () => now };
  globalThis.ResizeObserver = undefined; // exercise the typeof guard

  const canvas = makeCanvas(w, h);
  return {
    window: win,
    canvas,
    advance(frames = 1, dtMs = 16.7) {
      for (let i = 0; i < frames; i++) {
        now += dtMs;
        const cb = rafCallback;
        assert.ok(typeof cb === 'function', 'no animation frame was scheduled');
        rafCallback = null;
        cb(now);
      }
    },
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.performance = previous.performance;
      globalThis.ResizeObserver = previous.ResizeObserver;
    },
  };
}

function pointer(canvas, type, x, y, pointerId = 1) {
  canvas.__fire(type, {
    clientX: x,
    clientY: y,
    pointerId,
    preventDefault() {},
    getCoalescedEvents: () => [],
  });
}

/** Centre of a wheel button, in screen coordinates. */
function buttonAt(renderer, id) {
  const b = renderer.wheelLayout().buttons.find((x) => x.id === id);
  assert.ok(b, `no wheel button called ${id}`);
  return { x: b.x, y: b.y, r: b.r };
}

/** One tap: down and up, exactly like a thumb. */
function tap(canvas, renderer, id, pointerId = 40) {
  const p = buttonAt(renderer, id);
  pointer(canvas, 'pointerdown', p.x, p.y, pointerId);
  pointer(canvas, 'pointerup', p.x, p.y, pointerId);
}

/** Tap a full recipe. */
function castRecipe(canvas, renderer, spell, basePointer = 60) {
  spell.sequence.forEach((el, i) => tap(canvas, renderer, el, basePointer + i));
}

/** Boot the game and get past the title screen. */
async function bootPlaying(env) {
  const { boot } = await import('../src/main.js');
  const api = await boot(env.canvas);
  env.advance(2);
  pointer(env.canvas, 'pointerdown', 200, 200, 1);
  pointer(env.canvas, 'pointerup', 200, 200, 1);
  env.advance(4);
  assert.equal(api.game.state, 'playing', 'failed to start a run');
  return api;
}

// ── tests ────────────────────────────────────────────────────────────────────

test('the movement stick is analog end to end', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game } = api;
    const r = api.input.stickRadius;

    // Inside the dead zone the mage must hold perfectly still.
    pointer(env.canvas, 'pointerdown', 150, 260, 5);
    pointer(env.canvas, 'pointermove', 150 + r * 0.1, 260, 5);
    assert.equal(game.moveX, 0, 'a resting thumb inside the dead zone caused drift');
    assert.equal(api.input.stick.magnitude, 0);

    // Mid deflection is a real, intermediate speed.
    pointer(env.canvas, 'pointermove', 150 + r * 0.55, 260, 5);
    const mid = game.moveX;
    assert.ok(mid > 0.2 && mid < 0.85, `mid deflection gave ${mid.toFixed(2)}, expected a partial speed`);

    // Full tilt is top speed.
    pointer(env.canvas, 'pointermove', 150 + r, 260, 5);
    assert.ok(Math.abs(game.moveX - 1) < 0.02, `full tilt gave ${game.moveX.toFixed(2)}`);

    // Over-dragging past the rim is harmless.
    pointer(env.canvas, 'pointermove', 150 + r * 4, 260, 5);
    assert.ok(Math.abs(game.moveX - 1) < 0.02, 'over-dragging changed the speed');

    pointer(env.canvas, 'pointerup', 150 + r * 4, 260, 5);
    assert.equal(game.moveX, 0, 'releasing must stop the mage');
  } finally {
    env.restore();
  }
});

test('mid deflection really does travel less far than full tilt', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game } = api;
    const r = api.input.stickRadius;

    const travel = (deflection) => {
      game.player.x = 200; // reset well clear of the arena edge
      pointer(env.canvas, 'pointerdown', 100, 260, 5);
      pointer(env.canvas, 'pointermove', 100 + r * deflection, 260, 5);
      const x0 = game.player.x;
      env.advance(20);
      pointer(env.canvas, 'pointerup', 100 + r * deflection, 260, 5);
      return game.player.x - x0;
    };

    const full = travel(1);
    const mid = travel(0.55);
    assert.ok(full > 40, `full tilt barely moved (${full.toFixed(1)})`);
    assert.ok(mid < full * 0.85, `mid deflection (${mid.toFixed(1)}) was not meaningfully slower than full (${full.toFixed(1)})`);
    assert.ok(mid > full * 0.15, `mid deflection (${mid.toFixed(1)}) was too slow to be useful`);
  } finally {
    env.restore();
  }
});

test('boots, ticks, and survives every screen state without throwing', async () => {
  const env = installBrowser();
  try {
    const { boot } = await import('../src/main.js');
    const { SPELL_BY_ID } = await import('../src/spells.js');
    const api = await boot(env.canvas);
    const { game, renderer } = api;
    assert.equal(game.state, 'title');
    assert.ok(env.canvas.__ctx.__calls.get('fillRect') > 0, 'the title screen actually drew something');

    env.advance(30);

    // Portrait must hit the rotate-hint path and return early.
    env.canvas.clientWidth = 400;
    env.canvas.clientHeight = 880;
    renderer.resize();
    env.advance(2);

    env.canvas.clientWidth = 900;
    env.canvas.clientHeight = 420;
    renderer.resize();
    pointer(env.canvas, 'pointerdown', 200, 200, 1);
    pointer(env.canvas, 'pointerup', 200, 200, 1);
    assert.equal(game.state, 'playing');

    env.advance(130);
    assert.equal(game.wave, 1);
    assert.ok(game.enemies.length > 0, 'wave 1 should have spawned');

    // Every enemy type on the field, so all three draw branches run.
    game.enemies.length = 0;
    game.spawnEnemies('shade', 2);
    game.spawnEnemies('wisp', 2);
    game.spawnEnemies('brute', 1);
    env.advance(40);

    // Every spell, through real wheel taps.
    let expectedCasts = 0;
    for (const id of ['fireball', 'waterball', 'heal', 'explosion', 'freeze']) {
      game.player.mana = 100;
      game.seqLock = 0;
      game.sequence.length = 0;
      castRecipe(env.canvas, renderer, SPELL_BY_ID[id]);
      expectedCasts += 1;
      assert.equal(game.stats.casts, expectedCasts, `${id} did not cast from a wheel tap`);
      env.advance(6);
    }
    env.advance(40);

    // A broken sequence, so the red flash and lockout paths are covered.
    game.seqLock = 0;
    game.sequence.length = 0;
    tap(env.canvas, renderer, 'wind', 90);
    tap(env.canvas, renderer, 'wind', 91);
    env.advance(4);
    assert.ok(game.stats.breaks >= 1, 'an illegal sequence should break');

    // Death and the game-over screen, with a real score to persist.
    const { makeEnemy } = await import('../src/entities.js');
    const victim = makeEnemy('shade', game.player.x + 8, game.player.y);
    game.enemies.push(victim);
    game.damageEnemy(victim, 9999);
    assert.ok(game.score > 0, 'a kill should have scored');

    game.player.hp = 1;
    game.damagePlayer(10, 'shade');
    assert.equal(game.state, 'gameover');
    env.advance(30);

    pointer(env.canvas, 'pointerdown', 400, 200, 3);
    pointer(env.canvas, 'pointerup', 400, 200, 3);
    assert.equal(game.state, 'playing');
    env.advance(20);
    assert.ok(env.window.localStorage.getItem('rune-pressure.best') !== null);
  } finally {
    env.restore();
  }
});

test('every recipe casts from wheel taps, and the centre circle fires SPARK', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const { SPELL_BY_ID } = await import('../src/spells.js');

    for (const spell of Object.values(SPELL_BY_ID)) {
      if (spell.id === 'spark') continue;
      game.sequence.length = 0;
      game.seqLock = 0;
      game.player.mana = 100;
      const before = game.stats.casts;
      castRecipe(env.canvas, renderer, spell);
      assert.equal(game.stats.casts, before + 1, `${spell.name} did not cast`);
      assert.equal(game.lastCast?.id, spell.id, `wrong spell: ${game.lastCast?.id}`);
    }

    game.seqLock = 0;
    game.player.mana = 100;
    const sparks = game.stats.sparks;
    tap(env.canvas, renderer, 'focus', 80);
    assert.equal(game.stats.sparks, sparks + 1, 'the centre circle did not fire SPARK');
  } finally {
    env.restore();
  }
});

test('the wheel hit-tests the circles you can actually see', async () => {
  const env = installBrowser({ w: 1600, h: 1000 });
  try {
    const api = await bootPlaying(env);
    const { renderer } = api;
    const L = renderer.wheelLayout();

    // Big screens must not shrink the targets; the layout is clamped.
    assert.ok(L.r >= 40, `element targets are too small to hit (r=${L.r})`);

    for (const b of L.buttons) {
      assert.equal(renderer.hitWheel(b.x, b.y)?.id, b.id, `centre of ${b.id} did not hit itself`);
      // Just inside the padded edge should still land.
      const edge = b.r * 1.05;
      assert.equal(renderer.hitWheel(b.x + edge, b.y)?.id, b.id, `edge of ${b.id} missed`);
      // Well outside must not.
      assert.notEqual(renderer.hitWheel(b.x + b.r * 3, b.y)?.id, b.id, `${b.id} over-claims far away`);
    }

    // Elements must not overlap, or a tap becomes a coin flip.
    const els = L.buttons.filter((b) => b.kind === 'element');
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const d = Math.hypot(els[i].x - els[j].x, els[i].y - els[j].y);
        assert.ok(d > els[i].r + els[j].r, `${els[i].id} and ${els[j].id} overlap`);
      }
    }
    void api;
  } finally {
    env.restore();
  }
});

test('dead space on the casting side is ignored, not punished', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    tap(env.canvas, renderer, 'water', 70);
    assert.deepEqual(game.sequence, ['water']);

    // A stray press in the corner of the casting half, far from any circle.
    const x = renderer.castZoneStart() + 12;
    pointer(env.canvas, 'pointerdown', x, 30, 71);
    pointer(env.canvas, 'pointerup', x, 30, 71);

    assert.deepEqual(game.sequence, ['water'], 'a stray press changed the recipe');
    assert.equal(game.stats.breaks, 0, 'a stray press must not break the sequence');
  } finally {
    env.restore();
  }
});

test('the centre circle doubles as the panic button', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    tap(env.canvas, renderer, 'water', 72);
    tap(env.canvas, renderer, 'water', 73);
    assert.deepEqual(game.sequence, ['water', 'water']);
    assert.equal(game.reachable.length, 2, 'HEAL and WATERBALL should both still be live');

    tap(env.canvas, renderer, 'focus', 74);
    assert.equal(game.sequence.length, 0, 'the centre circle should abandon the recipe');
    assert.equal(game.stats.breaks, 0, 'and forgive it');
    assert.equal(game.stats.sparks, 1);
  } finally {
    env.restore();
  }
});

test('movement still works, and a wheel tap does not move the wizard', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const x0 = game.player.x;

    pointer(env.canvas, 'pointerdown', 120, 210, 5);
    pointer(env.canvas, 'pointermove', 210, 210, 5);
    env.advance(20);
    pointer(env.canvas, 'pointerup', 210, 210, 5);
    assert.ok(game.player.x > x0 + 20, `stick did not move the player (dx=${game.player.x - x0})`);

    const held = game.player.x;
    env.advance(20);
    assert.ok(Math.abs(game.player.x - held) < 0.001, 'player kept sliding after the thumb lifted');

    // Tapping the wheel must never be read as movement.
    const p = buttonAt(renderer, 'earth');
    pointer(env.canvas, 'pointerdown', p.x, p.y, 6);
    env.advance(6);
    assert.ok(Math.abs(game.player.x - held) < 0.001, 'a wheel tap moved the player');
    pointer(env.canvas, 'pointerup', p.x, p.y, 6);
  } finally {
    env.restore();
  }
});

test('a two-thumb frame: stick held while a recipe is tapped', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;

    pointer(env.canvas, 'pointerdown', 100, 300, 11);
    pointer(env.canvas, 'pointermove', 100, 240, 11);
    assert.ok(game.moveY < 0, 'stick should be pushing north');

    tap(env.canvas, renderer, 'earth', 12);
    tap(env.canvas, renderer, 'fire', 13);
    tap(env.canvas, renderer, 'water', 14);
    assert.equal(game.stats.casts, 1, 'EXPLOSION did not cast while moving');
    assert.equal(game.lastCast.id, 'explosion');

    pointer(env.canvas, 'pointerup', 100, 240, 11);
  } finally {
    env.restore();
  }
});

test('rapid taps with three different pointers all register', async () => {
  // Two thumbs and a third finger should not lose taps: every pointer DOWN on a
  // circle is its own event.
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const seq = ['fire', 'fire', 'wind'];
    seq.forEach((el, i) => {
      const p = buttonAt(renderer, el);
      pointer(env.canvas, 'pointerdown', p.x, p.y, 100 + i);
    });
    assert.equal(game.stats.casts, 1, 'simultaneous pointers lost a tap');
    assert.equal(game.lastCast.id, 'fireball');
    assert.equal(game.sequence.length, 0);
  } finally {
    env.restore();
  }
});

test('the recipe chart dims what is no longer reachable', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    assert.equal(game.reachable.length, 5, 'everything is reachable before the first tap');

    tap(env.canvas, renderer, 'wind', 120);
    // The chart is drawn from game.reachable; assert the data it renders.
    assert.deepEqual(game.reachable.map((s) => s.id), ['freeze']);
    assert.equal(game.oneAwayFromCast, false, 'FREEZE still needs two more taps');

    tap(env.canvas, renderer, 'water', 121);
    assert.equal(game.oneAwayFromCast, true, 'the next tap completes FREEZE');

    // Render a frame so the chart actually executes with this state.
    env.advance(1);
  } finally {
    env.restore();
  }
});

test('a soak run exercises the wheel and renderer for hundreds of frames', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;

    for (let i = 0; i < 300; i++) {
      game.player.hp = game.player.maxHp;
      game.player.mana = game.player.maxMana;

      // Continue the first still-reachable recipe: never an illegal tap.
      if (i % 4 === 0 && game.seqLock <= 0 && game.reachable.length) {
        const target = game.reachable[0];
        const nextEl = target.sequence[game.sequence.length];
        if (nextEl) tap(env.canvas, renderer, nextEl, 200 + (i % 3));
      }
      // Occasional panic tap on the centre circle.
      if (i % 61 === 0 && game.sequence.length === 0) tap(env.canvas, renderer, 'focus', 210);

      // Keep the stick live the whole time.
      if (i % 5 === 0) {
        pointer(env.canvas, 'pointerdown', 90, 260, 30);
        pointer(env.canvas, 'pointermove', 90 + ((i % 7) - 3) * 20, 260 + ((i % 5) - 2) * 20, 30);
      }
      if (i % 5 === 4) pointer(env.canvas, 'pointerup', 90, 260, 30);

      env.advance(1);
    }
    pointer(env.canvas, 'pointerup', 90, 260, 30);

    assert.ok(Number.isFinite(game.player.x) && Number.isFinite(game.player.hp));
    assert.ok(game.stats.casts >= 5, `soak only cast ${game.stats.casts} spells`);
    assert.equal(game.stats.breaks, 0, 'the soak bot only tapped legal elements');
    assert.ok(game.wave >= 1);

    // globalAlpha is written with *= in the renderer; save/restore must keep it
    // inside [0,1] or everything silently turns invisible on a real device.
    const alpha = env.canvas.__ctx.globalAlpha;
    assert.ok(alpha >= 0 && alpha <= 1, `globalAlpha leaked to ${alpha}`);
  } finally {
    env.restore();
  }
});
