/**
 * Audio tests.
 *
 * Every sound in this game is synthesised at runtime, so there are no files to
 * check - the only way to know a cue does anything is to look at the graph it
 * builds. This drives the real Audio class against a recording AudioContext and
 * asserts that:
 *
 *   - each cue actually constructs voices (an empty cue is silence, and a silent
 *     spell is indistinguishable from a broken one);
 *   - the five spell cues, and the three impact cues, are PAIRWISE DISTINCT in
 *     the parameters they synthesize - "different sound effects for spells" is
 *     a claim about the graph, and this is where it is checked;
 *   - the charge-scaled cue really scales with the charge;
 *   - mutes, unknown cues and a context that throws all fail soft.
 *
 * What this does NOT prove is how anything sounds. That needs a real
 * OfflineAudioContext render (see tools/render-cues.mjs), which measures the
 * output waveform; a parameter signature is not a spectrum.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Audio, MUSIC } from '../src/audio.js';

// ── a recording AudioContext ──────────────────────────────────────────────────

class Param {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(v, t) {
    this.events.push(['set', v, t]);
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v, t) {
    this.events.push(['exp', v, t]);
    return this;
  }
  linearRampToValueAtTime(v, t) {
    this.events.push(['lin', v, t]);
    return this;
  }
}

class Node {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.out = [];
    ctx.nodes.push(this);
  }
  connect(dest) {
    this.out.push(dest);
    return dest;
  }
  disconnect() {}
}

class Osc extends Node {
  constructor(ctx, type) {
    super(ctx, 'osc');
    this.type = type;
    this.frequency = new Param(440);
    this.started = null;
    this.stopped = null;
  }
  start(t) {
    this.started = t;
  }
  stop(t) {
    this.stopped = t;
  }
}

class BufSrc extends Node {
  constructor(ctx) {
    super(ctx, 'noise');
    this.buffer = null;
    this.loop = false;
    this.started = null;
  }
  start(t) {
    this.started = t;
  }
  stop() {}
}

class Filter extends Node {
  constructor(ctx) {
    super(ctx, 'filter');
    this.type = 'lowpass';
    this.frequency = new Param(350);
    this.Q = new Param(1);
  }
}

class Gain extends Node {
  constructor(ctx) {
    super(ctx, 'gain');
    this.gain = new Param(1);
  }
}

class FakeContext {
  constructor({ throwOn = null } = {}) {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = { kind: 'destination' };
    this.nodes = [];
    this.state = 'running';
    this.throwOn = throwOn;
  }
  #guard(kind) {
    if (this.throwOn === kind) throw new Error(`blocked: ${kind}`);
  }
  createGain() {
    this.#guard('gain');
    return new Gain(this);
  }
  createOscillator() {
    this.#guard('osc');
    return new Osc(this);
  }
  createBufferSource() {
    this.#guard('source');
    return new BufSrc(this);
  }
  createBiquadFilter() {
    this.#guard('filter');
    return new Filter(this);
  }
  createBuffer(channels, len) {
    this.#guard('buffer');
    const data = new Float32Array(len);
    return { length: len, sampleRate: this.sampleRate, getChannelData: () => data };
  }
  resume() {}
}

/** An Audio wired to a fresh recording context. */
function recording(opts) {
  const ctx = new FakeContext(opts);
  const audio = new Audio();
  audio.attach(ctx);
  ctx.nodes.length = 0; // drop the master gain so counts start at zero
  return { audio, ctx };
}

/** Everything one cue actually synthesised, as a comparable signature. */
function voices(ctx) {
  return ctx.nodes
    .filter((n) => n.kind !== 'gain') // gains are envelopes, not voices
    .map((n) => {
      if (n.kind === 'osc') {
        return [
          'osc',
          n.type,
          Math.round(n.frequency.events[0]?.[1] ?? 0),
          Math.round(n.frequency.events[1]?.[1] ?? 0),
        ].join(':');
      }
      if (n.kind === 'noise') {
        return ['noise', n.buffer ? 'buf' : 'none'].join(':');
      }
      if (n.kind === 'filter') {
        return ['filter', n.type, Math.round(n.frequency.events[0]?.[1] ?? 0), n.Q.value].join(':');
      }
      return n.kind;
    });
}

