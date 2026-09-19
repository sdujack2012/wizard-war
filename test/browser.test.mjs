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
import { WHEEL } from '../src/config.js';

// ── fake browser environment ──────────────────────────────────────────────────

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
    createLinearGradient: () => {
      record('createLinearGradient');
      return gradient;
    },
    createRadialGradient: () => {
      record('createRadialGradient');
      return gradient;
    },
    createPattern: () => {
      record('createPattern');
      return gradient;
    },
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

function installBrowser({ w = 900, h = 420, offscreen = true, vibrate = true } = {}) {
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
    __fire(type, ev) {
      for (const fn of windowListeners.get(type) ?? []) fn(ev);
    },
  };

  // A recording Vibration API, so haptics can be asserted rather than assumed.
  // `vibrate: false` simulates iOS Safari, where the API does not exist at all.
  const vibrations = [];
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: vibrate
      ? {
          vibrate(pattern) {
            vibrations.push(pattern);
            return true;
          },
        }
      : {},
    configurable: true,
    writable: true,
  });

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    performance: globalThis.performance,
    ResizeObserver: globalThis.ResizeObserver,
  };

  globalThis.window = win;
  // A createElement stub so the renderer's offscreen floor cache is exercised.
  // The real fallback path (no offscreen surface at all) is covered by
  // `installBrowser({ offscreen: false })`.
  globalThis.document = {
    hidden: false,
    addEventListener() {},
    createElement: offscreen ? () => makeCanvas(64, 64) : undefined,
  };
  globalThis.performance = { now: () => now };
  globalThis.ResizeObserver = undefined; // exercise the typeof guard

  const canvas = makeCanvas(w, h);
  return {
    window: win,
    canvas,
    /** Every pattern handed to the fake Vibration API, in order. */
    vibrations,
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
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else delete globalThis.navigator;
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

/**
 * Press the first wheel button, drag through each of the rest, then let go -
 * one pointermove per entry, which is what a real drag delivers.
 */
function dragThrough(canvas, renderer, ids, pointerId = 90) {
  const start = buttonAt(renderer, ids[0]);
  pointer(canvas, 'pointerdown', start.x, start.y, pointerId);
  let last = start;
  for (const id of ids.slice(1)) {
    last = buttonAt(renderer, id);
    pointer(canvas, 'pointermove', last.x, last.y, pointerId);
  }
  pointer(canvas, 'pointerup', last.x, last.y, pointerId);
}

/** One press of the primary action: down and up at the same spot. */
function press(canvas, id = 1) {
  pointer(canvas, 'pointerdown', 200, 200, id);
  pointer(canvas, 'pointerup', 200, 200, id);
}

/**
 * Boot the game and get past the front screens.
 *
 * There are two now: the splash, then the how-to-play title. Each takes one
 * press, and the assertions pin that order rather than blindly pressing twice -
 * if the splash ever stopped advancing, a silent extra press would hide it.
 */
async function bootPlaying(env) {
  const { boot } = await import('../src/main.js');
  const api = await boot(env.canvas);
  env.advance(2);
  assert.equal(api.game.state, 'splash', 'the game should boot to the splash screen');
  press(env.canvas);
  env.advance(4);
  assert.equal(api.game.state, 'title', 'the first press should dismiss the splash');
  press(env.canvas);
  env.advance(4);
  assert.equal(api.game.state, 'playing', 'failed to start a run');
  return api;
}

// ── tests ─────────────────────────────────────────────────────────────────────

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

test('the arena floor is cached offscreen and blitted', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    assert.ok(api.renderer.floorCanvas, 'the floor cache was never built');
    const before = env.canvas.__ctx.__calls.get('drawImage') ?? 0;
    env.advance(2);
    const after = env.canvas.__ctx.__calls.get('drawImage') ?? 0;
    assert.ok(after > before, 'the cached floor was never blitted');
  } finally {
    env.restore();
  }
});

test('the renderer still works with no offscreen canvas available', async () => {
  // Some embedded webviews refuse OffscreenCanvas and document.createElement.
  // The floor must then be drawn directly rather than vanishing.
  const env = installBrowser({ offscreen: false });
  try {
    const api = await bootPlaying(env);
    assert.equal(api.renderer.floorCanvas, null, 'expected the direct-draw fallback');
    const before = env.canvas.__ctx.__calls.get('fillRect') ?? 0;
    env.advance(3);
    assert.ok((env.canvas.__ctx.__calls.get('fillRect') ?? 0) > before, 'the fallback floor drew nothing');
    assert.equal(api.game.state, 'playing');
  } finally {
    env.restore();
  }
});

test('a busy frame builds no gradients and stays inside a draw budget', () => {
  // Gradients are the classic mobile canvas killer: allocating one per frame
  // per object is what turns a smooth 60fps into a slideshow on a mid-range
  // phone. The arena's own gradients are built once, on resize - nothing in the
  // frame loop may create one.
  return (async () => {
    const env = installBrowser();
    try {
      const api = await bootPlaying(env);
      const { game } = api;

      // Pack the arena: every enemy type, a pile of particles, live rings.
      game.enemies.length = 0;
      for (let i = 0; i < 20; i++) game.spawnEnemies(i % 3 === 0 ? 'brute' : i % 3 === 1 ? 'wisp' : 'shade', 1);
      for (const shape of ['ember', 'shard', 'droplet', 'mote', 'dot']) {
        game.burst(game.player.x, game.player.y, 40, '#ff7a3d', 220, shape);
      }
      game.player.mana = 100;
      for (const el of ['water', 'water', 'fire']) game.tapElement(el);
      for (const el of ['earth', 'fire', 'water']) game.tapElement(el);
      game.player.mana = 100;
      for (const el of ['wind', 'water', 'earth']) game.tapElement(el);

      const counts = env.canvas.__ctx.__calls;
      const snap = () => ({
        grad: (counts.get('createLinearGradient') ?? 0) + (counts.get('createRadialGradient') ?? 0),
        ops:
          (counts.get('arc') ?? 0) +
          (counts.get('ellipse') ?? 0) +
          (counts.get('fill') ?? 0) +
          (counts.get('stroke') ?? 0) +
          (counts.get('fillRect') ?? 0) +
          (counts.get('lineTo') ?? 0),
      });

      const before = snap();
      env.advance(1);
      const after = snap();

      assert.equal(after.grad - before.grad, 0, `the frame loop created ${after.grad - before.grad} gradients`);
      const ops = after.ops - before.ops;
      assert.ok(ops > 200, `a packed frame only issued ${ops} draw ops - is it drawing anything?`);
      assert.ok(ops < 6000, `a packed frame issued ${ops} draw ops, which will not hold 60fps on a phone`);
    } finally {
      env.restore();
    }
  })();
});

/** One full keystroke. The keyup matters: the input layer suppresses auto-repeat
 *  by ignoring a keydown for a key it already considers held. */
