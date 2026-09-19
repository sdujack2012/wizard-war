/**
 * RUNE PRESSURE - pre-rendered art.
 *
 * The characters, the arena floor and the braziers ship as painted bitmaps
 * generated for this game (see README, "Visuals"). Nothing here is load-bearing:
 * every draw path in `sprites.js` falls back to its vector art when an asset is
 * missing, still in flight, or refused by the platform. That keeps the game
 * playable from a cold cache and on a bad connection, and it is what lets the
 * test suite - which has no image loader at all - exercise the renderer.
 *
 * Loading is fire-and-forget by design: `boot()` never awaits it, so the first
 * frame is never gated on a 480 KB WebP. The painted art simply appears when it
 * arrives, and if it never does the game looks exactly as it did before.
 */

/**
 * Cache-busting version for everything under `assets/`.
 *
 * Bump this whenever a file in `assets/` changes, because the files keep their
 * names and art used to be served `immutable` for thirty days: a player who had
 * visited once kept the OLD sprites however many times they reloaded, since a
 * normal reload does not revalidate an immutable response - only a hard refresh
 * does. Changing the URL is the one thing that reliably reaches them.
 *
 * The server now sends `no-cache` for these files, so this is no longer
 * load-bearing for correctness. It stays as the manual lever, and because stale
 * entries from the immutable era are still sitting in browsers.
 */
export const ART_VERSION = '3';

/** Suffix an asset path with the current art version. */
export const versioned = (path) => `${path}?v=${ART_VERSION}`;

export const ASSETS = {
  floor: versioned('./assets/floor.webp'),
  /** Boot screen key art. The one asset whose absence is visible immediately. */
  splash: versioned('./assets/splash.webp'),
  wizard: versioned('./assets/wizard.png'),
  shade: versioned('./assets/shade.png'),
  wisp: versioned('./assets/wisp.png'),
  brute: versioned('./assets/brute.png'),
  brazier: versioned('./assets/brazier.png'),
  // Walk poses: '<creature>-b' is left foot forward, '-c' is right foot forward.
  // They are optional in exactly the same way as everything else here - with them
  // missing a creature still moves, it just moves without stepping.
  'wizard-b': versioned('./assets/wizard-b.png'),
  'wizard-c': versioned('./assets/wizard-c.png'),
  'shade-b': versioned('./assets/shade-b.png'),
  'shade-c': versioned('./assets/shade-c.png'),
  'brute-b': versioned('./assets/brute-b.png'),
  'brute-c': versioned('./assets/brute-c.png'),
};

/** The three bitmaps a painted creature walks with: neutral, step, step. */
export function posesFor(store, id) {
  if (!store) return { sprite: null, poseA: null, poseB: null };
  return {
    sprite: store.get(id),
    poseA: store.get(`${id}-b`),
    poseB: store.get(`${id}-c`),
  };
}

/**
 * Create an offscreen drawing surface, or null if the platform will not give us
 * one. Callers must handle null by drawing directly.
 */
export function makeSurface(w, h) {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export class AssetStore {
  constructor(sources = ASSETS) {
    this.sources = sources;
    /** id -> HTMLImageElement, only for the ones that actually decoded. */
    this.images = new Map();
    /** `${id}|${color}|${alpha}` -> tinted surface, built once and reused. */
    this.variants = new Map();
    /** 'idle' | 'loading' | 'ready' | 'unsupported' */
    this.state = 'idle';
  }

  /** The decoded image for an id, or null. Never throws, never returns a dud. */
  get(id) {
    const img = this.images.get(id);
    // A zero-sized image means the decode failed somewhere downstream; treat it
    // as absent so the caller draws its vector fallback instead of nothing.
    return img && img.width > 0 && img.height > 0 ? img : null;
  }

  get count() {
    return this.images.size;
  }

  /**
   * Load every asset. Failures are per-asset and silent: a missing floor must
   * not stop the wizard from appearing.
   *
   * Resolves either way - the caller has nothing to do about a failure, and the
   * game is fully playable without any of it.
   */
  load() {
    if (this.state === 'loading' || this.state === 'ready') return this.pending;
    // Node (the test suite) has no Image constructor. Nothing to load, and
    // nothing to complain about.
    if (typeof Image === 'undefined') {
      this.state = 'unsupported';
      return Promise.resolve(this);
    }
    this.state = 'loading';
    const jobs = Object.entries(this.sources).map(
      ([id, src]) =>
        new Promise((resolve) => {
          let img;
          try {
            img = new Image();
          } catch {
            resolve(null);
            return;
          }
          img.onload = () => {
            this.images.set(id, img);
            resolve(img);
          };
          img.onerror = () => resolve(null);
          img.src = src;
        }),
    );
    this.pending = Promise.all(jobs).then((loaded) => {
      this.state = 'ready';
      this.failed = Object.keys(this.sources).filter((id) => !this.images.has(id));
      this.loadedIds = loaded.filter(Boolean).length;
      return this;
    });
    return this.pending;
  }

  /**
   * A flat-tinted copy of an asset, used for the state tells the vector art gets
   * for free: white for a hit flash, red for hurt, green for healing.
   *
   * `source-atop` keeps the sprite's alpha and lays the colour over its pixels,
   * so at a low alpha it reads as a wash and at 1 it is a solid silhouette.
   * Built once per (asset, colour, alpha) and cached: this must never run in the
   * draw loop.
   */
  variant(id, color, alpha = 1) {
    const key = `${id}|${color}|${alpha}`;
    if (this.variants.has(key)) return this.variants.get(key);
    const img = this.get(id);
    if (!img) return null;
    const surface = makeSurface(img.width, img.height);
    const g = surface?.getContext?.('2d');
    if (!g) return null;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fillRect(0, 0, img.width, img.height);
    this.variants.set(key, surface);
    return surface;
  }
}
