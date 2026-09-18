/**
 * RUNE PRESSURE - canvas renderer.
 *
 * The only module that touches a 2D context. Everything it needs comes in as
 * plain data (the Game instance plus a small HUD bundle), so it can never
 * mutate game state by accident.
 *
 * It also owns the wheel's screen-space geometry, because that is layout, not
 * gameplay. `Input` hit-tests against `hitWheel()`, so the circles you see are
 * exactly the circles you can press - one source of truth.
 *
 * Performance notes for phones:
 *   - no ctx.shadowBlur (brutally slow on mobile GPUs); glow is faked with two
 *     or three stroked passes at decreasing alpha
 *   - the background gradient is built once per resize, never per frame
 *   - particles are plain circles, capped upstream in the simulation
 */

import { FX, UI, WHEEL, WORLD } from './config.js';
import { ELEMENTS, ELEMENT_BY_ID, FOCUS_SPELL, SPELLS } from './spells.js';
import { STATE } from './game.js';

const PALETTE = {
  bgTop: '#0a0c18',
  bgBottom: '#05060c',
  grid: 'rgba(122,182,255,0.055)',
  border: 'rgba(140,200,255,0.20)',
  ink: '#dceaff',
  dim: '#5d7591',
  faint: '#33455c',
  hp: '#ff4d6d',
  mana: '#6fd8ff',
  gold: '#ffe066',
};

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
  ctx.fill();
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
  constructor(canvas) {
    this.canvas = canvas;
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
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    this.vignette = v;
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
    const cx = this.w * WHEEL.centerXFrac;
    const cy = this.h * WHEEL.centerYFrac;
    const r = ring * WHEEL.elementRadiusFrac;
    const focusR = ring * WHEEL.focusRadiusFrac;

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

    const { s, ox, oy } = this.viewport();
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(s, s);
    this.drawArena(game, hud);
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
      this.drawSequence(game, hud);
      this.drawHud(game, hud);
      this.drawRecipeChart(game, hud);
    }
    this.drawBanner(game);
    if (game.state === STATE.TITLE) this.drawTitle(game, hud);
    if (game.state === STATE.GAMEOVER) this.drawGameOver(game, hud);
    ctx.fillStyle = this.vignette;
    ctx.fillRect(0, 0, w, h);
  }

  // ── world layers ──────────────────────────────────────────────────────────

  drawArena(game, hud) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = '#080a14';
    ctx.fillRect(0, 0, WORLD.w, WORLD.h);

    const zoneX = WORLD.w * UI.castZoneX;
    ctx.fillStyle = 'rgba(90,150,255,0.035)';
    ctx.fillRect(zoneX, 0, WORLD.w - zoneX, WORLD.h);

    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 40; x < WORLD.w; x += 40) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WORLD.h);
    }
    for (let y = 40; y < WORLD.h; y += 40) {
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD.w, y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(140,200,255,0.16)';
    ctx.setLineDash([9, 11]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(zoneX, 12);
    ctx.lineTo(zoneX, WORLD.h - 12);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = PALETTE.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, WORLD.w - 2, WORLD.h - 2);

    if (hud && hud.hintT > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.55, hud.hintT * 0.3);
      setFont(ctx, 14, 700);
      ctx.fillStyle = '#8fe3ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('DRAG HERE TO MOVE', zoneX / 2, 24);
      ctx.fillText('TAP THE ELEMENTS', zoneX + (WORLD.w - zoneX) / 2, 24);
      ctx.restore();
    }
    ctx.restore();
  }

  drawRings(game, over) {
    const ctx = this.ctx;
    for (const r of game.rings) {
      const isBlast = r.kind === 'nova';
      if (over !== isBlast) continue;
      const life = Math.max(0, r.ttl / r.maxTtl);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = 0.2 * life;
      ctx.lineWidth = isBlast ? 30 : 18;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.88 * life;
      ctx.lineWidth = isBlast ? 4 : 3;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawParticles(game) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of game.particles) {
      const a = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = a * 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Short cosmetic arcs from the caster to the muzzle. */
  drawLinks(game) {
    const ctx = this.ctx;
    if (!game.linkBolts.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const l of game.linkBolts) {
      const a = Math.max(0, l.ttl / l.max);
      ctx.globalAlpha = a * 0.5;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
    ctx.restore();
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
      ctx.globalAlpha = e.spawnT > 0 ? Math.max(0.15, 1 - e.spawnT / 0.45) : 1;
      ctx.translate(e.x, e.y);
      const flash = e.hitFlash > 0;
      const fill = flash ? '#ffffff' : e.color;

      if (e.type === 'shade') {
        const a = Math.atan2(game.player.y - e.y, game.player.x - e.x);
        ctx.rotate(a);
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(e.radius * 1.25, 0);
        ctx.lineTo(-e.radius * 0.7, -e.radius * 0.95);
        ctx.lineTo(-e.radius * 0.25, 0);
        ctx.lineTo(-e.radius * 0.7, e.radius * 0.95);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#0a0a12';
        ctx.beginPath();
        ctx.arc(0, 0, e.radius * 0.36, 0, Math.PI * 2);
        ctx.fill();
      } else if (e.type === 'wisp') {
        ctx.fillStyle = fill;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + e.bob * 0.25;
          const x = Math.cos(a) * e.radius;
          const y = Math.sin(a) * e.radius;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#0a0a12';
        ctx.beginPath();
        ctx.arc(0, 0, e.radius * 0.42, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(Math.cos(e.bob) * e.radius * 0.5, Math.sin(e.bob) * e.radius * 0.5, e.radius * 0.3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const half = e.radius * 0.88;
        ctx.fillStyle = fill;
        roundRect(ctx, -half, -half, half * 2, half * 2, e.radius * 0.28);
        ctx.fill();
        ctx.fillStyle = '#0a0a12';
        roundRect(ctx, -half * 0.5, -half * 0.5, half, half, e.radius * 0.18);
        ctx.fill();
      }

      // Chilled or drenched enemies get a visible shell.
      if (e.slowT > 0) {
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = '#8fe3ff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(0, 0, e.radius + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      if (e.hp < e.maxHp - 0.01 && e.spawnT <= 0) {
        const w = e.radius * 2.2;
        const frac = Math.max(0, e.hp / e.maxHp);
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(e.x - w / 2, e.y - e.radius - 12, w, 3.5);
        ctx.fillStyle = e.color;
        ctx.fillRect(e.x - w / 2, e.y - e.radius - 12, w * frac, 3.5);
        ctx.restore();
      }
    }
  }

  drawProjectiles(game) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const b of game.bolts) {
      const len = b.radius * 2.6;
      const a = Math.atan2(b.vy, b.vx);
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(a);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = b.color;
      roundRect(ctx, -len, -b.radius * 1.5, len * 2, b.radius * 3, b.radius * 1.4);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (b.fat) {
        ctx.beginPath();
        ctx.arc(0, 0, b.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.beginPath();
        ctx.arc(-b.radius * 0.25, -b.radius * 0.25, b.radius * 0.42, 0, Math.PI * 2);
        ctx.fill();
      } else {
        roundRect(ctx, -len * 0.6, -b.radius * 0.62, len * 1.3, b.radius * 1.24, b.radius * 0.6);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(len * 0.35, 0, b.radius * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    for (const b of game.ebolts) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(0, 0, b.radius * 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(0, 0, b.radius * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  drawPlayer(game) {
    const ctx = this.ctx;
    const p = game.player;
    if (game.state === STATE.GAMEOVER) return;
    ctx.save();
    ctx.translate(p.x, p.y);

    if (p.invuln > 0) {
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(game.time * 40);
      ctx.strokeStyle = '#c39bff';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.arc(0, 0, p.radius + 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    const hurt = p.hurt > 0;
    const healing = p.healing > 0;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = hurt ? 0.4 : healing ? 0.34 : 0.16;
    ctx.fillStyle = hurt ? PALETTE.hp : healing ? '#7bd88f' : '#8fe3ff';
    ctx.beginPath();
    ctx.arc(0, 0, p.radius * 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    ctx.fillStyle = hurt ? PALETTE.hp : '#0d1b2a';
    ctx.beginPath();
    ctx.arc(0, 0, p.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hurt ? '#ffffff' : healing ? '#7bd88f' : '#8fe3ff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Facing wedge - drawn along the ACTUAL aim vector, so it shows where an
    // aimed spell will go (at the nearest enemy), not merely which way you walk.
    const [adx, ady] = game.aimVector();
    const a = Math.atan2(ady, adx);
    ctx.save();
    ctx.rotate(a);
    ctx.fillStyle = hurt ? '#ffffff' : '#8fe3ff';
    ctx.beginPath();
    ctx.moveTo(p.radius + 9, 0);
    ctx.lineTo(p.radius + 1, -6);
    ctx.lineTo(p.radius + 1, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();
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

    // Backing plate so the wheel reads over a busy arena.
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = '#05070f';
    ctx.beginPath();
    ctx.arc(L.cx, L.cy, L.ring + L.r + 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(140,200,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(L.cx, L.cy, L.ring + L.r + 14, 0, Math.PI * 2);
    ctx.stroke();

    // Faint guide ring through the element centres.
    ctx.strokeStyle = 'rgba(140,200,255,0.10)';
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.arc(L.cx, L.cy, L.ring, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

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

      const baseAlpha = locked ? 0.32 : reachableHere || !game.sequence.length ? 1 : 0.45;

      ctx.globalAlpha = baseAlpha;
      // Body
      ctx.fillStyle = press ? b.color : 'rgba(8,12,22,0.86)';
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

      // Icon
      ctx.globalAlpha = baseAlpha * (press ? 1 : 0.95);
      ctx.fillStyle = press ? '#0a0c16' : b.color;
      drawElementGlyph(ctx, b.x, b.y - b.r * 0.14, b.r * WHEEL.iconScale, b.elementId);

      // Label
      ctx.globalAlpha = baseAlpha * 0.95;
      setFont(ctx, Math.max(8, b.r * 0.24), 700);
      ctx.fillStyle = press ? '#0a0c16' : b.color;
      ctx.fillText(b.elementId === 'focus' ? 'SPARK' : b.element.name, b.x, b.y + b.r * 0.58);

      // Cost, on the aimed spells only, so the wheel stays uncluttered.
      if (!isElement) {
        ctx.globalAlpha = baseAlpha * (game.player.mana >= FOCUS_SPELL.cost ? 0.6 : 0.3);
        setFont(ctx, Math.max(7, b.r * 0.2), 700);
        ctx.fillStyle = PALETTE.mana;
        ctx.fillText(`${FOCUS_SPELL.cost}`, b.x, b.y - b.r * 0.66);
      }
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
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
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
    const top = opts.y ?? this.h - UI.layout.pad - SPELLS.length * rowH;
    const dimUnreachable = opts.dimUnreachable ?? true;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    setFont(ctx, nameSize, 700);
    ctx.globalAlpha = opts.titleAlpha ?? 0.5;
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText('TAP IN ORDER', x, top - rowH * 0.75);
    ctx.globalAlpha = 1;

    SPELLS.forEach((spell, i) => {
      const y = top + i * rowH + rowH / 2;
      const live = !dimUnreachable || reachable.includes(spell);
      const won = reachable.length === 1 && reachable[0] === spell && active.length > 0;

      ctx.globalAlpha = live ? 1 : 0.24;
      drawPips(ctx, spell.sequence, x, y, pipR, pipR * 0.5, { alpha: live ? 1 : 0.5 });

      const textX = x + spell.sequence.length * (pipR * 2 + pipR * 0.5) + 10;
      ctx.globalAlpha = live ? 1 : 0.28;
      setFont(ctx, nameSize, won ? 800 : 700);
      ctx.fillStyle = won ? '#ffffff' : live ? spell.color : PALETTE.faint;
      ctx.fillText(spell.name, textX, y);

      if (won) {
        ctx.globalAlpha = 0.9;
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
    if (hud.muted) {
      ctx.fillStyle = PALETTE.faint;
      ctx.fillText('MUTED  [M]', this.w - pad, pad + 48);
    }

    if (hud.hintT > 0) {
      ctx.globalAlpha = Math.min(1, hud.hintT);
      ctx.textAlign = 'left';
      setFont(ctx, 11, 700);
      ctx.fillStyle = PALETTE.dim;
      ctx.fillText('LEFT: DRAG TO MOVE', pad, this.h - pad - 34);
      ctx.fillText('RIGHT: TAP ELEMENTS IN ORDER', pad, this.h - pad - 18);
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
    const d = Math.hypot(dx, dy);
    const k = d > stick.radius ? stick.radius / d : 1;
    const mag = stick.magnitude ?? 0;
    const moving = mag > 0.01;
    const deadZone = stick.deadZone ?? stick.radius * 0.18;
    const knobX = stick.ox + dx * k;
    const knobY = stick.oy + dy * k;

    ctx.save();

    // Base disc, brighter while you are actually moving.
    ctx.globalAlpha = moving ? 0.1 : 0.05;
    ctx.fillStyle = '#8fe3ff';
    ctx.beginPath();
    ctx.arc(stick.ox, stick.oy, stick.radius, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = moving ? 0.34 : 0.18;
    ctx.strokeStyle = '#8fe3ff';
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
    ctx.fillStyle = moving ? '#8fe3ff' : '#5d7591';
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
    ctx.strokeStyle = '#8fe3ff';
    ctx.lineWidth = 3;
    roundRect(ctx, -22, -38, 44, 76, 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-8, 28);
    ctx.lineTo(8, 28);
    ctx.stroke();
    ctx.restore();

    setFont(ctx, 18, 800);
    ctx.fillStyle = '#8fe3ff';
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

  drawTitle(game, hud) {
    const ctx = this.ctx;
    const cx = this.w / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(4,6,12,0.88)';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const top = Math.max(38, this.h * 0.1);
    setFont(ctx, Math.min(42, this.w * 0.068), 800);
    ctx.fillStyle = '#8fe3ff';
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
    ctx.fillText('tap elements in order to cast', leftX, labelY + 90);

    setFont(ctx, 11, 700);
    ctx.fillStyle = PALETTE.gold;
    ctx.fillText('THE RULE', leftX, labelY + 120);
    setFont(ctx, 12, 700);
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText('two of a kind -> aimed spell', leftX, labelY + 140);
    ctx.fillText('three different -> erupts around you', leftX, labelY + 158);

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
    ctx.fillStyle = '#8fe3ff';
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
    ctx.fillStyle = 'rgba(6,4,10,0.84)';
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
    ctx.fillStyle = '#8fe3ff';
    ctx.fillText('TAP TO TRY AGAIN', cx, this.h - Math.max(30, this.h * 0.08));
    ctx.globalAlpha = 1;
    setFont(ctx, 11, 700);
    ctx.fillStyle = PALETTE.dim;
    ctx.fillText(`BEST ${hud.best ?? 0}`, cx, this.h - Math.max(12, this.h * 0.032));
    ctx.restore();
  }
}

export { PALETTE, setFont, roundRect, drawElementGlyph };
