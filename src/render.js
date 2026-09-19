/**
 * RUNE PRESSURE - canvas renderer.
 *
 * Owns screen layout, the HUD and the wheel. All character and effect art lives
 * in `sprites.js`; this module decides *where* things go, that one decides what
 * they look like.
 *
 * It also owns the wheel's screen-space geometry, because that is layout, not
 * gameplay. `Input` hit-tests against `hitWheel()`, so the circles you see are
 * exactly the circles you can press - one source of truth.
 *
 * Performance notes for phones:
 *   - never uses ctx.shadowBlur (brutally slow on mobile GPUs)
 *   - the detailed arena floor is rendered once into an offscreen canvas and
 *     blitted, so a rich background costs one drawImage per frame
 *   - the offscreen cache degrades to a direct draw if the platform refuses one
 */

import { ART, FX, MOTION, PLAYER, SEQUENCE, STROKE, TRAIL, UI, WHEEL, WORLD } from './config.js';
import { ELEMENTS, ELEMENT_BY_ID, FOCUS_SPELL, SPELLS, SPELL_BY_ID, chargedSparkCost } from './spells.js';
import { STATE } from './game.js';
import { makeSurface, posesFor } from './assets.js';
import {
  drawArenaFloor,
  drawBolt,
  drawBraziers,
  drawCastLink,
  drawDangerWash,
  drawDecal,
  drawEnemy,
  drawEnemyBolt,
  drawMotes,
  drawParticle,
  drawRing,
  drawRitualGlow,
  drawWizard,
  makeMotes,
  visualRadius,
} from './sprites.js';

/**
 * The palette, in the bright anime register the art now lives in.
 *
 * The old one was built for a dark arena: light ink on near-black, a heavy
 * vignette, and glow everywhere. On a bright high-key arena that inverts -
 * light text on a pale floor is unreadable, and a 0.55 black vignette would
 * frame a cheerful daylight scene with a bruise. So ink is dark, the "glow"
 * colours are used for fills rather than bloom, and panels are white with
 * coloured rims, the way a Japanese game UI reads.
 *
 * `ink`/`dim`/`faint` sit on the *arena*, so they must stay dark: the arena is
 * now the brightest thing on screen, and anything drawn straight onto it needs
 * to be darker than it is.
 */
/** Particle shapes that are opaque matter rather than light. */
const OPAQUE_PARTICLES = new Set(['dust', 'smoke', 'vapour', 'mote']);

/**
 * The palette: an illuminated-manuscript register.
 *
 * The game has been through two earlier palettes - a dark neon arena, then a
 * bright Japanese-cartoon one. Both were built on a high-key blue. The setting
 * is now a medieval courtyard, so the chrome is parchment, sepia ink and brass,
 * and the letterbox around the arena is warm rather than sky blue.
 *
 * Two constraints survive from the earlier passes, and are why this is not
 * simply "brown":
 *   - `ink`/`dim`/`faint` are drawn ON the arena, which is the brightest thing
 *     on screen, so everything placed straight onto it must stay darker than it.
 *   - The four element hues are load-bearing gameplay: the wheel, the recipe
 *     pips and the spell effects are colour-coded, so they are deepened into a
 *     medieval register rather than removed. They must never converge.
 */
const PALETTE = {
  bgTop: '#d9c39a',
  bgBottom: '#efe3c8',
  grid: 'rgba(120,92,52,0.12)',
  border: 'rgba(122,92,52,0.45)',
  ink: '#2f2318',
  dim: '#5b4632',
  faint: '#8a7154',
  hp: '#b23a2e',
  mana: '#2f5da8',
  gold: '#c1913a',
  /** UI panels: parchment with a sepia rim, the manuscript look. */
  panel: 'rgba(244,233,209,0.90)',
  panelEdge: 'rgba(122,92,52,0.5)',
};

/**
 * The spell book's contents: every recipe, then the centre's fallback.
 *
 * SPARK is included even though it is not a recipe, because the book is the
 * answer to "how do I cast that" and the panic button is the one control a new
 * player most needs explained - tap for a dart, hold to wind it up.
 */
const SPELL_BOOK_ROWS = [
  ...SPELLS.map((s) => ({ kind: 'spell', id: s.id, sequence: s.sequence, spell: s })),
  { kind: 'focus', id: 'focus', sequence: [], spell: FOCUS_SPELL },
];

/**
 * A recipe in words, describing the INPUT rather than the element list.
 *
 * "FIRE + FIRE + WIND" is the recipe; "PRESS FIRE, HOLD, DRAG TO WIND" is the
 * gesture, and the gesture is what a player standing at the wheel with a thumb
 * down actually needs. Three shapes, because the three shapes are cast three
 * different ways.
 */
function describeGesture(sequence) {
  const runs = [];
  for (const id of sequence) {
    const last = runs[runs.length - 1];
    if (last && last.id === id) last.count += 1;
    else runs.push({ id, count: 1 });
  }
  const name = (id) => ELEMENT_BY_ID[id]?.name ?? id.toUpperCase();

  if (runs.length === 1) return `HOLD ${name(runs[0].id)} FOR THE SECOND TAP`;
  if (runs.length === 2 && runs[0].count > 1) {
    return `PRESS ${name(runs[0].id)}, HOLD, DRAG TO ${name(runs[1].id)}`;
  }
  if (runs.length === 3) return `DRAG ${runs.map((r) => name(r.id)).join(' \u2192 ')} IN ONE MOTION`;
  return `TAP ${runs.map((r) => name(r.id)).join(' \u2192 ')}`;
}