function pressKey(env, key) {
  env.window.__fire('keydown', { key, preventDefault() {} });
  env.window.__fire('keyup', { key, preventDefault() {} });
}

// ── haptic feedback on the wheel ──────────────────────────────────────────────

/** Total buzz length of a recorded pattern, in milliseconds. */
function buzzWeight(pattern) {
  const parts = Array.isArray(pattern) ? pattern : [pattern];
  // Patterns alternate on/off, so only the on-phases count.
  return parts.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
}

test('the wheel taps back: every accepted element buzzes', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const { HAPTICS } = await import('../src/config.js');

    // Reaching the title screen should be silent: the menus are not the studied
    // control, and an unexpected buzz on load reads as a malfunction.
    assert.equal(env.vibrations.length, 0, 'starting a run should not buzz');

    tap(env.canvas, renderer, 'fire', 200);
    env.advance(2);
    assert.equal(game.sequence.length, 1, 'the tap did not register');
    assert.equal(env.vibrations.length, 1, 'an accepted tap must confirm itself');
    assert.equal(env.vibrations[0], HAPTICS.cues.tick.ms, 'the tap used the wrong cue');
  } finally {
    env.restore();
  }
});

test('a fast recipe reads as separate ticks, not one smeared rumble', async () => {
  // This is the whole point of the per-cue cooldown: the taps that build a
  // recipe must arrive as distinct ticks. Real thumb taps are 100ms+ apart; this
  // drives them at 33ms, faster than any human, and they still must not merge.
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const { HAPTICS } = await import('../src/config.js');
    const tickMs = HAPTICS.cues.tick.ms;

    for (const el of ['fire', 'fire', 'wind']) {
      tap(env.canvas, renderer, el, 210);
      env.advance(2);
    }

    assert.equal(game.stats.casts, 1, 'FIREBALL did not cast');
    // Exactly one feedback event per tap: no tap is dropped, and nothing buzzes
    // twice for the same press.
    assert.equal(env.vibrations.length, 3, `each tap should give exactly one cue, got ${JSON.stringify(env.vibrations)}`);
    const ticks = env.vibrations.filter((v) => v === tickMs);
    // The first two taps tick; the third completes the recipe, so its feedback is
    // the cast itself rather than a tick immediately followed by a pulse - two
    // vibrations in the same millisecond would just fight each other.
    assert.equal(ticks.length, 2, `expected 2 building ticks, got ${ticks.length}`);
    assert.ok(
      buzzWeight(env.vibrations[2]) > tickMs,
      'the completing tap should be felt as the cast, not as a tap',
    );
  } finally {
    env.restore();
  }
});

test('a broken sequence is unmistakable by feel alone', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;

    tap(env.canvas, renderer, 'wind', 220);
    env.advance(2);
    const afterFirst = env.vibrations.length;
    const firstTick = env.vibrations[afterFirst - 1];

    // wind, wind leads nowhere: this must not feel like the tap before it.
    tap(env.canvas, renderer, 'wind', 221);
    env.advance(2);
    assert.ok(game.stats.breaks >= 1, 'the sequence did not break');

    const broken = env.vibrations[env.vibrations.length - 1];
    assert.ok(Array.isArray(broken), 'a mistake should be a distinct pattern, not a single tick');
    assert.ok(buzzWeight(broken) > buzzWeight(firstTick) * 2, 'a mistake must be clearly stronger than a tap');
  } finally {
    env.restore();
  }
});

test('casts buzz in proportion to their power', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const { SPELL_BY_ID } = await import('../src/spells.js');

    const castAndMeasure = (id, pointerBase) => {
      game.sequence.length = 0;
      game.seqLock = 0;
      game.player.mana = 100;
      // Long enough to clear every cooldown between recipes.
      env.advance(40);
      const before = env.vibrations.length;
      SPELL_BY_ID[id].sequence.forEach((el, i) => {
        tap(env.canvas, renderer, el, pointerBase + i);
        env.advance(2);
      });
      env.advance(2);
      const tail = env.vibrations.slice(before);
      return buzzWeight(tail[tail.length - 1]);
    };

    const heal = castAndMeasure('heal', 300);
    const fireball = castAndMeasure('fireball', 320);
    const explosion = castAndMeasure('explosion', 340);

    assert.ok(heal > 0 && fireball > 0 && explosion > 0, 'a cast produced no feedback at all');
    assert.ok(fireball > heal, `FIREBALL (${fireball}) should feel heavier than HEAL (${heal})`);
    assert.ok(explosion > fireball, `EXPLOSION (${explosion}) should feel heavier than FIREBALL (${fireball})`);
  } finally {
    env.restore();
  }
});

test('the centre circle is lighter than an element tap', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;

    tap(env.canvas, renderer, 'earth', 400);
    env.advance(2);
    const elementBuzz = env.vibrations[env.vibrations.length - 1];

    game.sequence.length = 0;
    game.seqLock = 0;
    env.advance(4);
    tap(env.canvas, renderer, 'focus', 401);
    env.advance(2);
    assert.equal(game.stats.sparks, 1, 'SPARK did not fire');
    const sparkBuzz = env.vibrations[env.vibrations.length - 1];

    assert.ok(buzzWeight(sparkBuzz) < buzzWeight(elementBuzz), 'SPARK should feel lighter than an element tap');
  } finally {
    env.restore();
  }
});

test('haptics can be switched off, and the choice is remembered', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { renderer } = api;
    assert.equal(api.haptics.enabled, true, 'haptics should default to on');

    pressKey(env, 'v');
    assert.equal(api.haptics.enabled, false, 'V did not disable haptics');
    assert.equal(env.window.localStorage.getItem('rune-pressure.haptics'), '0', 'the choice was not stored');

    const before = env.vibrations.length;
    tap(env.canvas, renderer, 'fire', 500);
    env.advance(2);
    assert.equal(env.vibrations.length, before, 'a disabled controller still buzzed');

    // Re-enabling confirms itself, so you can feel that it worked.
    pressKey(env, 'v');
    assert.equal(api.haptics.enabled, true);
    assert.equal(env.window.localStorage.getItem('rune-pressure.haptics'), '1');
    assert.ok(
      buzzWeight(env.vibrations[env.vibrations.length - 1]) > 0,
      're-enabling should buzz once as confirmation',
    );
  } finally {
    env.restore();
  }
});

test('a stored preference survives a restart', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    pressKey(env, 'v');
    assert.equal(api.haptics.enabled, false);
    api.stop();

    // Boot a fresh instance against the same fake storage.
    const { boot } = await import('../src/main.js');
    const second = await boot(env.canvas);
    assert.equal(second.haptics.enabled, false, 'the off preference was not restored');
  } finally {
    env.restore();
  }
});