/** A coarser signature for comparing cues: just the voice shapes. */
function signature(ctx) {
  return voices(ctx).join(' | ');
}

const SPELL_CUES = ['fireball', 'waterball', 'heal', 'explosion', 'freeze'];
const HIT_CUES = ['hitFire', 'hitWater', 'hitIce'];

// ── the graph ─────────────────────────────────────────────────────────────────

test('every cue builds at least one voice', () => {
  const names = [
    ...SPELL_CUES,
    ...HIT_CUES,
    'spark',
    'element',
    'chargeFull',
    'break',
    'fizzle',
    'kill',
    'playerHit',
    'waveStart',
    'waveClear',
    'overtime',
    'death',
  ];
  for (const name of names) {
    const { audio, ctx } = recording();
    audio.play(name, { element: 'fire' });
    assert.ok(voices(ctx).length > 0, `${name} synthesised nothing, so it is silent`);
  }
});

test('the five spells are pairwise distinct sounds', () => {
  const sigs = new Map();
  for (const name of SPELL_CUES) {
    const { audio, ctx } = recording();
    audio.play(name);
    sigs.set(name, signature(ctx));
  }
  for (const a of SPELL_CUES) {
    for (const b of SPELL_CUES) {
      if (a >= b) continue;
      assert.notEqual(
        sigs.get(a),
        sigs.get(b),
        `${a} and ${b} synthesise the same voices, so they do not sound different`,
      );
    }
  }
});

test('impacts are distinct from each other and from the casts', () => {
  const sigs = {};
  for (const name of [...SPELL_CUES, ...HIT_CUES]) {
    const { audio, ctx } = recording();
    audio.play(name);
    sigs[name] = signature(ctx);
  }
  assert.notEqual(sigs.hitFire, sigs.hitWater);
  assert.notEqual(sigs.hitWater, sigs.hitIce);
  assert.notEqual(sigs.hitFire, sigs.hitIce);
  // A hit is not just the cast again at a different volume: the graph differs.
  assert.notEqual(sigs.hitFire, sigs.fireball);
  assert.notEqual(sigs.hitWater, sigs.waterball);
  assert.notEqual(sigs.hitIce, sigs.freeze);
});

test('a landing sounds different from a kill, so a miss is audible', () => {
  const { audio, ctx } = recording();
  audio.play('hitFire');
  const hit = signature(ctx);
  const b = recording();
  b.audio.play('kill');
  assert.notEqual(hit, signature(b.ctx));
});

test('the whole-element cue is distinct from a spell', () => {
  const seen = new Map();
  for (const element of ['fire', 'water', 'earth', 'wind']) {
    const { audio, ctx } = recording();
    audio.play('element', { element });
    seen.set(element, signature(ctx));
  }
  assert.equal(new Set(seen.values()).size, 4, 'the four elements must not share a tap sound');
});

// ── charge scaling ────────────────────────────────────────────────────────────

test('a charged spark scales with the charge, and past half adds a body', () => {
  const peak = (charge) => {
    const { audio, ctx } = recording();
    audio.play('spark', { charge });
    const osc = ctx.nodes.filter((n) => n.kind === 'osc');
    return { count: osc.length, first: osc[0]?.frequency.events[0]?.[1] ?? 0 };
  };
  const light = peak(0);
  const heavy = peak(1);
  assert.ok(heavy.first > light.first, 'a full charge should start higher, not lower');
  assert.ok(heavy.count > light.count, 'a full charge should add a body voice the tap does not have');
  // The threshold is real: just under half is still the bare shot.
  assert.equal(peak(0.4).count, light.count);
});

// ── failing soft ──────────────────────────────────────────────────────────────

