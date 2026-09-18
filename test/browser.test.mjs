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