test('with no Vibration API the wheel still plays fine', async () => {
  // This is iOS Safari: navigator.vibrate does not exist, and there is no web
  // workaround worth shipping. Everything must still work, silently.
  const env = installBrowser({ vibrate: false });
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    assert.equal(api.haptics.supported, false, 'the game should know it cannot buzz');

    for (const el of ['earth', 'fire', 'water']) {
      tap(env.canvas, renderer, el, 600);
      env.advance(2);
    }
    assert.equal(game.stats.casts, 1, 'EXPLOSION did not cast without haptics');
    assert.equal(game.stats.breaks, 0);
    // Toggling is harmless even when unsupported.
    pressKey(env, 'v');
    assert.equal(api.haptics.enabled, false);
    env.advance(3);
    assert.equal(game.state, 'playing');
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
    assert.equal(game.state, 'splash');
    assert.ok(env.canvas.__ctx.__calls.get('fillRect') > 0, 'the splash actually drew something');
    press(env.canvas);
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
    press(env.canvas);
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
    // A quick tap fires the panic shot and does NOT spend the recipe. The hit
    // circles tile their disc almost exactly, so the shortest path between two
    // opposite elements runs across the centre; a thumb that clipped the middle
    // used to lose the whole recipe for it.
    assert.deepEqual(game.sequence, ['water', 'water'], 'a tapping centre must not cost the recipe');
    assert.equal(game.stats.breaks, 0, 'and forgive it');
    assert.equal(game.stats.sparks, 1);
  } finally {
    env.restore();
  }
});

test('holding the centre circle commits to the wind-up, and spends the recipe', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    tap(env.canvas, renderer, 'water', 72);
    tap(env.canvas, renderer, 'water', 73);

    const f = buttonAt(renderer, 'focus');
    pointer(env.canvas, 'pointerdown', f.x, f.y, 75);
    env.advance(12, 16.7); // ~200ms down, well past CHARGE.tapTime
    pointer(env.canvas, 'pointerup', f.x, f.y, 75);

    assert.equal(game.stats.sparks, 1);
    assert.equal(game.stats.charged, 1, 'a long hold is a charged shot, not a panic tap');
    assert.equal(game.sequence.length, 0, 'committing the wind-up replaces the recipe');
  } finally {
    env.restore();
  }
});

test('dragging through the wheel casts a radial recipe as one stroke', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    // EXPLOSION = EARTH + FIRE + WATER. As taps that is 314px of blind thumb
    // travel on a 375px-tall phone; as a stroke it is one sweep across the disc.
    dragThrough(env.canvas, renderer, ['earth', 'fire', 'water'], 80);
    assert.equal(game.stats.casts, 1, 'the stroke should have completed EXPLOSION');
    assert.equal(game.stats.breaks, 0, 'every element on the path was a legal next tap');
    assert.equal(game.sequence.length, 0, 'the recipe is spent');
  } finally {
    env.restore();
  }
});

test('a stroke treats the centre circle as inert, not as a charge', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    // EARTH and FIRE are opposite, so the straight line between them runs right
    // over the centre. A drag must pass through it without starting a wind-up,
    // which is the whole reason the geometry is safe to sweep.
    const e = buttonAt(renderer, 'earth');
    const f = buttonAt(renderer, 'focus');
    const fire = buttonAt(renderer, 'fire');
    pointer(env.canvas, 'pointerdown', e.x, e.y, 81);
    pointer(env.canvas, 'pointermove', f.x, f.y, 81);
    assert.equal(game.charging, false, 'the centre is inert during a stroke');
    assert.deepEqual(game.sequence, ['earth'], 'and does not touch the recipe');

    pointer(env.canvas, 'pointermove', fire.x, fire.y, 81);
    pointer(env.canvas, 'pointerup', fire.x, fire.y, 81);
    assert.deepEqual(game.sequence, ['earth', 'fire']);
    assert.equal(game.stats.sparks, 0, 'a stroke must never fire the panic shot');
  } finally {
    env.restore();
  }
});

test('a stroke fires each circle once, however long the thumb rests on it', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    // EARTH + FIRE + WATER is a live path at every step, so nothing here breaks
    // the recipe and every assertion is about the stroke, not the matcher.
    const earth = buttonAt(renderer, 'earth');
    const fire = buttonAt(renderer, 'fire');
    const water = buttonAt(renderer, 'water');

    pointer(env.canvas, 'pointerdown', earth.x, earth.y, 82);
    // Jitter inside EARTH's own footprint: three moves, none of them leaving it.
    pointer(env.canvas, 'pointermove', earth.x + 12, earth.y - 9, 82);
    pointer(env.canvas, 'pointermove', earth.x - 15, earth.y - 4, 82);
    pointer(env.canvas, 'pointermove', earth.x + 6, earth.y - 11, 82);
    assert.deepEqual(game.sequence, ['earth'], 'a resting thumb is one tap, not four');

    // Arrive at FIRE, then shuffle around inside it without leaving.
    pointer(env.canvas, 'pointermove', fire.x, fire.y, 82);
    pointer(env.canvas, 'pointermove', fire.x + 9, fire.y + 11, 82);
    pointer(env.canvas, 'pointermove', fire.x - 6, fire.y + 3, 82);
    assert.deepEqual(game.sequence, ['earth', 'fire'], 'FIRE must register exactly once');

    pointer(env.canvas, 'pointermove', water.x, water.y, 82);
    pointer(env.canvas, 'pointerup', water.x, water.y, 82);
    assert.equal(game.stats.casts, 1, 'the third circle completed EXPLOSION');
  } finally {
    env.restore();
  }
});

test('a stroke can press the same element twice, which three recipes need', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    // FIREBALL = FIRE + FIRE + WIND. A doubled element has to be re-armed by
    // leaving the circle and coming back, and both the time and the distance
    // gate have to pass before it will fire again.
    const fire = buttonAt(renderer, 'fire');
    const wind = buttonAt(renderer, 'wind');
    pointer(env.canvas, 'pointerdown', fire.x, fire.y, 83);
    assert.deepEqual(game.sequence, ['fire']);

    // Leave FIRE's reach, sit outside long enough to arm, then come back.
    const out = fire.x - 120;
    pointer(env.canvas, 'pointermove', out, fire.y, 83);
    env.advance(10, 16.7); // ~167ms, past STROKE.rearmMs
    pointer(env.canvas, 'pointermove', out - 4, fire.y, 83); // still outside, keeps the clock
    env.advance(2, 16.7);
    pointer(env.canvas, 'pointermove', fire.x, fire.y, 83);
    assert.deepEqual(game.sequence, ['fire', 'fire'], 'the return trip should re-fire FIRE');

    pointer(env.canvas, 'pointermove', wind.x, wind.y, 83);
    pointer(env.canvas, 'pointerup', wind.x, wind.y, 83);
    assert.equal(game.stats.casts, 1, 'the stroke should have completed FIREBALL');
  } finally {
    env.restore();
  }
});