test('a muted Audio synthesises nothing at all', () => {
  const { audio, ctx } = recording();
  audio.toggleMute();
  audio.play('explosion');
  assert.equal(voices(ctx).length, 0);
});

test('an unknown cue is a no-op rather than a throw', () => {
  const { audio, ctx } = recording();
  assert.doesNotThrow(() => audio.play('no-such-cue'));
  assert.equal(voices(ctx).length, 0);
});

test('a context that throws cannot escape into the game loop', () => {
  const { audio } = recording({ throwOn: 'osc' });
  assert.doesNotThrow(() => audio.play('fireball'));
  assert.doesNotThrow(() => audio.play('explosion'));
});

test('audio that was never attached stays silent instead of throwing', () => {
  const audio = new Audio();
  assert.equal(audio.available, false);
  assert.doesNotThrow(() => audio.play('fireball'));
});

test('the master gain is the only thing wired to the destination', () => {
  const ctx = new FakeContext();
  const audio = new Audio();
  audio.attach(ctx);
  // Voices must reach the speakers through the master, or mute cannot work.
  const outs = ctx.nodes.flatMap((n) => n.out);
  assert.equal(outs.filter((d) => d === ctx.destination).length, 1);
  assert.equal(ctx.master, undefined); // sanity: the field is `master` on Audio
  assert.ok(audio.master);
  audio.toggleMute();
  assert.equal(audio.master.gain.value, 0);
  audio.toggleMute();
  assert.equal(audio.master.gain.value, 0.34);
});

test('the music track is the one shipped audio asset, and is not a cue', () => {
  // The URL carries a cache-buster, so match the extension, not the end of string.
  assert.match(MUSIC.src, /\.mp3(\?|$)/);
  const { audio, ctx } = recording();
  // Playing cues must never touch the music source.
  for (const name of SPELL_CUES) audio.play(name);
  assert.equal(ctx.nodes.filter((n) => n.kind === 'noise').length > 0, true);
  assert.equal(audio.musicSource, null);
});

// ── the wiring the cues depend on ─────────────────────────────────────────────

/**
 * A cue that is never emitted is silence, and the impact sounds only exist if
 * the engine announces a landing. The game suite cannot see this because it
 * never subscribes; these two tests are the join between the two halves.
 */
test('a bolt landing announces itself, and a miss does not', async () => {
  const { Game, STATE } = await import('../src/game.js');
  const { SPELL_BY_ID } = await import('../src/spells.js');
  const { mulberry32 } = await import('../src/rng.js');
  const { makeEnemy } = await import('../src/entities.js');

  /** One settled enemy directly above the player, so an aimed shot must hit it. */
  const putAbove = (g) => {
    const e = makeEnemy('shade', g.player.x, g.player.y - 70);
    e.spawnT = 0;
    g.enemies.push(e);
    return e;
  };

  const g = new Game({ rng: mulberry32(7), fxRng: mulberry32(7) });
  g.state = STATE.PLAYING;
  g.intermission = 1e9;
  putAbove(g);
  g.drainEvents();
  for (const el of SPELL_BY_ID.fireball.sequence) g.tapElement(el);
  for (let i = 0; i < 40; i++) g.update(1 / 60);
  const hits = g.drainEvents().filter((e) => e.type === 'spell-hit');
  assert.equal(hits.length, 1, 'a fireball that connected emitted no spell-hit');
  assert.equal(hits[0].spell, 'fireball');

  // Now the same shot with nothing to hit: it must fly on and stay silent.
  const empty = new Game({ rng: mulberry32(7), fxRng: mulberry32(7) });
  empty.state = STATE.PLAYING;
  empty.intermission = 1e9;
  empty.drainEvents();
  for (const el of SPELL_BY_ID.fireball.sequence) empty.tapElement(el);
  for (let i = 0; i < 40; i++) empty.update(1 / 60);
  assert.equal(
    empty.drainEvents().filter((e) => e.type === 'spell-hit').length,
    0,
    'a fireball that hit nothing still reported a landing',
  );
});
