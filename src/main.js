/**
 * RUNE PRESSURE - bootstrap and main loop.
 *
 * Wires the simulation, renderer, input and audio together. This is the only
 * place that knows about `document`/`window` timing, and the only place that
 * reacts to simulation events with sound.
 */

import { Audio } from './audio.js';
import { Game, STATE } from './game.js';
import { Input } from './input.js';
import { Renderer } from './render.js';

const BEST_KEY = 'rune-pressure.best';

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

export async function boot(canvas) {
  const renderer = new Renderer(canvas);
  const game = new Game();
  const audio = new Audio();

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
  input.attach();

  const onResize = () => renderer.resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => window.setTimeout(onResize, 150));
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(onResize).observe(canvas);
  }

  function handleEvents(events) {
    for (const ev of events) {
      switch (ev.type) {
        case 'element':
          audio.play('element', { element: ev.element, index: ev.index });
          break;
        case 'cast':
          // Spell ids double as cue names: fireball, waterball, heal, explosion, freeze.
          audio.play(ev.spell);
          break;
        case 'spark':
          audio.play('spark');
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
      lastRecognised: input.lastRecognised,
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
  renderer.render(game, { ...input.hudState(), best, hintT, muted: audio.muted });
  raf = window.requestAnimationFrame(frame);

  const api = {
    game,
    renderer,
    input,
    audio,
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