test('a slow but shallow drift off a circle does not re-fire it', async () => {  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const fire = buttonAt(renderer, 'fire');
    // Hovering a finger on a rim drifts across the boundary for far longer than
    // the re-arm window without meaning to tap twice, so the time gate alone is
    // not enough - the drift must also be real travel. Sit just 6px clear of
    // FIRE's reach for 250ms and come back: it must stay one tap.
    const reach = fire.r * WHEEL.hitPadding;
    pointer(env.canvas, 'pointerdown', fire.x, fire.y, 84);
    pointer(env.canvas, 'pointermove', fire.x - (reach + 6), fire.y, 84);
    env.advance(15, 16.7); // ~250ms, comfortably past STROKE.rearmMs
    pointer(env.canvas, 'pointermove', fire.x - (reach + 4), fire.y, 84);
    env.advance(2, 16.7);
    pointer(env.canvas, 'pointermove', fire.x, fire.y, 84);
    pointer(env.canvas, 'pointerup', fire.x, fire.y, 84);
    assert.deepEqual(game.sequence, ['fire'], 'a shallow drift is not a second tap');
  } finally {
    env.restore();
  }
});

test('holding an element re-fires it, with no pointermove at all', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const fire = buttonAt(renderer, 'fire');
    const before = env.vibrations.length;

    // The whole point: a thumb held still emits NO pointermove events, so a
    // timer driven by movement would never fire. Nothing moves here after the
    // press, and the repeat must still happen.
    pointer(env.canvas, 'pointerdown', fire.x, fire.y, 85);
    assert.deepEqual(game.sequence, ['fire'], 'the press fires immediately');
    env.advance(6, 16.7); // ~100ms - not yet
    assert.deepEqual(game.sequence, ['fire'], 'the hold must not fire early');

    env.advance(26, 16.7); // past STROKE.repeatMs in total
    assert.deepEqual(game.sequence, ['fire', 'fire'], 'waiting on the circle presses it again');

    // Each repeat rides the ordinary `element` event, so it confirms itself
    // through the thumb exactly like a tap rather than being a special case.
    const { HAPTICS } = await import('../src/config.js');
    assert.equal(env.vibrations.length, before + 2, 'press + repeat = two ticks');
    assert.equal(env.vibrations[before], HAPTICS.cues.tick.ms);
    assert.equal(env.vibrations[before + 1], HAPTICS.cues.tick.ms, 'the repeat used the tap cue');

    pointer(env.canvas, 'pointerup', fire.x, fire.y, 85);
  } finally {
    env.restore();
  }
});

test('an over-long hold goes quiet instead of breaking the recipe', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const fire = buttonAt(renderer, 'fire');
    pointer(env.canvas, 'pointerdown', fire.x, fire.y, 86);
    env.advance(40, 16.7); // ~670ms: the second fire lands, a third would not
    assert.deepEqual(game.sequence, ['fire', 'fire']);

    // FIRE+FIRE+FIRE leads nowhere. A thumb left resting must simply go inert
    // rather than cycling fire/fire/BREAK forever, so nothing happens however
    // long it stays.
    env.advance(90, 16.7); // another 1.5s
    assert.deepEqual(game.sequence, ['fire', 'fire'], 'an inert hold changes nothing');
    assert.equal(game.stats.breaks, 0, 'and must not cost the recipe');
    pointer(env.canvas, 'pointerup', fire.x, fire.y, 86);
  } finally {
    env.restore();
  }
});

test('FIREBALL is press, wait, drag - no excursion needed', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const fire = buttonAt(renderer, 'fire');
    const wind = buttonAt(renderer, 'wind');

    pointer(env.canvas, 'pointerdown', fire.x, fire.y, 87);
    env.advance(32, 16.7); // wait out the repeat
    assert.deepEqual(game.sequence, ['fire', 'fire']);
    pointer(env.canvas, 'pointermove', wind.x, wind.y, 87);
    pointer(env.canvas, 'pointerup', wind.x, wind.y, 87);
    assert.equal(game.stats.casts, 1, 'one press, one wait, one drag = FIREBALL');
    assert.equal(game.stats.breaks, 0);
  } finally {
    env.restore();
  }
});

test('the hold shows how much of the wait is left', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { input, renderer, game } = api;
    const fire = buttonAt(renderer, 'fire');
    assert.equal(input.hudState().dwell, null, 'no stroke, no wind-up');

    pointer(env.canvas, 'pointerdown', fire.x, fire.y, 88);
    assert.equal(input.hudState().dwell.id, 'fire');
    assert.equal(input.hudState().dwell.k, 0, 'the wind-up starts empty');

    env.advance(15, 16.7); // ~250ms of the 500ms wait
    const k = input.hudState().dwell.k;
    assert.ok(k > 0.3 && k < 0.7, `expected roughly half a wind-up, got ${k}`);

    // Moving off the circle abandons the hold: the thumb is going somewhere.
    const wind = buttonAt(renderer, 'wind');
    pointer(env.canvas, 'pointermove', wind.x, wind.y, 88);
    assert.equal(input.hudState().dwell.id, 'wind', 'the wind-up follows the thumb');
    assert.equal(input.hudState().dwell.k, 0, 'and restarts on the new circle');

    pointer(env.canvas, 'pointerup', wind.x, wind.y, 88);
    assert.equal(input.hudState().dwell, null, 'releasing ends the stroke');
    // FIRE then WIND is not a prefix of anything, so the drag correctly costs
    // the recipe - that is the matcher doing its job, not the hold misbehaving.
    assert.deepEqual(game.sequence, [], 'FIRE+WIND leads nowhere, so the recipe breaks');
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

test('painted art takes over from the vector art when it is there, and only then', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { renderer } = api;
    const calls = env.canvas.__ctx.__calls;
    const frameImages = (n = 1) => {
      const before = calls.get('drawImage') ?? 0;
      env.advance(n);
      return (calls.get('drawImage') ?? 0) - before;
    };

    // With no assets at all, the pre-rendered vector floor is the only image
    // the frame draws - that fallback is what this whole suite runs on.
    const vectorFrame = frameImages();

    // A stand-in store. The renderer only ever asks an image for width/height,
    // so that is all a fake one needs to be.
    const store = {
      images: new Map(['floor', 'wizard', 'shade', 'wisp', 'brute', 'brazier'].map((id) => [id, { width: 64, height: 64 }])),
      get(id) {
        return this.images.get(id) ?? null;
      },
      variant() {
        return { width: 64, height: 64 };
      },
    };
    renderer.assets = store;
    const paintedFrame = frameImages();

    assert.ok(
      paintedFrame > vectorFrame,
      `the painted art did not take over (${paintedFrame} images/frame vs ${vectorFrame} for the vector fallback)`,
    );
  } finally {
    env.restore();
  }
});

