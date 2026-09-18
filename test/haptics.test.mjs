/**
 * Haptics tests.
 *
 * The wheel is a rhythm control driven while looking at the arena, so a tap that
 * does not confirm itself through the thumb is a tap the player cannot trust.
 * These tests pin the cue table, the rate limiting and the platform fallbacks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Haptics, EVENT_CUE, CAST_CUE } from '../src/haptics.js';
import { HAPTICS } from '../src/config.js';

/** Run `fn` with a stubbed navigator, then restore the real one. */
function withNavigator(value, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
}

function withVibrate(fn) {
  const calls = [];
  const result = withNavigator(
    {
      vibrate(pattern) {
        calls.push(pattern);
        return true;
      },
    },
    fn,
  );
  return { calls, result };
}

/** Every game event the event stream can emit, mapped or not. */
const GAME_EVENTS = [
  'element',
  'spark',
  'sequence-break',
  'fizzle',
  'cast',
  'kill',
  'player-hit',
  'wave-start',
  'wave-clear',
  'overtime',
  'death',
];

// ── the cue table ────────────────────────────────────────────────────────────

test('every cue the game can fire actually exists', () => {
  // Catches a typo in the event map, which would otherwise fail silently: an
  // unknown cue simply does nothing, so nothing buzzes and nothing errors.
  for (const [event, cue] of Object.entries(EVENT_CUE)) {
    assert.ok(HAPTICS.cues[cue], `event "${event}" maps to missing cue "${cue}"`);
  }
  for (const [spell, cue] of Object.entries(CAST_CUE)) {
    assert.ok(HAPTICS.cues[cue], `spell "${spell}" maps to missing cue "${cue}"`);
  }
  // Every cue in the table should be reachable from something.
  const reachable = new Set([...Object.values(EVENT_CUE), ...Object.values(CAST_CUE)]);
  for (const cue of Object.keys(HAPTICS.cues)) {
    assert.ok(reachable.has(cue), `cue "${cue}" is defined but nothing ever fires it`);
  }
});

test('every cue is well formed', () => {
  for (const [name, cue] of Object.entries(HAPTICS.cues)) {
    const parts = Array.isArray(cue.ms) ? cue.ms : [cue.ms];
    assert.ok(parts.length >= 1, `${name} has no durations`);
    for (const ms of parts) {
      assert.ok(Number.isFinite(ms) && ms > 0, `${name} has a non-positive duration: ${ms}`);
    }
    assert.ok(Number.isFinite(cue.cooldown) && cue.cooldown >= 0, `${name} has a bad cooldown`);
    // A pattern must alternate on/off, so an odd length is correct.
    if (parts.length > 1) assert.ok(parts.length % 2 === 1, `${name} pattern must end while buzzing`);
  }
});

test('the cues are ordered so power can be felt', () => {
  const weight = (name) => {
    const cue = HAPTICS.cues[name];
    const parts = Array.isArray(cue.ms) ? cue.ms : [cue.ms];
    return parts.reduce((a, b) => a + b, 0);
  };
  // A tap on an element is more substantial than the centre dart...
  assert.ok(weight('tick') > weight('spark'), 'an element tap should feel stronger than SPARK');
  // ...a real spell is more than a tap...
  assert.ok(weight('castLight') > weight('tick'), 'a cast should out-weigh a tap');
  assert.ok(weight('castMed') > weight('castLight'), 'a aimed spell should out-weigh a heal');
  // ...and a radial spell is unmistakably the big one.
  assert.ok(weight('castHeavy') > weight('castMed'), 'the radial spells should be the heaviest casts');
  // A mistake has to be distinguishable from a successful tap by feel alone.
  assert.ok(weight('break') > weight('tick') * 3, 'a broken sequence must not feel like a tap');
  assert.ok(Array.isArray(HAPTICS.cues.break.ms), 'a break should be a pattern, not a single buzz');
  // Death is the heaviest thing in the game.
  const all = Object.keys(HAPTICS.cues).filter((n) => n !== 'death');
  for (const other of all) assert.ok(weight('death') > weight(other), `death should out-weigh ${other}`);
});