function setFont(ctx, size, weight = 600) {
  ctx.font = `${weight} ${size}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * One shape per element. Shape is a second channel alongside colour, so the
 * wheel stays readable for colourblind players and at a glance under pressure.
 */
function drawElementGlyph(ctx, cx, cy, size, elementId) {
  const s = size / 2;
  // WIND is drawn as three open strokes rather than a closed outline, and an
  // open path has no area: filling it drew literally nothing, which is why the
  // WIND circle used to sit on the wheel looking empty. It is stroked instead.
  let strokeOnly = false;
  ctx.beginPath();
  switch (elementId) {
    case 'fire': // triangle
      ctx.moveTo(cx, cy - s);
      ctx.lineTo(cx + s * 0.92, cy + s * 0.72);
      ctx.lineTo(cx - s * 0.92, cy + s * 0.72);
      ctx.closePath();
      break;
    case 'water': // droplet: circle with a peak
      ctx.moveTo(cx, cy - s * 1.05);
      ctx.quadraticCurveTo(cx + s, cy - s * 0.1, cx + s * 0.72, cy + s * 0.42);
      ctx.arc(cx, cy + s * 0.42, s * 0.72, 0, Math.PI);
      ctx.quadraticCurveTo(cx - s, cy - s * 0.1, cx, cy - s * 1.05);
      ctx.closePath();
      break;
    case 'earth': // square
      ctx.rect(cx - s * 0.82, cy - s * 0.82, s * 1.64, s * 1.64);
      break;
    case 'wind': // three strokes
      strokeOnly = true;
      for (let i = -1; i <= 1; i++) {
        const y = cy + i * s * 0.56;
        const w = i === 0 ? s * 1.05 : s * 0.82;
        ctx.moveTo(cx - w, y);
        ctx.lineTo(cx + w, y);
      }
      break;
    case 'focus': // four-point star
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 === 0 ? s * 1.05 : s * 0.4;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      break;
    default:
      ctx.arc(cx, cy, s * 0.8, 0, Math.PI * 2);
  }
  if (strokeOnly) {
    ctx.lineWidth = Math.max(1.6, size * 0.14);
    ctx.lineCap = 'round';
    ctx.stroke();
  } else {
    ctx.fill();
  }
}

/** A row of element pips, e.g. the recipe for a spell. */
function drawPips(ctx, sequence, x, y, pipR, gap, opts = {}) {
  const alpha = opts.alpha ?? 1;
  const dim = opts.dim ?? false;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < sequence.length; i++) {
    const el = ELEMENT_BY_ID[sequence[i]];
    const px = x + i * (pipR * 2 + gap) + pipR;
    if (!el) continue;
    ctx.globalAlpha = alpha * (dim ? 0.42 : 1);
    ctx.fillStyle = el.color;
    ctx.beginPath();
    ctx.arc(px, y, pipR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;
    if (!dim) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      drawElementGlyph(ctx, px, y, pipR * 1.15, el.id);
    }
  }
  ctx.restore();
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./assets.js').AssetStore} [assets]
   *   Optional painted art. When it is absent, still loading, or missing an
   *   individual image, every draw path falls back to the vector art in
   *   sprites.js - so the renderer never depends on an asset arriving.
   */
  constructor(canvas, assets = null) {
    this.canvas = canvas;
    this.assets = assets;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.bg = null;
    this.vignette = null;
    this._wheel = null;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this._wheel = null; // layout is resolution-dependent

    const ctx = this.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, PALETTE.bgTop);
    g.addColorStop(1, PALETTE.bgBottom);
    this.bg = g;

    const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.78);
    // Warm sepia rather than the old blue: the arena is a sunlit courtyard now,
    // and a blue vignette around warm stone reads as a bruise.
    v.addColorStop(0, 'rgba(58,42,24,0)');
    v.addColorStop(1, 'rgba(58,42,24,0.22)');
    this.vignette = v;

    this.motes = makeMotes(38, WORLD.w, WORLD.h);
    this.buildFloor();
  }

  /**
   * Pre-render the arena floor once. It is by far the most detailed thing on
   * screen and none of it changes, so paying for it every frame would be pure
   * waste - especially on a phone.
   */
  buildFloor() {
    const { s } = this.viewport();
    const dpr = Math.min(this.dpr, 2);
    // Cap the cache scale: past ~2x the upload cost outweighs the sharpness.
    const scale = Math.max(0.5, Math.min(s * dpr, 2));
    const w = Math.ceil(WORLD.w * scale);
    const h = Math.ceil(WORLD.h * scale);
    const surface = makeSurface(w, h);
    if (!surface) {
      this.floorCanvas = null;
      return;
    }
    const g = surface.getContext('2d');
    if (!g) {
      this.floorCanvas = null;
      return;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.scale(scale, scale);
    drawArenaFloor(g, WORLD.w, WORLD.h);
    this.floorCanvas = surface;
  }

  /** Fit the fixed logical arena into the screen, centred (letterboxed). */
  viewport() {
    const s = Math.min(this.w / WORLD.w, this.h / WORLD.h);
    return { s, ox: (this.w - WORLD.w * s) / 2, oy: (this.h - WORLD.h * s) / 2 };
  }

  screenToWorld(px, py) {
    const { s, ox, oy } = this.viewport();
    return { x: (px - ox) / s, y: (py - oy) / s };
  }

  /** Screen-space x that separates the movement half from the casting half. */
  castZoneStart() {
    return this.w * UI.castZoneX;
  }

  // ── wheel geometry (shared with Input) ────────────────────────────────────

  wheelLayout() {
    if (this._wheel) return this._wheel;
    const minDim = Math.min(this.w, this.h);
    const ring = clamp(minDim * WHEEL.ringRadiusFrac, WHEEL.ringRadiusMin, WHEEL.ringRadiusMax);
    const r = ring * WHEEL.elementRadiusFrac;
    const focusR = ring * WHEEL.focusRadiusFrac;

    // Hard right, under the thumb that uses it - pulled back only as far as the
    // screen requires. The outermost circle sits on the ring at 3 o'clock, so
    // the plate's right edge is cx + ring + r + platePad; anything further right
    // would clip the glow ring on a narrow phone.
    const plateReach = ring + r + WHEEL.platePad;
    const cx = Math.min(this.w * WHEEL.centerXFrac, this.w - plateReach - WHEEL.edgePad);
    const cy = this.h * WHEEL.centerYFrac;

    const buttons = ELEMENTS.map((el) => ({
      id: el.id,
      kind: 'element',
      elementId: el.id,
      element: el,
      x: cx + Math.cos(el.angle) * ring,
      y: cy + Math.sin(el.angle) * ring,
      r,
      color: el.color,
    }));
    buttons.push({
      id: 'focus',
      kind: 'focus',
      elementId: 'focus',
      element: FOCUS_SPELL,
      x: cx,
      y: cy,
      r: focusR,
      color: FOCUS_SPELL.color,
    });

    this._wheel = { cx, cy, ring, r, focusR, buttons };
    return this._wheel;
  }

  /** Nearest button whose padded radius contains the point, or null. */
  hitWheel(x, y) {
    const layout = this.wheelLayout();
    let best = null;
    let bestScore = Infinity;
    for (const b of layout.buttons) {
      const d = Math.hypot(x - b.x, y - b.y);
      const reach = b.r * WHEEL.hitPadding;
      if (d > reach) continue;
      // Normalised distance keeps the centre circle from stealing taps that
      // clearly belong to an element at the boundary between them.
      const score = d / reach;
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  // ── the spell book ────────────────────────────────────────────────────────

  /**
   * Geometry for the corner button and the card it opens.
   *
   * The card is pinned to the LEFT of the screen on purpose. The wheel is where
   * a gesture is demonstrated, so the reference card and the control it is
   * teaching must never overlap - a book that covered the thing it was pointing
   * at would be worse than no book.
   */
  spellBookLayout() {
    if (this._book) return this._book;
    const S = UI.spellBook;
    const size = clamp(Math.min(this.w, this.h) * S.sizeFrac, S.sizeMin, S.sizeMax);
    const pad = S.pad;
    const rows = SPELL_BOOK_ROWS.length;

    const cardW = Math.min(this.w * S.cardWFrac, S.cardMaxW);
    const cardX = pad;
    const cardY = pad;
    const cardH = this.h - pad * 2;
    const headerH = clamp(this.h * 0.1, 34, 46);
    const footerH = clamp(this.h * 0.085, 26, 40);
    const rowH = clamp((cardH - headerH - footerH) / rows, S.rowMin, S.rowMax);
    const listTop = cardY + headerH;

    const list = SPELL_BOOK_ROWS.map((row, i) => ({
      ...row,
      x: cardX + 10,
      y: listTop + i * rowH,
      w: cardW - 20,
      h: rowH,
      cy: listTop + i * rowH + rowH / 2,
    }));

    this._book = {
      size,
      pad,
      button: { x: pad, y: this.h - pad - size, w: size, h: size, r: size * 0.22 },
      card: { x: cardX, y: cardY, w: cardW, h: cardH },
      headerH,
      rowH,
      list,
      footerY: listTop + rows * rowH + footerH / 2,
      close: { x: cardX + cardW - headerH * 0.8, y: cardY + headerH * 0.1, w: headerH * 0.7, h: headerH * 0.7 },
    };
    return this._book;
  }

  /**
   * Hit-test the book, in whichever of its two lives it is in.
   *
   * `button` is the corner icon during play; the rest belongs to the open card.
   * Both go through the renderer for the same reason the wheel does - one source
   * of truth, so what is drawn is exactly what can be pressed.
   */
  hitSpellBook(x, y) {
    const L = this.spellBookLayout();
    const inside = (r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    if (inside(L.button)) return { kind: 'button' };
    if (inside(L.close)) return { kind: 'close' };

    // Generous, full-width rows: a reference list is read and tapped one-handed,
    // so the target is the row, not the text inside it.
    for (const row of L.list) {
      if (x >= L.card.x && x <= L.card.x + L.card.w && y >= row.y && y <= row.y + row.h) {
        return { kind: 'row', row };
      }
    }
    // Anywhere else on the card is inert, so a mis-tap while reading does not
    // dismiss the book. Only the explicit close, or a tap off the card, does.
    if (inside(L.card)) return { kind: 'card' };
    return { kind: 'scrim' };
  }

  /**
   * The gesture, drawn on the wheel.
   *
   * A recipe is not a list of taps, it is a SHAPE: two of them are one short
   * drag, and the radial two are a sweep across the disc. Drawing the shape is
   * the only honest way to answer "how do I cast it", because the answer is
   * different for FIREBALL (press, wait, drag) than for EXPLOSION (drag through
   * three circles in one motion).
   *
   * Consecutive repeats collapse into one node carrying a count, which is what
   * makes FIRE+FIRE+WIND read as "FIRE twice, then WIND" rather than as a line
   * from FIRE to itself.
   */
  trajectoryNodes(sequence) {
    const L = this.wheelLayout();
    const byId = Object.fromEntries(L.buttons.map((b) => [b.id, b]));
    const nodes = [];
    for (const id of sequence) {
      const b = byId[id];
      if (!b) continue;
      const last = nodes[nodes.length - 1];
      if (last && last.id === id) last.count += 1;
      else nodes.push({ id, count: 1, x: b.x, y: b.y, r: b.r, button: b });
    }
    return nodes;
  }

  /**
   * The demonstrated gesture as a TIMELINE, so it can be played rather than
   * merely drawn.
   *
   * Each circle gets a beat - a REPEATED circle gets STROKE.repeatMs worth, so
   * the animation waits exactly as long as the real control makes you wait - and
   * each change of circle gets a travel beat. Reading a position back out of that
   * timeline is what turns a diagram into a demonstration.
   */
  trajectoryTimeline(nodes) {
    const S = UI.spellBook;
    const events = [];
    let t = 0;
    nodes.forEach((n, i) => {
      const beat = S.pressS + (n.count - 1) * (STROKE.repeatMs / 1000);
      events.push({ kind: 'press', node: i, t0: t, t1: t + beat });
      t += beat;
      if (i < nodes.length - 1) {
        events.push({ kind: 'move', from: i, to: i + 1, t0: t, t1: t + S.moveS });
        t += S.moveS;
      }
    });
    return { events, total: t, cycle: t + S.endHoldS };
  }

  /**
   * Where the gesture has got to, `clock` seconds into the loop.
   *
   * How far along each leg the thumb is (`frac`), where the head is, and which
   * circle is being pressed - enough to draw a partial path with something
   * travelling along it.
   */
  trajectoryAt(nodes, clock) {
    const { events, total, cycle } = this.trajectoryTimeline(nodes);
    const legs = nodes.slice(0, -1).map((a, i) => ({ a, b: nodes[i + 1], frac: 0 }));
    const phase = cycle > 0 ? ((clock % cycle) + cycle) % cycle : 0;

    let head = null;
    let active = -1;
    let dwelling = false;

    if (phase >= total) {
      // The gesture is complete, and held up as the answer for a beat.
      legs.forEach((l) => {
        l.frac = 1;
      });
      active = nodes.length - 1;
      const last = nodes[nodes.length - 1];
      head = { x: last.x, y: last.y, r: last.r };
      dwelling = true;
    } else {
      for (const e of events) {
        if (phase >= e.t1) {
          if (e.kind === 'move') legs[e.from].frac = 1;
          else active = e.node;
          continue;
        }
        if (phase < e.t0) break;
        const k = (phase - e.t0) / Math.max(1e-6, e.t1 - e.t0);
        if (e.kind === 'press') {
          active = e.node;
          dwelling = true;
          const n = nodes[e.node];
          head = { x: n.x, y: n.y, r: n.r };
        } else {
          const a = nodes[e.from];
          const b = nodes[e.to];
          legs[e.from].frac = k;
          head = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
        }
        break;
      }
    }
    return { legs, head, active, dwelling, phase };
  }

  /**
   * The gesture in motion: the path draws itself, a head travels it, a repeated
   * circle visibly waits, and each circle rings as the thumb arrives. A static
   * arrow says what the shape is; this says how it is performed, which is the
   * question a player standing at the wheel actually has.
   */
  drawTrajectoryAnimated(game, sequence, color) {
    const ctx = this.ctx;
    const nodes = this.trajectoryNodes(sequence);
    if (!nodes.length) return;
    const { legs, head, active, dwelling } = this.trajectoryAt(nodes, game.spellBookT);
    const base = color ?? PALETTE.ink;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = base;
    ctx.lineWidth = 3.6;
    for (const leg of legs) {
      if (leg.frac <= 0) continue;
      const seg = this.legSegment(leg);
      if (!seg) continue;
      ctx.globalAlpha = 0.72;
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x1 + (seg.x2 - seg.x1) * leg.frac, seg.y1 + (seg.y2 - seg.y1) * leg.frac);
      ctx.stroke();

      // The arrowhead only once the leg is finished: one that appears mid-travel
      // is pointing at somewhere the thumb has not been.
      if (leg.frac >= 1) {
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(seg.x2, seg.y2);
        ctx.lineTo(seg.x2 - seg.ux * 8 - seg.uy * 4.4, seg.y2 - seg.uy * 8 + seg.ux * 4.4);
        ctx.lineTo(seg.x2 - seg.ux * 8 + seg.uy * 4.4, seg.y2 - seg.uy * 8 - seg.ux * 4.4);
        ctx.closePath();
        ctx.fillStyle = base;
        ctx.fill();
      }
    }

    // Every circle in the gesture, dim until the thumb arrives.
    nodes.forEach((n, i) => {
      const reached = i <= active;
      ctx.globalAlpha = reached ? 0.95 : 0.28;
      ctx.strokeStyle = base;
      ctx.lineWidth = reached ? 3 : 2;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r * 1.22, 0, Math.PI * 2);
      ctx.stroke();
      if (dwelling && i === active) {
        const k = 0.5 + 0.5 * Math.sin(game.spellBookT * 14);
        ctx.globalAlpha = 0.3 + 0.45 * k;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * (1.32 + 0.07 * k), 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    // The travelling head.
    if (head) {
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The cast-confirmation glow for one circle.
   *
   * FIRE+FIRE+WIND has to light FIRE twice and WIND once, in that order, so the
   * intensity is the strongest of every position that circle occupies in the
   * recipe rather than a single lookup.
   */
  castGlowFor(game, button) {
    const glow = game.castGlow;
    if (!glow) return;
    let k = 0;
    glow.seq.forEach((id, i) => {
      if (id !== button.id) return;
      const local = (glow.t - i * SEQUENCE.castGlowStagger) / SEQUENCE.castGlowDur;
      if (local <= 0 || local >= 1) return;
      // A bump: rises fast, falls slow, so the beat has an attack.
      const bump = local < 0.25 ? local / 0.25 : 1 - (local - 0.25) / 0.75;
      if (bump > k) k = bump;
    });
    if (k <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.5 * k;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3 + 4 * k;
    ctx.beginPath();
    ctx.arc(button.x, button.y, button.r * (1.05 + 0.3 * k), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.35 * k;
    ctx.fillStyle = button.color;
    ctx.beginPath();
    ctx.arc(button.x, button.y, button.r * (1.5 + 0.5 * k), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** The shortened on-screen segment for a leg, shared by every trajectory draw. */
  legSegment(leg) {
    const { a, b } = leg;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const gapA = a.r * 1.0;
    const gapB = b.r * 1.2;
    if (len <= gapA + gapB) return null;
    return { x1: a.x + ux * gapA, y1: a.y + uy * gapA, x2: b.x - ux * gapB, y2: b.y - uy * gapB, ux, uy };
  }

  /**
   * The centre circle's own gesture: tap for a dart, hold to wind it up.
   *
   * Split across the same two layers as a recipe's path, and for the same
   * reason: the ring belongs under the wheel's circles, but the label does not -
   * anywhere below the centre is EARTH, which would paint straight over it.
   */
  drawFocusGesture(layer = 'path') {
    const ctx = this.ctx;
    const f = this.wheelLayout().buttons.find((b) => b.id === 'focus');

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (layer === 'steps') {
      // On top of everything, on its own parchment pill: it lands on the EARTH
      // circle, and small type over a coloured disc is not readable.
      const text = 'TAP \u00B7 OR HOLD';
      setFont(ctx, Math.max(9, f.r * 0.3), 800);
      const tw = ctx.measureText(text).width;
      const ty = f.y + f.r * 1.45;
      roundRect(ctx, f.x - tw / 2 - 6, ty - 9, tw + 12, 18, 9);
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = PALETTE.panel;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = PALETTE.panelEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = PALETTE.ink;
      ctx.fillText(text, f.x, ty);
      ctx.restore();
      return;
    }

    // A ring crawling outward and repeating: the shape of "keep holding", which
    // is the one thing about the centre circle a path cannot show. In ink rather
    // than SPARK's own colour, which is a near-white cream meant to glow against
    // the arena and would be invisible as an annotation on a pale floor.
    const pulse = (performance.now() / 750) % 1;
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineCap = 'round';

    ctx.globalAlpha = 0.6 * (1 - pulse);
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r * (1 + pulse * 0.8), 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(3, f.r * 0.2);
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r * 0.66, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.35);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.restore();
  }

  drawTrajectory(sequence, { muted = false, color = null, layer = 'path', steps = false } = {}) {
    const ctx = this.ctx;
    const nodes = this.trajectoryNodes(sequence);
    if (!nodes.length) return;

    const base = color ?? PALETTE.ink;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (layer === 'path') {
      ctx.globalAlpha = muted ? 0.32 : 0.72;
      ctx.strokeStyle = base;
      ctx.lineWidth = muted ? 2.5 : 3.6;
      for (let i = 1; i < nodes.length; i++) {
        const a = nodes[i - 1];
        const b = nodes[i];
        // Stop short of the target and start outside the source, so the line
        // reads as passing between the circles rather than through them.
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const gapA = a.r * 1.0;
        const gapB = b.r * 1.2;
        if (len <= gapA + gapB) continue;
        const x1 = a.x + ux * gapA;
        const y1 = a.y + uy * gapA;
        const x2 = b.x - ux * gapB;
        const y2 = b.y - uy * gapB;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // An arrowhead, so the sweep has a direction and not just two ends.
        const ah = 8;
        ctx.globalAlpha = muted ? 0.36 : 0.85;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - ux * ah - uy * ah * 0.55, y2 - uy * ah + ux * ah * 0.55);
        ctx.lineTo(x2 - ux * ah + uy * ah * 0.55, y2 - uy * ah - ux * ah * 0.55);
        ctx.closePath();
        ctx.fillStyle = base;
        ctx.fill();
        ctx.globalAlpha = muted ? 0.32 : 0.72;
      }
      ctx.restore();
      return;
    }

    if (!steps) {
      ctx.restore();
      return;
    }

    // Step badges, numbered by PRESS and not by node. FIRE+FIRE+WIND is three
    // presses across two circles, so the first badge reads "1,2" and the second
    // reads "3" - which is the only numbering that matches what the thumb does.
    // They sit at the TOP of each circle, the one part of the face that carries
    // no information: the glyph is centred and the name is along the bottom.
    let press = 0;
    for (const n of nodes) {
      press += 1;
      const label = n.count > 1 ? `${press},${press + 1}` : String(press);
      const br = Math.max(11, n.r * 0.3);
      const by = n.y - n.r * 0.62;

      ctx.globalAlpha = 1;
      ctx.fillStyle = n.button.color ?? base;
      ctx.beginPath();
      ctx.arc(n.x, by, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      setFont(ctx, Math.max(9, br * 0.82), 800);
      ctx.fillText(label, n.x, by + 0.5);

      if (n.count > 1) {
        // The word for it, hung under the badge: the number says how many times,
        // the word says how. It lands on the element's glyph, so it gets the same
        // dark halo the banner text uses - white on a coloured shape is not type.
        setFont(ctx, Math.max(7, br * 0.58), 800);
        const hy = by + br * 1.7;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(30,20,10,0.6)';
        ctx.strokeText('HOLD', n.x, hy);
        ctx.fillStyle = '#ffffff';
        ctx.fillText('HOLD', n.x, hy);
      }
      press += n.count - 1;
    }
    ctx.restore();
  }

  /**
   * The line the thumb drew.
   *
   * Deliberately NOT the same thing as the circle-to-circle path the wheel
   * already shows: this is the raw finger, with its curve and its overshoot. The
   * thumb covers the evidence while the gesture is happening, so the line is the
   * only way to see what was actually drawn - and seeing it is how a player
   * learns that a sloppy arc skipped a circle.
   *
   * The tail fades along its length, so the line has a direction and a head
   * rather than reading as a rope.
   */
  drawTrail(hud) {
    const pts = hud.trail;
    if (!pts || pts.length < 2) return;
    const fade = hud.trailFade ?? 1;
    if (fade <= 0) return;

    const ctx = this.ctx;
    const n = pts.length;
    const keep = Math.max(2, Math.floor(n * TRAIL.tailFrac));
    const from = Math.max(1, n - keep);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = PALETTE.ink;
    for (let i = from; i < n; i++) {
      const k = (i - from) / Math.max(1, n - from);
      ctx.globalAlpha = fade * 0.5 * k;
      ctx.lineWidth = 1.5 + k * 3.5;
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    // The head: where the thumb is right now, so a stopped thumb still reads as
    // "here", not as a line that has gone out.
    const head = pts[n - 1];
    ctx.globalAlpha = fade * 0.85;
    ctx.fillStyle = PALETTE.ink;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  render(game, hud = {}) {
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, w, h);

    // This is a two-thumb landscape game; a portrait phone letterboxes the
    // arena down to a strip. Say so instead of shipping an unplayable screen.
    if (h > w * 1.12) {
      this.drawRotateHint();
      return;
    }

    let sx = 0;
    let sy = 0;
    if (game.shake > 0.2) {
      sx = (Math.random() * 2 - 1) * game.shake;
      sy = (Math.random() * 2 - 1) * game.shake;
    }
    ctx.save();
    ctx.translate(sx, sy);

    // The splash is a full-bleed screen: no arena, no entities, no HUD. It draws
    // before the world pass so nothing behind it can leak through the art.
    if (game.state === STATE.SPLASH) {
      // No vignette: it is authored to frame the arena and only dulls key art
      // that is already composed edge to edge.
      this.drawSplash(game, hud);
      ctx.restore();
      return;
    }

    const { s, ox, oy } = this.viewport();
    // Real frame time drives the drifting motes, so they stay in step with the
    // simulation's slow-motion instead of buzzing through it.
    const dt = Math.min(hud.dt ?? 1 / 60, 1 / 30);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    this.drawArena(game, hud, dt);
    this.drawRings(game, false);
    this.drawParticles(game);
    this.drawEnemies(game);
    this.drawProjectiles(game);
    this.drawLinks(game);
    this.drawPlayer(game);
    this.drawRings(game, true);
    this.drawTexts(game);
    ctx.restore();

    this.drawStick(hud.stick);
    ctx.restore();

    this.drawFlash(game);
    if (game.state === STATE.PLAYING) {
      this.drawWheel(game, hud);
      // The player's own drag goes on top of the wheel, not under it: the wheel's
      // backing plate and its circles are opaque enough to swallow the line
      // entirely, which is exactly what happened the first time this was drawn
      // with the rest of the world.
      this.drawTrail(hud);
      this.drawSequence(game, hud);
      this.drawHud(game, hud);
      this.drawRecipeChart(game, hud);
      this.drawSpellBookButton(game, hud);
    } else if (game.state === STATE.SPELLBOOK) {
      // The wheel stays: it is the blackboard the book teaches on. The recipe
      // chart and the HUD do not, because the card says the same thing better and
      // the point of this screen is the gesture, not the running numbers.
      this.drawWheel(game, hud);
      this.drawSequence(game, hud);
      this.drawSpellBook(game, hud);
    }
    this.drawBanner(game);
    if (game.state === STATE.TITLE) this.drawTitle(game, hud);
    if (game.state === STATE.GAMEOVER) this.drawGameOver(game, hud);
    ctx.fillStyle = this.vignette;
    ctx.fillRect(0, 0, w, h);
  }

  // ── world layers ──────────────────────────────────────────────────────────

  /**
   * The arena: cached stone floor, then the living parts of the ritual circle.
   * `dt` drives the drifting motes.
   */
  drawArena(game, hud, dt = 1 / 60) {
    const ctx = this.ctx;
    const t = game.time;

    ctx.save();

    // Static floor. Three paths, best first: the painted arena, the pre-rendered
    // vector floor in an offscreen cache, or that same vector floor drawn
    // directly if the platform refused us an offscreen surface at all.
    const painted = this.assets?.get('floor');
    if (painted) {
      ctx.drawImage(painted, 0, 0, WORLD.w, WORLD.h);
      if (ART.floorShade > 0) {
        // The vector floor was flat and dark; the painted one has more going on,
        // so shade it a little to keep bolts and creatures reading as the
        // brightest things on screen.
        ctx.save();
        ctx.globalAlpha = ART.floorShade;
        // Warm shading, so the courtyard reads as lit by firelight and sun
        // rather than by the old cool arena light.
        ctx.fillStyle = '#4a3a24';
        ctx.fillRect(0, 0, WORLD.w, WORLD.h);
        ctx.restore();
      }
    } else if (this.floorCanvas) {
      ctx.drawImage(this.floorCanvas, 0, 0, WORLD.w, WORLD.h);
    } else {
      drawArenaFloor(ctx, WORLD.w, WORLD.h);
    }

    // How close the run is to falling apart: drives the red wash and the colour
    // of the circle's light.
    const danger =
      game.state === STATE.PLAYING
        ? Math.max(
            game.overtimeCount > 0 ? 1 : 0,
            game.waveTimer < 12 ? 1 - Math.max(0, game.waveTimer) / 12 : 0,
          )
        : 0;

    drawRitualGlow(ctx, WORLD.w, WORLD.h, t, danger);
    // The painted brazier is the bowl; the vector pass on top is its firelight,
    // which keeps the corners alive and costs two translucent discs each.
    this.drawBraziers(t);
    if (this.motes) drawMotes(ctx, this.motes, WORLD.w, WORLD.h, dt, t);
    drawDangerWash(ctx, WORLD.w, WORLD.h, danger);
    // Scorch and frost sit ON the floor, under everything that moves: they are
    // last in the arena pass so the danger wash cannot tint them.
    this.drawDecals(game);

    // The two-thumb split stays legible, but only just: a whisper of tint over
    // real art instead of a slab of flat colour.
    const zoneX = WORLD.w * UI.castZoneX;
    ctx.fillStyle = 'rgba(90,150,255,0.03)';
    ctx.fillRect(zoneX, 0, WORLD.w - zoneX, WORLD.h);

    ctx.strokeStyle = 'rgba(140,200,255,0.13)';
    ctx.setLineDash([9, 13]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(zoneX, 26);
    ctx.lineTo(zoneX, WORLD.h - 26);
    ctx.stroke();
    ctx.setLineDash([]);

    if (hud && hud.hintT > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.55, hud.hintT * 0.3);
      setFont(ctx, 14, 700);
      ctx.fillStyle = '#2f6fb5';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('DRAG HERE TO MOVE', zoneX / 2, 34);
      // "or drag" is load-bearing: the stroke is a real way to cast, but it is
      // invisible until someone tries it, and a feature nobody discovers may as
      // well not exist.
      ctx.fillText('TAP OR DRAG THE ELEMENTS', zoneX + (WORLD.w - zoneX) / 2, 34);
      ctx.restore();
    }
    ctx.restore();
  }

  /** Spell and status rings. Blast rings draw over enemies, frost beneath them. */
  drawRings(game, over) {
    const ctx = this.ctx;
    for (const r of game.rings) {
      const isBlast = r.kind === 'nova';
      if (over !== isBlast) continue;
      drawRing(ctx, r, game.time);
    }
  }

  drawParticles(game) {
    const ctx = this.ctx;
    ctx.save();
    // Three passes, because the arena is bright and light can no longer be
    // *added* to it. Matter (smoke, dust, vapour, motes) is drawn opaque. Every
    // glowing particle then gets a dark ink silhouette under it, and only then
    // the additive pass that makes it glow. Without the ink pass a spark over
    // pale stone is a pale smudge.
    for (const p of game.particles) {
      if (OPAQUE_PARTICLES.has(p.shape)) drawParticle(ctx, p);
    }
    for (const p of game.particles) {
      // Only worth an extra draw for particles that are actually visible.
      if (!OPAQUE_PARTICLES.has(p.shape) && p.size >= 2.2) drawParticle(ctx, p, { ink: true });
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const p of game.particles) {
      if (!OPAQUE_PARTICLES.has(p.shape)) drawParticle(ctx, p);
    }
    ctx.restore();
  }

  /** Short arcs from the staff to the muzzle as a spell leaves it. */
  drawLinks(game) {
    const ctx = this.ctx;
    if (!game.linkBolts.length) return;
    for (const l of game.linkBolts) drawCastLink(ctx, l);
  }

  /**
   * The four corner braziers. The painted bowl (if we have one) goes down first,
   * then the vector firelight on top of it - the additive pass is what animates.
   */
  drawBraziers(t) {
    const ctx = this.ctx;
    const { inset } = ART.brazier;
    const spots = [
      [inset, inset],
      [WORLD.w - inset, inset],
      [inset, WORLD.h - inset],
      [WORLD.w - inset, WORLD.h - inset],
    ];
    // Looked up every frame, deliberately. This used to be cached behind a
    // `=== undefined` guard while the constructor initialised the field to
    // `null`, so the lookup never ran and the brazier sprite was never drawn at
    // all - and the test that poked the field to `undefined` hid it. A Map hit
    // is not worth that class of bug.
    const bowl = this.assets?.get('brazier') ?? null;
    if (bowl) {
      const { w, h } = ART.brazier;
      ctx.save();
      for (const [x, y] of spots) {
        // A grounding shadow, because a pale painted brazier on pale painted
        // stone is otherwise just more stone.
        ctx.globalAlpha = 0.32;
        ctx.fillStyle = '#2b3a55';
        ctx.beginPath();
        ctx.ellipse(x, y + h * 0.06, w * 0.5, h * 0.34, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.drawImage(bowl, x - w / 2, y - h / 2, w, h);
      }
      ctx.restore();
    }
    drawBraziers(ctx, WORLD.w, WORLD.h, t);
  }

  /** Every live floor mark, oldest first so the newest reads on top. */
  drawDecals(game) {
    for (const d of game.decals ?? []) drawDecal(this.ctx, d, game.time);
  }

  /**
   * Which way an actor wants to face, held between frames.
   *
   * `want` is a signed horizontal direction, or ~0 when there is nothing to go
   * on: standing still, or directly above/below a target. A near-zero value must
   * NOT reset the facing - that is what made the wizard turn to face left every
   * time you let go of the stick - so the last decisive heading is kept.
   */
  headingOf(actor, want) {
    if (Math.abs(want) > 1) actor.faceX = want < 0 ? -1 : 1;
    return actor.faceX ?? 1;
  }

  /**
   * How a creature is moving, in the form `sprites.js` wants it.
   *
   * The simulation measures actual travel per frame, so this is real ground
   * covered rather than intent: a creature pinned against a wall, shoved, or
   * standing still with a key held gets no walk cycle at all.
   */
  motionOf(actor, { speed, facingX }) {
    const speedFrac = speed > 0 ? Math.min(1, (actor.speedNow ?? 0) / speed) : 0;
    return {
      gait: actor.gait ?? 0,
      moveK: Math.min(1, speedFrac / Math.max(MOTION.moveThreshold, 1e-3)),
      lean: Math.max(-1, Math.min(1, (actor.vxNow ?? 0) / Math.max(speed, 1e-3))) * MOTION.lean,
      // The bitmaps are drawn FACING LEFT. So the mirror is applied when the
      // actor wants to face RIGHT, which is the opposite of the obvious reading
      // and was wrong for a long time: every creature walked backwards, and a
      // creature that stopped snapped back to the unflipped art and faced left
      // for ever. See `headingOf` for the idle case.
      mirror: ART.mirror && facingX > 0 ? 1 : 0,
    };
  }

  drawEnemies(game) {
    const ctx = this.ctx;
    for (const e of game.enemies) {
      if (e.spawnT > 0) {
        const k = 1 - e.spawnT / 0.45;
        ctx.save();
        ctx.globalAlpha = 0.25 + 0.55 * k;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 6]);
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.radius + 14 * (1 - k), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = e.spawnT > 0 ? Math.max(0.2, 1 - e.spawnT / 0.45) : 1;
      const art = this.assets?.get(e.type);
      // Pose images live on the entity for the duration of the draw: sprites.js
      // is a pure drawing library and does not know what an AssetStore is.
      const poses = posesFor(this.assets, e.type);
      e.poseA = poses.poseA;
      e.poseB = poses.poseB;
      e.motion = this.motionOf(e, { speed: e.speed ?? 1, facingX: this.headingOf(e, game.player.x - e.x) });
      drawEnemy(ctx, e, {
        time: game.time,
        px: game.player.x,
        py: game.player.y,
        // The painted body, plus the white silhouette the vector art also
        // flashes with on a hit - built once and cached, never per frame.
        sprite: poses.sprite,
        spriteFlash: art ? this.assets.variant(e.type, '#ffffff', 1) : null,
      });
      ctx.restore();

      const vr = visualRadius(e);

      // Chilled or drenched enemies get a visible frost shell.
      if (e.slowT > 0 && e.spawnT <= 0) {
        ctx.save();
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = '#e8c07a';
        ctx.beginPath();
        ctx.arc(e.x, e.y, vr + 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = '#e8c07a';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(e.x, e.y, vr + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (e.hp < e.maxHp - 0.01 && e.spawnT <= 0) {
        const w = vr * 1.7;
        const frac = Math.max(0, e.hp / e.maxHp);
        const by = e.y - vr - 11;
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.62)';
        ctx.fillRect(e.x - w / 2 - 1, by - 1, w + 2, 5.5);
        ctx.fillStyle = e.color;
        ctx.fillRect(e.x - w / 2, by, w * frac, 3.5);
        ctx.restore();
      }
    }
  }

  drawProjectiles(game) {
    const ctx = this.ctx;
    ctx.save();
    for (const b of game.bolts) drawBolt(ctx, b, game.time);
    for (const b of game.ebolts) drawEnemyBolt(ctx, b, game.time);
    ctx.restore();
  }

  drawPlayer(game) {
    const p = game.player;
    if (game.state === STATE.GAMEOVER) return;
    const [adx, ady] = game.aimVector();
    // The staff flares for a moment after a cast, so the wizard visibly *does*
    // something even when the spell leaves instantly (HEAL).
    const castFlash = game.lastCast ? Math.min(1, game.lastCast.t / 0.35) : 0;
    const hurt = p.hurt > 0;
    const healing = p.healing > 0;
    const poses = posesFor(this.assets, 'wizard');
    drawWizard(this.ctx, {
      x: p.x,
      y: p.y,
      radius: p.radius,
      time: game.time,
      aimAngle: Math.atan2(ady, adx),
      moveMag: Math.min(1, Math.hypot(game.moveX, game.moveY)),
      hurt,
      healing,
      invuln: p.invuln > 0,
      castFlash,
      sprite: poses.sprite,
      spritePoseA: poses.poseA,
      spritePoseB: poses.poseB,
      // Facing is the direction of travel, held while idle so letting go of the
      // stick does not spin the wizard round.
      motion: this.motionOf(p, { speed: PLAYER.speed, facingX: this.headingOf(p, p.vxNow || game.moveX) }),
      // The vector art's robe goes red when hurt and green when healing; these
      // are the same tells as a wash over the painted robe, cached on first use.
      spriteHurt: poses.sprite ? this.assets.variant('wizard', '#c8203f', 0.42) : null,
      spriteHeal: poses.sprite ? this.assets.variant('wizard', '#2fbf6a', 0.34) : null,
    });
  }

  drawTexts(game) {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of game.texts) {
      const a = Math.max(0, t.life / t.maxLife);
      ctx.globalAlpha = a;
      setFont(ctx, t.size, 800);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(t.text, t.x + 1.5, t.y + 1.5);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.restore();
  }

  // ── the element wheel ─────────────────────────────────────────────────────

  drawWheel(game, hud) {
    const ctx = this.ctx;
    const L = this.wheelLayout();
    const locked = game.seqLock > 0;
    const orbited = new Set(game.sequence);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Backing plate so the wheel reads over a busy arena. A white panel with a
    // cool rim, not a dark plate: the arena is bright now and a dark disc over
    // it looked like a hole punched in the art.
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = PALETTE.panel;
    ctx.beginPath();
    ctx.arc(L.cx, L.cy, L.ring + L.r + WHEEL.platePad, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = PALETTE.panelEdge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(L.cx, L.cy, L.ring + L.r + WHEEL.platePad, 0, Math.PI * 2);
    ctx.stroke();

    // Faint guide ring through the element centres.
    ctx.strokeStyle = 'rgba(140,200,255,0.10)';
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.arc(L.cx, L.cy, L.ring, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Which gesture the wheel is showing: the recipe the book is demonstrating,
    // or - much quieter - the taps already entered this cast, so a player
    // mid-sweep can see the shape they have drawn so far.
    const demo = game.state === STATE.SPELLBOOK ? game.spellBookSelected : null;
    const demoSeq = demo && demo !== 'focus' ? SPELL_BY_ID[demo]?.sequence ?? [] : [];

    for (const b of L.buttons) {
      const press = hud.presses?.get(b.id);
      const pressK = press ? press.ttl / press.max : 0;
      const isElement = b.kind === 'element';
      const armed = isElement && orbited.has(b.elementId);
      const reachableHere =
        !isElement ||
        game.reachable.some((sp) => {
          // Highlight elements that can actually extend the current taps.
          const nextIndex = game.sequence.length;
          return sp.sequence[nextIndex] === b.elementId;
        });

      // The centre serving a charge cooldown is the one "not now" the wheel has
      // to show: a full charge buys up to half a second of it, and a thumb that
      // gets no shot needs to see why rather than assume it mis-tapped.
      const focusCooling = !isElement && game.sparkCd > 0;
      const baseAlpha = locked || focusCooling ? 0.32 : reachableHere || !game.sequence.length ? 1 : 0.45;

      ctx.globalAlpha = baseAlpha;
      // Body
      ctx.fillStyle = press ? b.color : 'rgba(255,255,255,0.88)';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * (1 + pressK * 0.06), 0, Math.PI * 2);
      ctx.fill();

      // Glow ring, brighter when this element is a legal next tap.
      const ringAlpha = press ? 0.95 : armed ? 0.9 : reachableHere && game.sequence.length ? 0.62 : 0.3;
      ctx.globalAlpha = baseAlpha * ringAlpha;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = press ? 4 : armed ? 3.5 : 2.4;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.stroke();

      // Cast confirmation: every circle that made the spell lights up in the
      // order it was pressed. Duplicates are handled by taking the strongest
      // occurrence, which is what makes FIRE+FIRE+WIND read as three beats and
      // not two.
      this.castGlowFor(game, b);

      // Hold-to-repeat wind-up: the same idiom as the centre circle's charge,
      // drawn inside the circle's edge so the target never grows. A repeat the
      // player cannot see coming is a repeat they cannot use.
      if (hud.dwell && hud.dwell.id === b.id) {
        ctx.globalAlpha = baseAlpha * 0.9;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = Math.max(2, b.r * 0.15);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 0.74, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * hud.dwell.k);
        ctx.stroke();
        ctx.lineCap = 'butt';
      }

      // Icon
      ctx.globalAlpha = baseAlpha * (press ? 1 : 0.95);
      ctx.fillStyle = press ? '#ffffff' : b.color;
      drawElementGlyph(ctx, b.x, b.y - b.r * 0.14, b.r * WHEEL.iconScale, b.elementId);

      // Label
      ctx.globalAlpha = baseAlpha * 0.95;
      setFont(ctx, Math.max(8, b.r * 0.24), 700);
      ctx.fillStyle = press ? '#ffffff' : PALETTE.ink;
      ctx.fillText(b.elementId === 'focus' ? 'SPARK' : b.element.name, b.x, b.y + b.r * 0.58);

      // Cost, on the aimed spells only, so the wheel stays uncluttered. The
      // centre's price climbs with the wind-up and is printed live, so you can
      // watch it and decide whether this shot is worth the mana.
      if (!isElement) {
        const cost = chargedSparkCost(game.chargeT ?? 0);
        const affordable = game.player.mana >= cost;
        ctx.globalAlpha = baseAlpha * (affordable ? 0.6 : 0.3);
        setFont(ctx, Math.max(7, b.r * 0.2), 700);
        ctx.fillStyle = !affordable ? PALETTE.hp : game.chargeT >= 1 ? PALETTE.gold : PALETTE.mana;
        ctx.fillText(`${cost}`, b.x, b.y - b.r * 0.66);
      }
    }

    // The gesture goes ON TOP of the circles, for a reason that is easy to miss:
    // two of the five recipes move between OPPOSITE elements, so their path runs
    // straight through the centre circle. Drawn underneath, the middle of that
    // line was painted out by the SPARK circle and the sweep read as two
    // disconnected stubs. The band is opaque, the line is what is being taught.
    if (demo === 'focus') {
      this.drawFocusGesture('path');
      this.drawFocusGesture('steps');
    } else if (demo) {
      this.drawTrajectoryAnimated(game, demoSeq, SPELL_BY_ID[demo].color);
      this.drawTrajectory(demoSeq, { color: SPELL_BY_ID[demo].color, layer: 'steps', steps: true });
    } else if (hud.trail && hud.trailFade > 0) {
      // While the player is drawing, the wheel shows the line THEY drew. The
      // snapped circle-path would say the same thing less truthfully, and two
      // lines at once is one line too many.
    } else if (game.sequence.length && game.state === STATE.PLAYING) {
      this.drawTrajectory(game.sequence, { muted: true, color: PALETTE.ink, layer: 'path' });
    }

    // The wind-up, drawn INSIDE the centre circle's edge: the circle you can
    // press must stay exactly the circle you see, so the charge never grows the
    // target. The full-charge pulse is the one thing outside it, and it sits in
    // the gap between the centre and the elements.
    if (game.charging && game.chargeT > 0) {
      const focus = L.buttons.find((b) => b.id === 'focus');
      const t = game.chargeT;
      ctx.strokeStyle = FOCUS_SPELL.color;
      ctx.lineWidth = Math.max(2, focus.r * 0.16);
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(focus.x, focus.y, focus.r * 0.84, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
      ctx.stroke();
      ctx.lineCap = 'butt';

      if (t >= 1) {
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 130);
        ctx.globalAlpha = 0.3 + 0.5 * pulse;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(focus.x, focus.y, focus.r + 6 + pulse * 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Break flash: a red ring punching outward.
    if (game.breakFlash > 0) {
      const k = game.breakFlash / 0.35;
      ctx.globalAlpha = k * 0.8;
      ctx.strokeStyle = PALETTE.hp;
      ctx.lineWidth = 4 * k;
      ctx.beginPath();
      ctx.arc(L.cx, L.cy, L.ring + L.r * (1 + (1 - k) * 0.5), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The taps entered so far, as three slots above the wheel. */
  drawSequence(game, hud) {
    const ctx = this.ctx;
    const L = this.wheelLayout();
    const n = 3;
    const pipR = Math.max(11, L.r * 0.3);
    const gap = pipR * 0.85;
    const totalW = n * pipR * 2 + (n - 1) * gap;
    const x0 = L.cx - totalW / 2;
    const y = L.cy - L.ring - L.r - 26;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Idle fade: the recipe dissolves on its own, so show it running out.
    const idleFade = game.sequence.length ? clamp(game.seqIdle / 0.8, 0.25, 1) : 1;

    for (let i = 0; i < n; i++) {
      const cx = x0 + pipR + i * (pipR * 2 + gap);
      const filled = i < game.sequence.length;
      ctx.globalAlpha = filled ? idleFade : 0.22;
      ctx.fillStyle = filled ? ELEMENT_BY_ID[game.sequence[i]].color : 'transparent';
      ctx.beginPath();
      ctx.arc(cx, y, pipR, 0, Math.PI * 2);
      if (filled) ctx.fill();
      ctx.strokeStyle = filled ? '#ffffff' : 'rgba(140,200,255,0.5)';
      ctx.lineWidth = filled ? 2 : 1.5;
      ctx.stroke();
      if (filled) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        drawElementGlyph(ctx, cx, y, pipR * 1.1, game.sequence[i]);
      }
    }

    // Spell name: the last cast, or a nudge when one tap away.
    const li = Math.max(0, game.sequence.length - 1);
    const imminent = game.sequence.length ? game.reachable : [];
    ctx.globalAlpha = 1;
    setFont(ctx, Math.max(12, L.r * 0.3), 800);
    if (game.lastCast && game.lastCast.t > 0.4) {
      ctx.fillStyle = game.lastCast.color;
      ctx.fillText(game.lastCast.name, L.cx, y - pipR - 20);
    } else if (imminent.length && game.sequence.length > 0) {
      const names = imminent.map((sp) => sp.name).join(' / ');
      ctx.fillStyle = imminent.length === 1 ? imminent[0].color : PALETTE.dim;
      ctx.fillText(names, L.cx, y - pipR - 20);
    } else {
      ctx.fillStyle = PALETTE.faint;
      void li;
      ctx.fillText('TAP AN ELEMENT', L.cx, y - pipR - 20);
    }
    ctx.restore();
  }

  // ── the spell book: corner button, and the card it opens ──────────────────

  /**
   * The corner icon.
   *
   * Drawn as vector rather than shipped as an image, like every other UI glyph
   * in the game: it has to stay crisp from a 46px phone target to a 68px tablet
   * one, and a book is four rectangles and a spine.
   */
  drawSpellBookButton(game, hud) {
    const ctx = this.ctx;
    const b = this.spellBookLayout().button;
    const pulsing = hud?.hintT > 0;

    ctx.save();
    ctx.globalAlpha = 0.86;
    roundRect(ctx, b.x, b.y, b.w, b.h, b.r);
    ctx.fillStyle = PALETTE.panel;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = pulsing ? PALETTE.gold : PALETTE.panelEdge;
    ctx.lineWidth = pulsing ? 2 : 1;
    ctx.stroke();

    // An open book: two leaves, a spine, and a few ruled lines for text.
    const w = b.w * 0.62;
    const h = b.h * 0.5;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h * 0.46;
    const left = cx - w / 2;
    const top = cy - h / 2;

    ctx.fillStyle = PALETTE.dim;
    ctx.beginPath();
    ctx.moveTo(cx, top + h * 0.1);
    ctx.quadraticCurveTo(cx - w * 0.3, top - h * 0.06, left, top + h * 0.12);
    ctx.lineTo(left, top + h * 0.92);
    ctx.quadraticCurveTo(cx - w * 0.3, top + h * 0.74, cx, top + h * 0.9);
    ctx.quadraticCurveTo(cx + w * 0.3, top + h * 0.74, left + w, top + h * 0.92);
    ctx.lineTo(left + w, top + h * 0.12);
    ctx.quadraticCurveTo(cx + w * 0.3, top - h * 0.06, cx, top + h * 0.1);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = PALETTE.panel;
    ctx.lineWidth = Math.max(1, b.w * 0.03);
    ctx.beginPath();
    ctx.moveTo(cx, top + h * 0.1);
    ctx.lineTo(cx, top + h * 0.9);
    ctx.stroke();

    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = PALETTE.panel;
    ctx.lineWidth = Math.max(1, b.w * 0.022);
    for (let i = 0; i < 3; i++) {
      const ly = top + h * (0.34 + i * 0.17);
      ctx.beginPath();
      ctx.moveTo(left + w * 0.12, ly);
      ctx.lineTo(cx - w * 0.1, ly);
      ctx.moveTo(cx + w * 0.1, ly);
      ctx.lineTo(left + w * 0.88, ly);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The open book: a scrim over a frozen world, a card of recipes on the left,
   * and - the point of the whole screen - the selected gesture drawn on the
   * wheel, which stays live and unobstructed on the right.
   */
  drawSpellBook(game, hud) {
    const ctx = this.ctx;
    const L = this.spellBookLayout();
    const { w, h } = this;

    // Semi-transparent on purpose: the arena stays readable behind it, so the
    // book feels like a pause rather than a different application.
    ctx.save();
    ctx.fillStyle = 'rgba(38,27,16,0.52)';
    ctx.fillRect(0, 0, w, h);

    roundRect(ctx, L.card.x, L.card.y, L.card.w, L.card.h, 14);
    ctx.fillStyle = PALETTE.panel;
    ctx.globalAlpha = 0.94;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = PALETTE.panelEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    setFont(ctx, Math.max(13, L.headerH * 0.4), 800);
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText('SPELL BOOK', L.card.x + 14, L.card.y + L.headerH * 0.52);

    setFont(ctx, Math.max(9, L.headerH * 0.26), 700);
    ctx.fillStyle = PALETTE.faint;
    ctx.fillText('TAP A SPELL TO SEE THE GESTURE', L.card.x + 14, L.card.y + L.headerH * 0.85);

    // Close: an explicit target, because the card is inert everywhere else so a
    // mis-tap while reading cannot dismiss it.
    const c = L.close;
    ctx.strokeStyle = PALETTE.dim;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.x + c.w * 0.25, c.y + c.h * 0.25);
    ctx.lineTo(c.x + c.w * 0.75, c.y + c.h * 0.75);
    ctx.moveTo(c.x + c.w * 0.75, c.y + c.h * 0.25);
    ctx.lineTo(c.x + c.w * 0.25, c.y + c.h * 0.75);
    ctx.stroke();

    for (const row of L.list) {
      const selected = game.spellBookSelected === row.id;
      const spell = row.spell;

      if (selected) {
        roundRect(ctx, row.x - 4, row.y + 2, row.w + 8, row.h - 4, 8);
        ctx.fillStyle = spell.color;
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = spell.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      const pipR = Math.min(row.h * 0.19, 9);
      if (row.kind === 'focus') {
        // SPARK has no sequence: it is one circle, held. Draw the glyph the
        // wheel uses for it rather than inventing a pip to stand for it.
        ctx.fillStyle = spell.color;
        ctx.beginPath();
        ctx.arc(row.x + pipR + 2, row.cy, pipR * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        drawElementGlyph(ctx, row.x + pipR + 2, row.cy, pipR * 1.5, 'focus');
      } else {
        drawPips(ctx, spell.sequence, row.x, row.cy, pipR, pipR * 0.55, { alpha: 1 });
      }

      const textX = row.x + (row.kind === 'focus' ? pipR * 3.4 + 10 : spell.sequence.length * (pipR * 2 + pipR * 0.55) + 10);
      setFont(ctx, Math.max(11, row.h * 0.3), selected ? 800 : 700);
      ctx.fillStyle = PALETTE.ink;
      ctx.fillText(spell.name, textX, row.cy - row.h * 0.13);

      setFont(ctx, Math.max(8, row.h * 0.22), 700);
      ctx.fillStyle = PALETTE.faint;
      const how = row.kind === 'focus'
        ? 'TAP FOR A DART \u00B7 HOLD TO CHARGE'
        : describeGesture(spell.sequence);
      ctx.fillText(how, textX, row.cy + row.h * 0.19);

      // Cost, right-aligned, so the eye can compare the column. In ink, not in
      // the spell's colour: SPARK's is a pale cream that vanishes on parchment,
      // and the same rule the recipe chart already follows applies - the pips
      // carry the colour, the text has to be legible first.
      setFont(ctx, Math.max(9, row.h * 0.24), 800);
      ctx.textAlign = 'right';
      ctx.fillStyle = PALETTE.dim;
      ctx.fillText(`${spell.cost}`, row.x + row.w - 4, row.cy);
      ctx.textAlign = 'left';
    }

    setFont(ctx, Math.max(9, L.headerH * 0.24), 700);
    ctx.fillStyle = PALETTE.dim;
    ctx.textAlign = 'center';
    ctx.fillText('DRAG THROUGH THE CIRCLES \u00B7 HOLD ONE TO REPEAT IT', L.card.x + L.card.w / 2, L.footerY);
    ctx.restore();
    void hud;
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  /**
   * The recipe chart. It lists all five spells and dims the ones that are no
   * longer reachable from the taps so far, so the player can learn the wheel by
   * watching the list narrow instead of memorising a table. This is the single
   * most important teaching aid in the game.
   */
  drawRecipeChart(game, hud, opts = {}) {
    const ctx = this.ctx;
    const reachable = opts.reachable ?? game.reachable;
    const active = opts.activeSequence ?? game.sequence;
    const rowH = opts.rowH ?? Math.max(15, Math.min(19, this.h * 0.042));
    const pipR = opts.pipR ?? rowH * 0.28;
    const nameSize = opts.nameSize ?? Math.max(9, rowH * 0.6);
    const x = opts.x ?? UI.layout.pad;
    // The chart stacks above the spell book button rather than sharing the
    // corner with it: the button is a 50px target that a thumb has to find, and
    // the chart is five rows of small type, so they cannot occupy the same pixels.
    const bookTop = this.spellBookLayout().button.y;
    const top = opts.y ?? bookTop - UI.spellBook.gap - SPELLS.length * rowH;
    const dimUnreachable = opts.dimUnreachable ?? true;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // A panel behind it. The chart is the single most important teaching aid in
    // the game, and pastel spell names over pale painted stone are not readable.
    if (opts.panel !== false) {
      const rowW = rowH * 11;
      roundRect(ctx, x - 8, top - rowH * 1.15, rowW, SPELLS.length * rowH + rowH * 1.5, 8);
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = PALETTE.panel;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = PALETTE.panelEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    setFont(ctx, nameSize, 700);
    ctx.globalAlpha = opts.titleAlpha ?? 0.85;
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText('TAP IN ORDER', x, top - rowH * 0.75);
    ctx.globalAlpha = 1;

    SPELLS.forEach((spell, i) => {
      const y = top + i * rowH + rowH / 2;
      const live = !dimUnreachable || reachable.includes(spell);
      const won = reachable.length === 1 && reachable[0] === spell && active.length > 0;

      ctx.globalAlpha = live ? 1 : 0.3;
      drawPips(ctx, spell.sequence, x, y, pipR, pipR * 0.5, { alpha: live ? 1 : 0.5 });

      const textX = x + spell.sequence.length * (pipR * 2 + pipR * 0.5) + 10;
      ctx.globalAlpha = live ? 1 : 0.28;
      setFont(ctx, nameSize, won ? 800 : 700);
      // Names in ink, pips in colour: the colour channel is already carried by
      // the pips beside them, and the text has to be legible first.
      ctx.fillStyle = live ? PALETTE.ink : PALETTE.faint;
      ctx.fillText(spell.name, textX, y);

      if (won) {
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = spell.color;
        ctx.fillText('\u25C0', textX + ctx.measureText(spell.name).width + 6, y);
      }
      ctx.globalAlpha = 1;
    });
    ctx.restore();
    void hud;
  }

  drawHud(game, hud) {
    const ctx = this.ctx;
    const { pad, barW, barH } = UI.layout;
    const p = game.player;

    ctx.save();
    ctx.textBaseline = 'middle';

    const hpFrac = Math.max(0, p.hp / p.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, pad, pad, barW, barH, barH / 2);
    ctx.fill();
    ctx.fillStyle = PALETTE.hp;
    if (hpFrac > 0) {
      roundRect(ctx, pad + 2, pad + 2, Math.max(2, (barW - 4) * hpFrac), barH - 4, (barH - 4) / 2);
      ctx.fill();
    }
    setFont(ctx, 10, 700);
    ctx.fillStyle = PALETTE.ink;
    ctx.textAlign = 'left';
    ctx.fillText('VITAE', pad + 10, pad + barH / 2 + 0.5);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.ceil(p.hp)}`, pad + barW - 10, pad + barH / 2 + 0.5);

    const my = pad + barH + 7;
    const manaFrac = Math.max(0, p.mana / p.maxMana);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, pad, my, barW, barH, barH / 2);
    ctx.fill();
    ctx.fillStyle = PALETTE.mana;
    if (manaFrac > 0) {
      roundRect(ctx, pad + 2, my + 2, Math.max(2, (barW - 4) * manaFrac), barH - 4, (barH - 4) / 2);
      ctx.fill();
    }
    ctx.fillStyle = '#06131c';
    setFont(ctx, 10, 700);
    ctx.textAlign = 'left';
    ctx.fillText('MANA', pad + 10, my + barH / 2 + 0.5);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.floor(p.mana)}`, pad + barW - 10, my + barH / 2 + 0.5);

    const cx = this.w / 2;
    setFont(ctx, 13, 700);
    ctx.fillStyle = PALETTE.dim;
    ctx.textAlign = 'center';
    ctx.fillText(`WAVE ${game.wave}`, cx, pad + 10);

    const t = Math.max(0, game.waveTimer);
    const low = t < 10;
    const overtime = game.overtimeCount > 0;
    setFont(ctx, 34, 800);
    ctx.fillStyle = overtime ? PALETTE.hp : low ? PALETTE.gold : PALETTE.ink;
    const beat = low && !overtime ? 1 + 0.05 * Math.sin(game.time * 9) : 1;
    ctx.save();
    ctx.translate(cx, pad + 40);
    ctx.scale(beat, beat);
    ctx.fillText(t.toFixed(1), 0, 0);
    ctx.restore();

    setFont(ctx, 11, 700);
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText(`${game.enemiesRemaining} HOSTILE${game.enemiesRemaining === 1 ? '' : 'S'}`, cx, pad + 66);
    if (overtime) {
      ctx.fillStyle = PALETTE.hp;
      ctx.fillText(`OVERTIME x${game.overtimeCount}`, cx, pad + 82);
    }

    ctx.textAlign = 'right';
    setFont(ctx, 20, 800);
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText(String(game.score), this.w - pad, pad + 12);
    setFont(ctx, 10, 700);
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText(`BEST ${hud.best ?? 0}`, this.w - pad, pad + 32);

    // Status flags, stacked so they never overlap.
    const status = [];
    if (hud.muted) status.push('MUTED  [M]');
    if (hud.haptics) {
      // "NO HAPTICS" is worth saying: iOS Safari has no Vibration API at all, and
      // a player tapping fruitlessly deserves to know it is the platform, not them.
      if (!hud.haptics.supported) status.push('NO HAPTICS HERE');
      else if (!hud.haptics.enabled) status.push('HAPTICS OFF  [V]');
    }
    status.forEach((label, i) => {
      ctx.fillStyle = PALETTE.faint;
      ctx.fillText(label, this.w - pad, pad + 48 + i * 15);
    });

    if (hud.hintT > 0) {
      ctx.globalAlpha = Math.min(1, hud.hintT);
      ctx.textAlign = 'left';
      setFont(ctx, 11, 700);
      ctx.fillStyle = PALETTE.dim;
      // Beside the spell book icon rather than under it: the corner now belongs
      // to a 50px target, and small type underneath would be the first casualty.
      const book = this.spellBookLayout().button;
      const hx = book.x + book.w + 10;
      ctx.fillText('LEFT: DRAG TO MOVE', hx, this.h - pad - 34);
      ctx.fillText('RIGHT: TAP ELEMENTS IN ORDER', hx, this.h - pad - 18);
      ctx.globalAlpha = 1;
    }

    if (game.intermission > 0 && game.enemiesRemaining === 0) {
      const secs = Math.ceil(game.intermission);
      ctx.textAlign = 'center';
      setFont(ctx, 15, 700);
      ctx.fillStyle = PALETTE.dim;
      ctx.fillText(`NEXT WAVE IN ${secs}`, cx, this.h - pad - 22);
    }
    ctx.restore();
  }

  /**
   * The floating movement stick. It has no fixed home: it appears under the
   * thumb wherever you first press.
   *
   * The dead-zone ring is drawn on purpose. Once movement is analog, "how do I
   * stand still?" becomes a real question, and the answer should be visible
   * rather than discovered by trial and error.
   */
  drawStick(stick) {
    if (!stick || !stick.active) return;
    const ctx = this.ctx;
    const TAU = Math.PI * 2;
    const dx = stick.x - stick.ox;
    const dy = stick.y - stick.oy;
    // Explicit sqrt rather than Math.hypot, the same convention as the simulation
    // path: the Godot port shares this primitive and hypot's extra precision is not
    // reproducible across the two runtimes.
    const d = Math.sqrt(dx * dx + dy * dy);
    const k = d > stick.radius ? stick.radius / d : 1;
    const mag = stick.magnitude ?? 0;
    const moving = mag > 0.01;
    const deadZone = stick.deadZone ?? stick.radius * 0.18;
    const knobX = stick.ox + dx * k;
    const knobY = stick.oy + dy * k;

    ctx.save();

    // Base disc, brighter while you are actually moving.
    ctx.globalAlpha = moving ? 0.1 : 0.05;
    ctx.fillStyle = '#e8c07a';
    ctx.beginPath();
    ctx.arc(stick.ox, stick.oy, stick.radius, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = moving ? 0.34 : 0.18;
    ctx.strokeStyle = '#e8c07a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(stick.ox, stick.oy, stick.radius, 0, TAU);
    ctx.stroke();

    // Dead zone: rest anywhere inside this and the mage holds position.
    if (deadZone > 2) {
      ctx.globalAlpha = 0.26;
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(stick.ox, stick.oy, deadZone, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Arm, so the direction you are pushing is unmistakable.
    if (moving) {
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(stick.ox, stick.oy);
      ctx.lineTo(knobX, knobY);
      ctx.stroke();
    }

    // Knob: grey at rest, cyan under tilt, and it grows with deflection.
    ctx.globalAlpha = moving ? 0.9 : 0.5;
    ctx.fillStyle = moving ? '#2f8fd8' : '#7f93b0';
    ctx.beginPath();
    ctx.arc(knobX, knobY, Math.max(12, stick.radius * 0.26) * (0.85 + 0.3 * mag), 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  /** Shown when the device is held in portrait. */
  drawRotateHint() {
    const ctx = this.ctx;
    const cx = this.w / 2;
    const cy = this.h / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.save();
    ctx.translate(cx, cy - 60);
    ctx.rotate((Math.sin(performance.now() / 600) * 0.5 + 0.5) * (Math.PI / 2));
    ctx.strokeStyle = '#e8c07a';
    ctx.lineWidth = 3;
    roundRect(ctx, -22, -38, 44, 76, 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-8, 28);
    ctx.lineTo(8, 28);
    ctx.stroke();
    ctx.restore();

    setFont(ctx, 18, 800);
    ctx.fillStyle = '#2f5da8';
    ctx.fillText('ROTATE YOUR DEVICE', cx, cy + 30);
    setFont(ctx, 12, 700);
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText('RUNE PRESSURE IS PLAYED IN LANDSCAPE', cx, cy + 54);
    ctx.fillText('one thumb moves, one thumb taps', cx, cy + 74);
    ctx.restore();
  }

  drawFlash(game) {
    if (game.flashT <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(0.4, game.flashT * 1.6);
    ctx.fillStyle = game.flashColor;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.restore();
  }

  drawBanner(game) {
    const b = game.banner;
    if (!b) return;
    const ctx = this.ctx;
    const k = b.max > 0 ? b.t / b.max : 0;
    const appear = Math.min(1, (1 - k) * 6);
    const fade = Math.min(1, k * 3.2);
    ctx.save();
    ctx.globalAlpha = Math.min(appear, fade);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    setFont(ctx, b.small ? 16 : 34, 800);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(b.text, this.w / 2 + 2, this.h * 0.28 + 2);
    ctx.fillStyle = b.color;
    ctx.fillText(b.text, this.w / 2, this.h * 0.28);
    if (b.sub) {
      setFont(ctx, 13, 700);
      ctx.fillStyle = PALETTE.ink;
      ctx.fillText(b.sub, this.w / 2, this.h * 0.28 + 26);
    }
    ctx.restore();
  }

  // ── full-screen states ────────────────────────────────────────────────────

  /**
   * The boot screen: full-bleed key art, the logo, and a prompt.
   *
   * Deliberately gradient-free. The scrims that seat the text are BAKED into
   * the shipped file by tools/prepare-splash.py, so a screen that is up for a
   * couple of seconds does not quietly break the rule the browser suite holds
   * the frame loop to.
   *
   * It doubles as the loading screen: the key art is one of the larger
   * downloads, and the prompt is live from the first frame either way, so the
   * game never gates on the network.
   */
  drawSplash(game, hud) {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const art = this.assets?.get('splash');

    ctx.save();
    if (art && art.width) {
      // Cover-fit. The art is authored 16:9, so on a 16:9 screen this is exact
      // and on anything else it fills without letterboxing.
      const s = Math.max(w / art.width, h / art.height);
      const dw = art.width * s;
      const dh = art.height * s;
      ctx.drawImage(art, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else {
      // Flat, not a gradient: this path also runs in tests with no image loader.
      ctx.fillStyle = '#bfe6ff';
      ctx.fillRect(0, 0, w, h);
    }

    const cx = w / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    // The logo. A heavy dark outline, so it reads over sky, cloud, hood and
    // crystal alike without needing a panel behind it.
    const tSize = Math.min(56, w * 0.086);
    const tY = Math.max(44, h * 0.105);
    setFont(ctx, tSize, 800);
    ctx.lineWidth = Math.max(7, tSize * 0.2);
    ctx.strokeStyle = '#123a6b';
    ctx.strokeText('RUNE PRESSURE', cx, tY);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('RUNE PRESSURE', cx, tY);

    // A gold rule under the logo, in the same register as the HUD chrome.
    const ruleW = Math.min(w * 0.32, tSize * 6);
    const ruleY = tY + tSize * 0.8;
    ctx.lineWidth = Math.max(3, tSize * 0.1);
    ctx.strokeStyle = '#123a6b';
    ctx.beginPath();
    ctx.moveTo(cx - ruleW / 2, ruleY);
    ctx.lineTo(cx + ruleW / 2, ruleY);
    ctx.stroke();
    ctx.lineWidth = Math.max(1.5, tSize * 0.05);
    ctx.strokeStyle = '#ffd25e';
    ctx.beginPath();
    ctx.moveTo(cx - ruleW / 2, ruleY);
    ctx.lineTo(cx + ruleW / 2, ruleY);
    ctx.stroke();

    setFont(ctx, Math.max(10, Math.min(14, w * 0.0145)), 700);
    ctx.lineWidth = Math.max(3, w * 0.005);
    ctx.strokeStyle = 'rgba(18,58,107,0.8)';
    ctx.strokeText('TAP THE ELEMENTS. SURVIVE THE WAVE.', cx, ruleY + tSize * 0.46);
    ctx.fillStyle = '#eaf6ff';
    ctx.fillText('TAP THE ELEMENTS. SURVIVE THE WAVE.', cx, ruleY + tSize * 0.46);

    // The prompt, on a panel.
    //
    // An outline alone was not enough: the prompt lands on the hero's robe,
    // which is the brightest thing in the art, and white-on-white stays
    // white-on-white however thick the stroke. A translucent plate makes it
    // legible over any part of the art rather than over the one spot it was
    // eyeballed against.
    const pSize = Math.min(26, w * 0.036);
    const subSize = Math.max(10, Math.min(13, w * 0.012));
    const pText = 'TAP TO BEGIN';
    const subText = art ? 'the circle is drawn' : 'loading the circle...';
    setFont(ctx, pSize, 800);
    const pW = ctx.measureText(pText).width;
    setFont(ctx, subSize, 700);
    const sW = ctx.measureText(subText).width;
    const panelW = Math.max(pW, sW) + pSize * 3.4;
    const panelH = pSize + subSize + (hud.best ? subSize : 0) + pSize * 1.7;
    const panelY = h - Math.max(70, h * 0.175) - panelH / 2;
    const r = panelH * 0.34;

    ctx.globalAlpha = 0.54;
    ctx.fillStyle = '#0d2242';
    roundRect(ctx, cx - panelW / 2, panelY, panelW, panelH, r);
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffd25e';
    roundRect(ctx, cx - panelW / 2, panelY, panelW, panelH, r);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const pulse = 0.78 + 0.22 * Math.sin(performance.now() / 340);
    const pY = panelY + pSize * 0.9;
    ctx.globalAlpha = pulse;
    setFont(ctx, pSize, 800);
    ctx.lineWidth = Math.max(3, pSize * 0.13);
    ctx.strokeStyle = '#0b1e3a';
    ctx.strokeText(pText, cx, pY);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(pText, cx, pY);
    ctx.globalAlpha = 1;

    // Honest about the one thing that may still be arriving.
    setFont(ctx, subSize, 700);
    const subY = pY + pSize * 0.82 + subSize * 0.3;
    ctx.fillStyle = 'rgba(233,244,255,0.9)';
    ctx.fillText(subText, cx, subY);
    if (hud.best) {
      ctx.fillStyle = '#ffd25e';
      ctx.fillText(`BEST ${hud.best}`, cx, subY + subSize * 1.35);
    }
    ctx.restore();
  }

  drawTitle(game, hud) {
    const ctx = this.ctx;
    const cx = this.w / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(232,245,255,0.9)';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const top = Math.max(38, this.h * 0.1);
    setFont(ctx, Math.min(42, this.w * 0.068), 800);
    ctx.fillStyle = '#2f5da8';
    ctx.fillText('RUNE PRESSURE', cx, top);
    setFont(ctx, 11, 700);
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText('TAP THE ELEMENTS. SURVIVE THE WAVE.', cx, top + 24);

    const wide = this.w > 760;
    const rowH = Math.max(17, Math.min(23, this.h * 0.05));

    // Left: how to play. Right: the recipe table.
    const leftX = wide ? cx - this.w * 0.3 : cx;
    const rightX = wide ? cx + this.w * 0.1 : cx;
    const labelY = top + 64;

    ctx.textAlign = 'left';
    setFont(ctx, 11, 700);
    ctx.fillStyle = PALETTE.faint;
    ctx.fillText('LEFT THUMB', leftX, labelY);
    setFont(ctx, 13, 700);
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText('drag anywhere to move', leftX, labelY + 20);

    setFont(ctx, 11, 700);
    ctx.fillStyle = PALETTE.faint;
    ctx.fillText('RIGHT THUMB', leftX, labelY + 50);
    setFont(ctx, 13, 700);
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText('tap the centre for a weak shot', leftX, labelY + 70);
    ctx.fillText('hold it to charge a heavy one', leftX, labelY + 90);
    ctx.fillText('tap elements in order to cast', leftX, labelY + 110);

    setFont(ctx, 11, 700);
    ctx.fillStyle = PALETTE.gold;
    ctx.fillText('THE RULE', leftX, labelY + 140);
    setFont(ctx, 12, 700);
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText('two of a kind -> aimed spell', leftX, labelY + 160);
    ctx.fillText('three different -> erupts around you', leftX, labelY + 178);

    // The spell table, on its own axis.
    ctx.textAlign = 'left';
    const tableTop = labelY + 4;
    this.drawRecipeChart(game, hud, {
      x: rightX,
      y: tableTop,
      rowH,
      pipR: rowH * 0.3,
      nameSize: Math.max(10, rowH * 0.62),
      dimUnreachable: false,
      titleAlpha: 0.8,
    });

    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 320);
    ctx.globalAlpha = pulse;
    ctx.textAlign = 'center';
    setFont(ctx, 20, 800);
    ctx.fillStyle = '#2f5da8';
    ctx.fillText('TAP TO BEGIN', cx, this.h - Math.max(30, this.h * 0.08));
    ctx.globalAlpha = 1;
    if (hud.best) {
      setFont(ctx, 11, 700);
      ctx.fillStyle = PALETTE.dim;
      ctx.fillText(`BEST ${hud.best}`, cx, this.h - Math.max(12, this.h * 0.032));
    }
    ctx.restore();
  }

  drawGameOver(game, hud) {
    const ctx = this.ctx;
    const cx = this.w / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(255,240,244,0.9)';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const top = Math.max(52, this.h * 0.16);
    setFont(ctx, Math.min(38, this.w * 0.062), 800);
    ctx.fillStyle = PALETTE.hp;
    ctx.fillText('THE CIRCLE BREAKS', cx, top);

    setFont(ctx, 40, 800);
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText(String(game.score), cx, top + 50);
    setFont(ctx, 11, 700);
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText('SCORE', cx, top + 74);

    const rows = [
      ['WAVE REACHED', String(game.wave)],
      ['KILLS', String(game.stats.kills)],
      ['SPELLS CAST', String(game.stats.casts)],
      ['SPARKS FIRED', String(game.stats.sparks)],
      ['SEQUENCES BROKEN', String(game.stats.breaks)],
      ['HEALS', String(game.stats.heals)],
    ];
    const perCol = 3;
    const colX = this.w > 620 ? [cx - 150, cx + 150] : [cx, cx];
    setFont(ctx, 12, 700);
    rows.forEach((row, i) => {
      const col = this.w > 620 ? Math.floor(i / perCol) : 0;
      const rowIdx = this.w > 620 ? i % perCol : i;
      const x = colX[col];
      const y = top + 102 + rowIdx * 19;
      ctx.textAlign = 'left';
      ctx.fillStyle = PALETTE.dim;
      ctx.fillText(row[0], x - 92, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = PALETTE.ink;
      ctx.fillText(row[1], x + 92, y);
    });

    if (game.stats.breaks >= 6) {
      ctx.textAlign = 'center';
      setFont(ctx, 12, 700);
      ctx.fillStyle = PALETTE.gold;
      ctx.fillText('TOO MANY BROKEN SEQUENCES - LEARN THE RECIPES', cx, top + 102 + perCol * 19 + 6);
    }

    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 320);
    ctx.globalAlpha = pulse;
    setFont(ctx, 20, 800);
    ctx.fillStyle = '#2f5da8';
    ctx.fillText('TAP TO TRY AGAIN', cx, this.h - Math.max(30, this.h * 0.08));
    ctx.globalAlpha = 1;
    setFont(ctx, 11, 700);
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText(`BEST ${hud.best ?? 0}`, cx, this.h - Math.max(12, this.h * 0.032));
    ctx.restore();
  }
}

export { PALETTE, setFont, roundRect, drawElementGlyph };