test('the casting wheel sits hard right, and stays whole, on every device', async () => {
  // Landscape sizes only: a portrait window gets the rotate hint and never lays
  // the wheel out at all. Narrow phone -> desktop.
  const sizes = [
    [568, 320], // iPhone SE, landscape
    [667, 375], // iPhone 8, landscape
    [844, 390], // iPhone 14, landscape
    [900, 420], // the harness default
    [1280, 720], // laptop
    [1600, 1000], // big screen
  ];

  for (const [w, h] of sizes) {
    const env = installBrowser({ w, h });
    try {
      const api = await bootPlaying(env);
      const { renderer } = api;
      const L = renderer.wheelLayout();
      const plateReach = L.ring + L.r + WHEEL.platePad;

      // Nothing may hang off the screen - the outer circles are the whole point.
      for (const b of L.buttons) {
        assert.ok(b.x - b.r >= 0 && b.x + b.r <= w, `${b.id} runs off the side at ${w}x${h}`);
        assert.ok(b.y - b.r >= 0 && b.y + b.r <= h, `${b.id} runs off the top/bottom at ${w}x${h}`);
      }
      assert.ok(
        L.cx + plateReach <= w + 1e-6,
        `the wheel plate overflows the right edge at ${w}x${h} (${L.cx + plateReach} > ${w})`,
      );

      // ...and it is as far right as that allows, with only the deliberate
      // bezel gap left over. This is the "far right" claim itself.
      assert.ok(
        Math.abs(L.cx + plateReach + WHEEL.edgePad - w) < 1e-6,
        `the wheel is not flush right at ${w}x${h} (slack ${w - L.cx - plateReach})`,
      );

      // It must also stay clear of the movement half: a press left of the split
      // is read as movement, so any overlap is an unpressable dead patch.
      const leftmost = L.buttons.reduce(
        (m, b) => Math.min(m, b.x - b.r * WHEEL.hitPadding),
        Infinity,
      );
      assert.ok(
        leftmost >= renderer.castZoneStart(),
        `the wheel reaches into the movement zone at ${w}x${h} (${leftmost} < ${renderer.castZoneStart()})`,
      );
    } finally {
      env.restore();
    }
  }
});

// ── the charged centre circle, driven the way a thumb drives it ───────────────

test('holding the centre circle winds up, and the release throws the heavy shot', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const p = buttonAt(renderer, 'focus');

    pointer(env.canvas, 'pointerdown', p.x, p.y, 55);
    assert.equal(game.charging, true, 'the press did not start a wind-up');
    assert.equal(game.bolts.length, 0, 'the press must not fire by itself');
    assert.deepEqual(game.sequence, [], 'the press must still clear a partial recipe');

    env.advance(60); // ~1s of thumb-down, past CHARGE.time
    assert.equal(game.chargeT, 1, `the wind-up never reached full (${game.chargeT})`);
    assert.equal(game.bolts.length, 0, 'a held charge must not fire early');

    pointer(env.canvas, 'pointerup', p.x, p.y, 55);
    assert.equal(game.charging, false, 'the release did not end the wind-up');
    assert.equal(game.bolts.length, 1, 'the release did not fire');
    assert.ok(game.bolts[0].damage > 20, `the charged shot was weak (${game.bolts[0].damage})`);
    assert.equal(game.stats.charged, 1);
  } finally {
    env.restore();
  }
});

test('a quick tap on the centre circle still fires the plain SPARK', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const p = buttonAt(renderer, 'focus');

    pointer(env.canvas, 'pointerdown', p.x, p.y, 56);
    pointer(env.canvas, 'pointerup', p.x, p.y, 56);

    assert.equal(game.bolts.length, 1, 'a tap must still shoot');
    assert.equal(game.bolts[0].damage, 6, `a tap paid for a charge (${game.bolts[0].damage} damage)`);
    assert.equal(game.stats.charged, 0);
  } finally {
    env.restore();
  }
});

test('only the thumb that started a wind-up can release it', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const p = buttonAt(renderer, 'focus');

    pointer(env.canvas, 'pointerdown', p.x, p.y, 57); // the thumb that owns it
    pointer(env.canvas, 'pointerdown', p.x, p.y, 58); // a second thumb, same circle
    env.advance(30);

    pointer(env.canvas, 'pointerup', p.x, p.y, 58); // not the owner: nothing happens
    assert.equal(game.bolts.length, 0, 'a second thumb released someone else\'s charge');
    assert.equal(game.charging, true);

    pointer(env.canvas, 'pointerup', p.x, p.y, 57);
    assert.equal(game.bolts.length, 1, 'the owner could not release');
  } finally {
    env.restore();
  }
});

test('a cancelled pointer abandons the wind-up instead of firing it', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const p = buttonAt(renderer, 'focus');

    pointer(env.canvas, 'pointerdown', p.x, p.y, 59);
    env.advance(30);
    pointer(env.canvas, 'pointercancel', p.x, p.y, 59);
    assert.equal(game.charging, false);
    assert.equal(game.bolts.length, 0, 'a cancelled pointer threw a shot');

    // Alt-tab / backgrounding takes the same path.
    pointer(env.canvas, 'pointerdown', p.x, p.y, 60);
    env.advance(30);
    api.input.releaseAll();
    assert.equal(game.charging, false);
    assert.equal(game.bolts.length, 0, 'losing focus threw a shot');
  } finally {
    env.restore();
  }
});

test('space on a keyboard winds up and releases like a thumb', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game } = api;

    env.window.__fire('keydown', { key: ' ', preventDefault() {} });
    assert.equal(game.charging, true, 'space did not start a wind-up');
    env.advance(60);
    env.window.__fire('keyup', { key: ' ', preventDefault() {} });

    assert.equal(game.bolts.length, 1, 'releasing space did not fire');
    assert.ok(game.bolts[0].damage > 20, `the keyboard charge was weak (${game.bolts[0].damage})`);
  } finally {
    env.restore();
  }
});

// ── heading ───────────────────────────────────────────────────────────────────

/**
 * The bitmaps are authored FACING LEFT. Everything about which way a creature
 * looks follows from that one fact, and getting it backwards is invisible in a
 * unit test of the maths and glaring in play: every creature walks backwards,
 * enemies stare away from the player, and anything that stops snaps to facing
 * left. That combination shipped once. These tests pin the convention itself.
 */
test('the heading convention matches the art: unflipped faces left, so right mirrors', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { renderer } = api;
    const actor = (faceX) => ({ faceX, vxNow: 0, vyNow: 0, speedNow: 0, gait: 0 });

    assert.equal(
      renderer.motionOf(actor(1), { speed: 232, facingX: 1 }).mirror,
      1,
      'a rightward heading must mirror, because the art faces left unflipped',
    );
    assert.equal(
      renderer.motionOf(actor(-1), { speed: 232, facingX: -1 }).mirror,
      0,
      'a leftward heading must NOT mirror: it is already the art as drawn',
    );
  } finally {
    env.restore();
  }
});

