/**
 * RUNE PRESSURE - bootstrap and main loop.
 *
 * Wires the simulation, renderer, input and audio together. This is the only
 * place that knows about `document`/`window` timing, and the only place that
 * reacts to simulation events with sound.
 */

import { AssetStore } from './assets.js';
import { Audio } from './audio.js';
import { Game, STATE } from './game.js';
import { Haptics } from './haptics.js';
import { Input } from './input.js';
import { Renderer } from './render.js';

const BEST_KEY = 'rune-pressure.best';
const HAPTICS_KEY = 'rune-pressure.haptics';

function loadBest() {
  try {
    return Number(window.localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function persistBest(value) {
  try {
    window.localStorage.setItem(BEST_KEY, String(value));
  } catch {
    /* private browsing / storage disabled: a lost high score is fine */
  }
}

/** Returns the stored flag, or null when the player has never chosen. */
function loadFlag(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : raw === '1';
  } catch {
    return null;
  }
}

function persistFlag(key, value) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* a lost preference is not worth failing over */
  }
}

export async function boot(canvas) {
  // The painted art loads in the background and is never awaited: the title
  // screen is up in the first frame either way, and every draw path has a vector
  // fallback until the bitmaps arrive (or forever, if they never do).
  const assets = new AssetStore();
  const renderer = new Renderer(canvas, assets);
  const game = new Game();
  const audio = new Audio();
  const haptics = new Haptics();
  assets.load();

  // A stored preference wins over the config default, so a player who turned
  // haptics off does not get buzzed again on their next visit.
  const storedHaptics = loadFlag(HAPTICS_KEY);
  if (storedHaptics !== null) haptics.enabled = storedHaptics;

  let best = loadBest();
  let hintT = 8;
  let bestPersisted = best;

  const input = new Input({
    canvas,
    renderer,
    game,
    onFirstInput: () => {
      // Browsers require a user gesture before audio may start.
      audio.resume();
    },
  });
  input.onToggleMute = () => audio.toggleMute();
  input.onToggleHaptics = () => {
    const on = haptics.toggle();
    persistFlag(HAPTICS_KEY, on);
    // Immediate confirmation, so the player can feel that it worked.
    if (on) haptics.playNow('tick');
    return on;
  };
  input.attach();

  const onResize = () => renderer.resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => window.setTimeout(onResize, 150));
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(onResize).observe(canvas);
  }

  function handleEvents(events) {
    for (const ev of events) {
      // Haptics ride the same event stream as audio, so a cue and a tick always
      // agree about what just happened. Drivers receive the cue name, letting a
      // native backend map to its own impact styles rather than imitating a
      // millisecond pattern.
      haptics.playForEvent(ev);

      switch (ev.type) {
        case 'element':
          audio.play('element', { element: ev.element, index: ev.index });
          break;
        case 'cast':
          // Spell ids double as cue names: fireball, waterball, heal, explosion, freeze.
          audio.play(ev.spell);
          break;
        case 'spark':
          // `charge` (0..1) lets the shot sound as heavy as it is.
          audio.play('spark', { charge: ev.charge ?? 0 });
          break;
        case 'charge-full':
          audio.play('chargeFull');
          break;
        case 'spell-hit':
          // A projectile landing. Fire, water and ice each land differently, so
          // a hit is recognisable with your eyes on the other side of the arena.
          audio.play(ev.spell === 'waterball' ? 'hitWater' : ev.spell === 'fireball' ? 'hitFire' : 'hitIce');
          break;
        case 'sequence-break':
          audio.play('break');
          break;
        case 'fizzle':
          audio.play('fizzle');
          break;
        case 'kill':
          audio.play('kill');
          break;
        case 'player-hit':
          audio.play('playerHit');
          break;
        case 'wave-start':
          audio.play('waveStart');
          hintT = Math.min(hintT, 3);
          break;
        case 'wave-clear':
          audio.play('waveClear');
          break;
        case 'overtime':
          audio.play('overtime');
          break;
        case 'death':
          audio.play('death');
          if (game.score > bestPersisted) {
            bestPersisted = game.score;
            best = game.score;
            persistBest(best);
          }
          break;
        default:
          break;
      }
    }
  }

  let raf = 0;
  let last = performance.now();

  function frame(now) {
    raf = window.requestAnimationFrame(frame);

    // A long stall (tab switch, phone call) must not teleport the world.
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.25);
    last = now;

    input.update(dt);
    game.update(dt);
    handleEvents(game.drainEvents());

    if (game.state === STATE.PLAYING) {
      hintT = Math.max(0, hintT - dt);
      if (game.score > best) best = game.score;
    }

    renderer.render(game, {
      ...input.hudState(),
      best,
      hintT,
      muted: audio.muted,
      haptics: { enabled: haptics.enabled, supported: haptics.supported },
      lastRecognised: input.lastRecognised,
      dt,
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      input.releaseAll();
      if (best > bestPersisted) {
        bestPersisted = best;
        persistBest(best);
      }
    }
    last = performance.now();
  });

  // Draw the title screen immediately rather than after the first RAF tick.
  renderer.render(game, {
    ...input.hudState(),
    best,
    hintT,
    muted: audio.muted,
    haptics: { enabled: haptics.enabled, supported: haptics.supported },
  });
  raf = window.requestAnimationFrame(frame);

  const api = {
    game,
    renderer,
    input,
    audio,
    haptics,
    stop() {
      window.cancelAnimationFrame(raf);
      input.detach();
      window.removeEventListener('resize', onResize);
    },
    /** Test hook: jump straight into a wave with no menu. */
    start() {
      game.startRun();
      return game;
    },
  };
  window.__RUNE_PRESSURE__ = api;
  return api;
}