// ── firing ───────────────────────────────────────────────────────────────────

test('a single-duration cue is sent as a number, a pattern as an array', () => {
  // The Vibration API reads a lone number as one buzz but treats a one-element
  // array differently on some engines, so the distinction matters.
  const { calls } = withVibrate(() => {
    const h = new Haptics();
    h.play('tick');
    h.play('break');
  });
  assert.equal(calls.length, 2);
  assert.equal(typeof calls[0], 'number', 'a single buzz should be a bare number');
  assert.ok(Array.isArray(calls[1]), 'a multi-part cue should be an array');
  assert.equal(calls[1].length, 3);
});

test('durations never round down to zero, which would cancel vibration', () => {
  // navigator.vibrate(0) means "stop vibrating". A strength setting or a very
  // short cue must never be allowed to produce it.
  const { calls } = withVibrate(() => {
    const h = new Haptics({ strength: 0.01 });
    for (const name of Object.keys(HAPTICS.cues)) h.play(name);
  });
  const flatten = calls.flatMap((c) => (Array.isArray(c) ? c : [c]));
  assert.ok(flatten.length > 0);
  for (const ms of flatten) assert.ok(ms >= 4, `a duration collapsed to ${ms}ms`);
});

test('strength scales every duration', () => {
  const collect = (strength) => {
    const { calls } = withVibrate(() => {
      const h = new Haptics({ strength });
      h.play('castMed');
    });
    return calls[0];
  };
  const soft = collect(0.5);
  const normal = collect(1);
  const hard = collect(1.5);
  assert.ok(soft < normal && normal < hard, `strength did not scale: ${soft}/${normal}/${hard}`);
});

test('the same cue cannot retrigger faster than its cooldown', () => {
  // Without this, a fast 3-tap recipe arrives faster than the actuator settles
  // and the whole sequence blurs into one rumble.
  let t = 0;
  const { calls } = withVibrate(() => {
    const h = new Haptics({ now: () => t });
    h.play('tick');
    t += 10; // inside the 26ms cooldown
    h.play('tick');
    h.play('tick');
    t += 40; // past it
    h.play('tick');
  });
  assert.equal(calls.length, 2, `expected 2 ticks, got ${calls.length}`);
});

test('cooldowns are per cue, so a tick never blocks a cast', () => {
  const { calls } = withVibrate(() => {
    const h = new Haptics({ now: () => 0 });
    h.play('tick');
    h.play('castMed');
    h.play('break');
  });
  assert.equal(calls.length, 3, 'different cues should not share a cooldown');
});

test('playNow ignores the cooldown, for cues that must never be dropped', () => {
  const { calls } = withVibrate(() => {
    const h = new Haptics({ now: () => 0 });
    h.play('tick');
    h.play('tick');
    h.playNow('tick');
    h.playNow('tick');
  });
  assert.equal(calls.length, 3, `expected 1 rate-limited plus 2 forced, got ${calls.length}`);
});

test('an unknown cue is ignored rather than throwing', () => {
  const { calls, result } = withVibrate(() => {
    const h = new Haptics();
    return [h.play('nonsense'), h.play(''), h.play(undefined)];
  });
  assert.deepEqual(result, [false, false, false]);
  assert.equal(calls.length, 0);
});

// ── controlling it ───────────────────────────────────────────────────────────

test('toggling off stops all feedback and cancels anything running', () => {
  const { calls } = withVibrate(() => {
    const h = new Haptics();
    h.play('tick');
    const off = h.toggle();
    h.play('tick');
    h.play('castHeavy');
    const on = h.toggle();
    h.play('tick');
    return [off, on];
  });
  // tick, then vibrate(0) to cancel, then tick after re-enabling.
  assert.equal(calls.length, 3, `unexpected call sequence: ${JSON.stringify(calls)}`);
  assert.equal(calls[1], 0, 'disabling should cancel any pattern still running');
  assert.ok(calls[2] > 0, 're-enabling should restore feedback');
});