test('an enemy always faces the player, whichever side the player is on', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const enemy = { faceX: 1, vxNow: 0, vyNow: 0, speedNow: 0, gait: 0, type: 'shade' };

    game.player.x = 900;
    enemy.x = 300;
    const toRight = renderer.motionOf(enemy, { speed: 100, facingX: renderer.headingOf(enemy, game.player.x - enemy.x) });
    assert.equal(toRight.mirror, 1, 'player to the right: the enemy must face right');

    game.player.x = 100;
    enemy.x = 700;
    const toLeft = renderer.motionOf(enemy, { speed: 100, facingX: renderer.headingOf(enemy, game.player.x - enemy.x) });
    assert.equal(toLeft.mirror, 0, 'player to the left: the enemy must face left');
  } finally {
    env.restore();
  }
});

test('a creature that stops keeps the heading it had', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { renderer } = api;
    const actor = { faceX: 1, vxNow: 0, vyNow: 0, speedNow: 0, gait: 0 };

    // Walk left...
    assert.equal(renderer.headingOf(actor, -200), -1);
    assert.equal(renderer.motionOf(actor, { speed: 232, facingX: -1 }).mirror, 0);
    // ...then let go. This is the reported bug: it used to snap to facing left.
    assert.equal(renderer.headingOf(actor, 0), -1, 'stopping must not reset the facing');
    assert.equal(renderer.motionOf(actor, { speed: 232, facingX: -1 }).mirror, 0);

    // Walk right, stop, and it holds right.
    assert.equal(renderer.headingOf(actor, 200), 1);
    assert.equal(renderer.headingOf(actor, 0), 1, 'idle must hold the last heading, not flip');
    assert.equal(renderer.motionOf(actor, { speed: 232, facingX: 1 }).mirror, 1);
  } finally {
    env.restore();
  }
});

test('a target directly above or below does not flip an enemy around', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const enemy = { faceX: -1, vxNow: 0, vyNow: 0, speedNow: 0, gait: 0, type: 'shade' };
    // Perfectly aligned: the horizontal delta is zero, which must carry no
    // information rather than meaning "face left".
    enemy.x = game.player.x = 500;
    assert.equal(renderer.headingOf(enemy, game.player.x - enemy.x), -1, 'zero delta must hold the heading');
    enemy.faceX = 1;
    assert.equal(renderer.headingOf(enemy, game.player.x - enemy.x), 1, 'and hold it either way');
  } finally {
    env.restore();
  }
});

// ── the spell book ────────────────────────────────────────────────────────────

test('a corner tap opens the spell book, and the wave freezes behind it', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const b = renderer.spellBookLayout().button;

    tap(env.canvas, renderer, 'fire', 90); // a recipe in progress
    env.advance(2);
    const waveBefore = game.intermission;

    pointer(env.canvas, 'pointerdown', b.x + b.w / 2, b.y + b.h / 2, 95);
    pointer(env.canvas, 'pointerup', b.x + b.w / 2, b.y + b.h / 2, 95);
    assert.equal(game.state, 'spellbook', 'the corner icon should open the book');

    env.advance(60); // a full second of held world
    assert.equal(game.intermission, waveBefore, 'the wave clock must not run while reading');
    assert.deepEqual(game.sequence, ['fire'], 'and the recipe must survive the pause');

    // Casting is refused, so nothing can happen to the world behind the card.
    assert.equal(game.tapElement('wind').ok, false, 'no casting while the book is open');
  } finally {
    env.restore();
  }
});

test('a drag that starts on the corner icon moves the wizard', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const b = renderer.spellBookLayout().button;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;

    // The corner sits inside the walking zone, so this is the regression that
    // matters: a movement drag must not be swallowed by the book.
    pointer(env.canvas, 'pointerdown', cx, cy, 96);
    pointer(env.canvas, 'pointermove', cx - 90, cy - 10, 96);
    assert.ok(game.moveX < -0.2, `the drag should walk, got moveX=${game.moveX}`);
    pointer(env.canvas, 'pointerup', cx - 90, cy - 10, 96);
    assert.equal(game.state, 'playing', 'and must not open the book');
  } finally {
    env.restore();
  }
});

test('a corner press held too long is a walk, not a click', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const b = renderer.spellBookLayout().button;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    pointer(env.canvas, 'pointerdown', cx, cy, 97);
    env.advance(40, 16.7); // ~670ms, well past the click window
    pointer(env.canvas, 'pointerup', cx, cy, 97);
    assert.equal(game.state, 'playing', 'a long press in the corner is not a click');
  } finally {
    env.restore();
  }
});

test('rows select a recipe, and the wheel is told about it', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const L = renderer.spellBookLayout();
    const b = L.button;
    pointer(env.canvas, 'pointerdown', b.x + b.w / 2, b.y + b.h / 2, 98);
    pointer(env.canvas, 'pointerup', b.x + b.w / 2, b.y + b.h / 2, 98);
    assert.equal(game.spellBookSelected, null, 'the book opens with nothing demonstrated');

    const row = L.list.find((r) => r.id === 'explosion');
    pointer(env.canvas, 'pointerdown', L.card.x + 60, row.cy, 99);
    pointer(env.canvas, 'pointerup', L.card.x + 60, row.cy, 99);
    assert.equal(game.spellBookSelected, 'explosion', 'tapping a row should demonstrate it');

    // Tapping the same row again puts the wheel back to plain, so the book can
    // be read without a gesture drawn permanently over the controls.
    pointer(env.canvas, 'pointerdown', L.card.x + 60, row.cy, 100);
    pointer(env.canvas, 'pointerup', L.card.x + 60, row.cy, 100);
    assert.equal(game.spellBookSelected, null, 'tapping again should clear it');
  } finally {
    env.restore();
  }
});

test('the card is inert, so only a real close loses the page', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const L = renderer.spellBookLayout();
    const b = L.button;
    pointer(env.canvas, 'pointerdown', b.x + b.w / 2, b.y + b.h / 2, 101);
    pointer(env.canvas, 'pointerup', b.x + b.w / 2, b.y + b.h / 2, 101);
    assert.equal(game.state, 'spellbook');

    const row = L.list.find((r) => r.id === 'freeze');
    game.selectSpell('freeze');
    // The footer band: inside the card, below the last row. Reading a list
    // one-handed means mis-taps, and a mis-tap must not lose the page.
    pointer(env.canvas, 'pointerdown', L.card.x + L.card.w / 2, L.card.y + L.card.h - 10, 102);
    assert.equal(game.state, 'spellbook', 'a blank card tap must not close the book');
    assert.equal(game.spellBookSelected, 'freeze', 'and must not lose the selection');
    void row;

    // The explicit close does.
    pointer(env.canvas, 'pointerdown', L.close.x + L.close.w / 2, L.close.y + L.close.h / 2, 103);
    assert.equal(game.state, 'playing', 'the close target should close it');
    assert.equal(game.spellBookSelected, null, 'and forget the selection');
  } finally {
    env.restore();
  }
});

test('a tap off the card closes the book too', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer } = api;
    const L = renderer.spellBookLayout();
    const b = L.button;
    pointer(env.canvas, 'pointerdown', b.x + b.w / 2, b.y + b.h / 2, 104);
    pointer(env.canvas, 'pointerup', b.x + b.w / 2, b.y + b.h / 2, 104);
    assert.equal(game.state, 'spellbook');

    // Straight out in the arena, clear of the card and of the wheel.
    pointer(env.canvas, 'pointerdown', L.card.x + L.card.w + 20, L.card.y + L.card.h - 10, 105);
    assert.equal(game.state, 'playing', 'tapping away from the card should dismiss it');
  } finally {
    env.restore();
  }
});

test('a recipe collapses into gesture nodes, repeats counted not duplicated', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { renderer } = api;

    // FIRE+FIRE+WIND is two circles and three presses: a node per circle, with
    // the count carried, because a line from FIRE to itself is not a gesture.
    const doubled = renderer.trajectoryNodes(['fire', 'fire', 'wind']);
    assert.equal(doubled.length, 2);
    assert.deepEqual(doubled.map((n) => n.id), ['fire', 'wind']);
    assert.deepEqual(doubled.map((n) => n.count), [2, 1]);

    // The radial recipes are three distinct circles - one continuous sweep.
    const radial = renderer.trajectoryNodes(['earth', 'fire', 'water']);
    assert.deepEqual(radial.map((n) => n.id), ['earth', 'fire', 'water']);
    assert.deepEqual(radial.map((n) => n.count), [1, 1, 1]);

    // Nodes carry the wheel's own geometry, so the drawing cannot drift from
    // the control it is teaching.
    const L = renderer.wheelLayout();
    const fire = L.buttons.find((x) => x.id === 'fire');
    assert.equal(doubled[0].x, fire.x);
    assert.equal(doubled[0].y, fire.y);
  } finally {
    env.restore();
  }
});

test('every recipe has a row, and the hit-test returns the row it was asked for', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { renderer } = api;
    const { SPELLS } = await import('../src/spells.js');
    const L = renderer.spellBookLayout();
    const byId = Object.fromEntries(L.list.map((r) => [r.id, r]));

    for (const spell of SPELLS) {
      assert.ok(byId[spell.id], `the book is missing ${spell.name}`);
      assert.deepEqual(byId[spell.id].sequence, spell.sequence, `${spell.name} row has the wrong recipe`);
      // Each row must be tappable across its full width, not just on the text.
      const hit = renderer.hitSpellBook(L.card.x + 60, byId[spell.id].cy);
      assert.equal(hit.row.id, spell.id, `row ${spell.name} hit-tests as ${hit.row?.id}`);
    }
    assert.ok(byId.focus, 'the book should explain the centre circle too');
    assert.equal(renderer.hitSpellBook(L.close.x + 2, L.close.y + 2).kind, 'close');
  } finally {
    env.restore();
  }
});

test('the book only opens from a run, never over the title or a death', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game } = api;
    assert.equal(game.openSpellBook(), true);
    assert.equal(game.openSpellBook(), false, 'opening twice is a no-op, not a state reset');
    assert.equal(game.closeSpellBook(), true);
    assert.equal(game.closeSpellBook(), false, 'and so is closing twice');

    game.state = 'gameover';
    assert.equal(game.openSpellBook(), false, 'no reading recipes on the death screen');
    game.state = 'title';
    assert.equal(game.openSpellBook(), false, 'nor over the title');
    game.state = 'splash';
    assert.equal(game.openSpellBook(), false, 'nor over the splash');
  } finally {
    env.restore();
  }
});

test('a recipe collapses into gesture nodes, repeats counted not duplicated', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { renderer } = api;

    // FIRE+FIRE+WIND is two circles and three presses: a node per circle, with
    // the count carried, because a line from FIRE to itself is not a gesture.
    const doubled = renderer.trajectoryNodes(['fire', 'fire', 'wind']);
    assert.equal(doubled.length, 2);
    assert.deepEqual(doubled.map((n) => n.id), ['fire', 'wind']);
    assert.deepEqual(doubled.map((n) => n.count), [2, 1]);

    // The radial recipes are three distinct circles - one continuous sweep.
    const radial = renderer.trajectoryNodes(['earth', 'fire', 'water']);
    assert.deepEqual(radial.map((n) => n.id), ['earth', 'fire', 'water']);
    assert.deepEqual(radial.map((n) => n.count), [1, 1, 1]);

    // Nodes carry the wheel's own geometry, so the drawing cannot drift from
    // the control it is teaching.
    const L = renderer.wheelLayout();
    const fire = L.buttons.find((x) => x.id === 'fire');
    assert.equal(doubled[0].x, fire.x);
    assert.equal(doubled[0].y, fire.y);
  } finally {
    env.restore();
  }
});

test('the gesture description names the input, not just the elements', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { renderer, game } = api;
    const L = renderer.spellBookLayout();
    const byId = Object.fromEntries(L.list.map((r) => [r.id, r]));
    // Every recipe has a row, and every row maps to a real, castable spell.
    for (const spell of (await import('../src/spells.js')).SPELLS) {
      assert.ok(byId[spell.id], `the book is missing ${spell.name}`);
    }
    assert.ok(byId.focus, 'the book should explain the centre circle too');

    // The row hit-test must return the row it was asked for.
    const row = byId.heal;
    assert.equal(renderer.hitSpellBook(L.card.x + 60, row.cy).row.id, 'heal');
    assert.equal(renderer.hitSpellBook(L.close.x + 2, L.close.y + 2).kind, 'close');
    void game;
  } finally {
    env.restore();
  }
});

// ── the drawn line, and the animated demonstration ───────────────────────────

test('a stroke records the line the thumb actually drew', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { input, renderer } = api;
    const earth = buttonAt(renderer, 'earth');
    const fire = buttonAt(renderer, 'fire');

    pointer(env.canvas, 'pointerdown', earth.x, earth.y, 120);
    assert.equal(input.trail.length, 1, 'the press seeds the line');
    // A curve, not a straight line: the point of this is the finger's own path.
    pointer(env.canvas, 'pointermove', earth.x + 30, earth.y - 50, 120);
    pointer(env.canvas, 'pointermove', earth.x + 10, earth.y - 110, 120);
    pointer(env.canvas, 'pointermove', fire.x - 6, fire.y + 24, 120);
    assert.ok(input.trail.length >= 4, `expected the drawn points, got ${input.trail.length}`);

    // The recorded points are the finger's, not the circles': the middle one is
    // nowhere near any button centre.
    const mid = input.trail[2];
    assert.ok(Math.abs(mid.x - (earth.x + 10)) < 1, 'the line follows the finger');
    assert.equal(input.hudState().trail, input.trail, 'and is published for the renderer');
    assert.ok(input.hudState().trailFade > 0, 'with some life left in it');

    pointer(env.canvas, 'pointerup', fire.x, fire.y, 120);
  } finally {
    env.restore();
  }
});