test('suppressed cues are counted, which is how you debug a silent control', () => {
  const { result } = withVibrate(() => {
    const h = new Haptics({ now: () => 0 });
    h.play('tick');
    h.play('tick');
    h.play('tick');
    return { plays: h.plays, suppressed: h.suppressed };
  });
  assert.equal(result.plays, 1);
  assert.equal(result.suppressed, 2);
});

// ── platform reality ─────────────────────────────────────────────────────────

test('without a Vibration API nothing throws and nothing claims to work', () => {
  // This is iOS Safari, exactly. There is no web haptics API there, and the game
  // has to keep running without it.
  const result = withNavigator({}, () => {
    const h = new Haptics();
    const supported = h.supported;
    const played = h.play('tick');
    return { supported, played, plays: h.plays };
  });
  assert.equal(result.supported, false);
  assert.equal(result.played, false);
  assert.equal(result.plays, 0);
});

test('a driver that throws cannot break the game loop', () => {
  const h = new Haptics({
    driver: () => {
      throw new Error('no actuator');
    },
  });
  assert.throws(() => h.play('tick'), /no actuator/);
  // Note: a custom driver is trusted code. The built-in one swallows its own
  // errors, which is what actually protects the loop - asserted next.
  const builtin = new Haptics();
  const result = withNavigator(
    {
      vibrate() {
        throw new Error('actuator exploded');
      },
    },
    () => builtin.play('tick'),
  );
  assert.equal(result, false, 'the built-in driver must report failure, not throw');
});

test('an injected driver is treated as supported and receives the cue name', () => {
  // This is the native-shell path: @capacitor/haptics maps names to impact
  // styles rather than imitating millisecond patterns.
  const seen = [];
  const h = new Haptics({
    driver: (name, durations) => {
      seen.push([name, durations]);
      return true;
    },
  });
  assert.equal(h.supported, true, 'an injected driver must not be gated on the web API');
  h.play('castHeavy');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'castHeavy', 'the driver needs the cue name for native impact styles');
  assert.ok(Array.isArray(seen[0][1]) && seen[0][1].length === 3, 'and the expanded durations as a fallback');
});

// ── event plumbing ───────────────────────────────────────────────────────────

test('every game event maps to a cue, and casts scale with the spell', () => {
  const seen = [];
  const h = new Haptics({
    now: () => 0,
    driver: (name) => {
      seen.push(name);
      return true;
    },
  });
  // Advance the clock far past every cooldown between events.
  let t = 0;
  h.now = () => (t += 5000);

  for (const type of GAME_EVENTS) {
    if (type === 'cast') continue;
    h.playForEvent({ type });
  }
  for (const spell of ['heal', 'fireball', 'explosion', 'freeze']) {
    h.playForEvent({ type: 'cast', spell });
  }

  assert.equal(seen.length, GAME_EVENTS.length - 1 + 4, `some event produced no cue: ${seen}`);
  assert.ok(seen.includes('tick'), 'element taps must tick');
  assert.ok(seen.includes('break'), 'a broken sequence must be felt');
  assert.ok(seen.includes('castLight') && seen.includes('castHeavy'));
  // An unrecognised cast still gets a sensible default rather than silence.
  const fallback = new Haptics({ driver: () => true, now: () => 1e9 });
  assert.equal(fallback.playForEvent({ type: 'cast', spell: 'mystery' }), true);
});

test('an event with no cue is silently ignored', () => {
  const seen = [];
  const h = new Haptics({
    driver: (name) => {
      seen.push(name);
      return true;
    },
  });
  // These are real events in the stream that deliberately produce no feedback.
  for (const type of ['run-start', 'sequence-clear', 'sequence-expire', 'enemy-fire', 'projectile', 'phrase-cancel']) {
    assert.equal(h.playForEvent({ type }), false, `${type} should not buzz`);
  }
  assert.equal(seen.length, 0);
});