test('the drawn line fades after the thumb lifts, then clears', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { input, renderer } = api;
    const earth = buttonAt(renderer, 'earth');
    pointer(env.canvas, 'pointerdown', earth.x, earth.y, 121);
    pointer(env.canvas, 'pointermove', earth.x + 40, earth.y - 40, 121);
    pointer(env.canvas, 'pointerup', earth.x + 40, earth.y - 40, 121);

    // Kept on release, so the line does not vanish out from under the thumb.
    assert.ok(input.hudState().trail, 'the line outlives the stroke');
    env.advance(40, 16.7); // ~670ms, well past TRAIL.ttl
    assert.equal(input.hudState().trail, null, 'and then it is gone');
  } finally {
    env.restore();
  }
});

test('a press that misses every circle draws nothing', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { input, renderer } = api;
    const L = renderer.wheelLayout();
    // Dead space: outside the disc entirely, but still in the casting half.
    const x = L.cx + L.ring + L.r + 40;
    pointer(env.canvas, 'pointerdown', x, L.cy - L.ring - L.r - 40, 122);
    pointer(env.canvas, 'pointermove', x, L.cy, 122);
    pointer(env.canvas, 'pointerup', x, L.cy, 122);
    assert.equal(input.trail.length, 0, 'a stray thumb leaves no mark');
  } finally {
    env.restore();
  }
});

test('the drawn line is capped, so a long scribble cannot grow forever', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { input, renderer } = api;
    const { TRAIL } = await import('../src/config.js');
    const earth = buttonAt(renderer, 'earth');
    pointer(env.canvas, 'pointerdown', earth.x, earth.y, 123);
    for (let i = 1; i <= 120; i++) {
      pointer(env.canvas, 'pointermove', earth.x + i * 1.5, earth.y - i * 0.7, 123);
    }
    assert.equal(input.trail.length, TRAIL.maxPoints, 'the tail is bounded');
    // Dropped from the BACK, so the line always ends where the thumb is.
    const last = input.trail[input.trail.length - 1];
    assert.ok(Math.abs(last.x - (earth.x + 180)) < 3, 'the newest point survives');
    pointer(env.canvas, 'pointerup', earth.x + 180, earth.y - 84, 123);
  } finally {
    env.restore();
  }
});

test('the spell book demonstration advances only while it is open', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { game, renderer, input } = api;
    const L = renderer.spellBookLayout();
    const b = L.button;
    pointer(env.canvas, 'pointerdown', b.x + b.w / 2, b.y + b.h / 2, 124);
    pointer(env.canvas, 'pointerup', b.x + b.w / 2, b.y + b.h / 2, 124);
    assert.equal(game.state, 'spellbook');

    const row = L.list.find((r) => r.id === 'fireball');
    pointer(env.canvas, 'pointerdown', L.card.x + 60, row.cy, 125);
    pointer(env.canvas, 'pointerup', L.card.x + 60, row.cy, 125);
    assert.equal(game.spellBookT, 0, 'selecting a recipe restarts the demonstration');

    env.advance(30, 16.7); // ~500ms
    const t = game.spellBookT;
    assert.ok(t > 0.4 && t < 0.6, `the clock should run while reading, got ${t}`);

    // Closing freezes it: a paused screen must not keep animating behind the card.
    pointer(env.canvas, 'pointerdown', 10, L.card.y + L.card.h - 6, 126);
    assert.equal(game.state, 'playing');
    const frozen = game.spellBookT;
    env.advance(20, 16.7);
    assert.equal(game.spellBookT, frozen, 'the clock stops with the book');
    void input;
  } finally {
    env.restore();
  }
});

test('the demonstrated gesture plays as a timeline that waits on repeats', async () => {
  const env = installBrowser();
  try {
    const api = await bootPlaying(env);
    const { renderer } = api;
    const { UI, STROKE } = await import('../src/config.js');

    // FIRE+FIRE+WIND: two circles, but the first one is pressed twice, so its
    // beat must last as long as the real hold does.
    const nodes = renderer.trajectoryNodes(['fire', 'fire', 'wind']);
    const tl = renderer.trajectoryTimeline(nodes);
    const press = UI.spellBook.pressS + (STROKE.repeatMs / 1000);
    assert.equal(tl.events[0].kind, 'press');
    assert.equal(tl.events[0].node, 0);
    assert.ok(Math.abs(tl.events[0].t1 - press) < 1e-9, `the doubled beat should be ${press}s`);
    assert.equal(tl.events[1].kind, 'move');
    assert.ok(tl.cycle > tl.total, 'and the finished gesture is held before it loops');

    // At t=0 the head is on the first circle and nothing has been travelled.
    const start = renderer.trajectoryAt(nodes, 0);
    assert.equal(start.active, 0);
    assert.equal(start.dwelling, true);
    assert.equal(start.legs[0].frac, 0, 'no travel yet');
    assert.ok(Math.abs(start.head.x - nodes[0].x) < 1e-9);

    // Mid-travel, the leg is part-drawn and the head is off both circles.
    const mid = renderer.trajectoryAt(nodes, press + UI.spellBook.moveS / 2);
    assert.ok(mid.legs[0].frac > 0.4 && mid.legs[0].frac < 0.6, `frac ${mid.legs[0].frac}`);
    assert.notEqual(mid.head.x, nodes[0].x);

    // After the last press, everything is drawn and held.
    const done = renderer.trajectoryAt(nodes, tl.total + 0.01);
    assert.equal(done.legs[0].frac, 1);
    assert.equal(done.active, nodes.length - 1);

    // ...and it loops rather than parking on the finished pose. The honest
    // statement of that is periodicity: the state at t is the state at t modulo
    // one cycle, for any t, including well past the first.
    for (const offset of [0.2, 1.1, 3.7, 9.4]) {
      const at = renderer.trajectoryAt(nodes, offset);
      const wrapped = renderer.trajectoryAt(nodes, offset + tl.cycle);
      assert.equal(at.active, wrapped.active, `active differs at t=${offset}`);
      assert.ok(
        Math.abs(at.legs[0].frac - wrapped.legs[0].frac) < 1e-9,
        `leg progress differs one cycle later at t=${offset}`,
      );
    }
  } finally {
    env.restore();
  }
});
