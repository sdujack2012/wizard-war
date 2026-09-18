/**
 * RUNE PRESSURE - all the drawing.
 *
 * Every sprite here is procedural vector art: no image files, no sprite sheets,
 * no dependencies. That keeps the project shippable as-is and lets the art scale
 * to any resolution, which matters when the same build runs on a 5" phone and a
 * desktop monitor.
 *
 * This module is pure drawing. It never reads game state directly - everything
 * arrives as arguments - so the renderer stays in charge of layout and this file
 * stays a library of shapes.
 *
 * Performance rules for phones:
 *   - never use ctx.shadowBlur (brutally slow on mobile GPUs)
 *   - glow is faked with two or three translucent passes
 *   - no gradients inside per-particle or per-frame loops
 */

import { mulberry32 } from './rng.js';

/**
 * Sprites are drawn larger than their collision radius on purpose. A small
 * hitbox and a big silhouette is the standard trade: the player gets generous
 * dodging, and the character is still legible at 45 device pixels.
 */
export const VIS = {
  wizard: 1.95,
  shade: 1.55,
  wisp: 1.5,
  brute: 1.22,
};

/** Drawn radius of an enemy's silhouette, which is larger than its hitbox. */
export function visualRadius(e) {
  return e.radius * (VIS[e.type] ?? 1.4);
}

const TAU = Math.PI * 2;

// ── small path helpers ───────────────────────────────────────────────────────

/** A closed blob with `n` wobbling vertices - the workhorse for organic shapes. */
function blobPath(ctx, cx, cy, rx, ry, n, wobble, phase) {
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const w = 1 + Math.sin(a * 3 + phase) * wobble + Math.sin(a * 5 - phase * 1.7) * wobble * 0.5;
    const x = cx + Math.cos(a) * rx * w;
    const y = cy + Math.sin(a) * ry * w;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Soft glow: concentric translucent discs. Cheaper and steadier than shadowBlur. */
function glowDisc(ctx, cx, cy, r, color, strength = 0.22, layers = 3) {
  ctx.save();
  ctx.fillStyle = color;
  for (let i = layers; i >= 1; i--) {
    ctx.globalAlpha = (strength * i) / (layers * layers);
    ctx.beginPath();
    ctx.arc(cx, cy, (r * i) / layers, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// ── the arena floor ─────────────────────────────────────────────────────────

/**
 * Static background. Rendered once into an offscreen canvas and blitted, so the
 * per-frame cost of a detailed floor is a single drawImage.
 *
 * Draws in WORLD units; the caller sets up the transform.
 */
export function drawArenaFloor(ctx, w, h) {
  const rng = mulberry32(0xa11ce);

  // Deep base with the ritual centre lit from within.
  ctx.fillStyle = '#080a14';
  ctx.fillRect(0, 0, w, h);

  const cols = 8;
  const rows = 5;
  const cw = w / cols;
  const chh = h / rows;
  const cx = w / 2;
  const cy = h / 2;

  // Flagstones. Per-tile brightness is seeded, so the floor is stable and reads
  // as stone rather than as a grid.
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x = rx * cw;
      const y = ry * chh;
      const dist = Math.hypot(x + cw / 2 - cx, y + chh / 2 - cy) / Math.hypot(cx, cy);
      const lum = 0.5 + rng() * 0.5;
      // Nearer the centre is warmer and brighter: the circle is lit.
      const warm = Math.max(0, 1 - dist * 1.5);
      const r = Math.round(14 + warm * 16 + lum * 4);
      const g = Math.round(16 + warm * 12 + lum * 5);
      const b = Math.round(26 + warm * 8 + lum * 7);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y, cw + 0.6, chh + 0.6);

      // Bevel: a light top-left edge and a dark bottom-right one.
      ctx.fillStyle = 'rgba(150,190,255,0.045)';
      ctx.fillRect(x, y, cw, 1);
      ctx.fillRect(x, y, 1, chh);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x, y + chh - 1, cw, 1);
      ctx.fillRect(x + cw - 1, y, 1, chh);
    }
  }

  // Hairline cracks and chips.
  ctx.strokeStyle = 'rgba(0,0,0,0.34)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    let x = rng() * w;
    let y = rng() * h;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 2 + Math.floor(rng() * 3);
    for (let s = 0; s < segs; s++) {
      x += (rng() - 0.5) * 44;
      y += (rng() - 0.5) * 44;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ── the etched ritual circle ──────────────────────────────────────────────
  const outer = Math.min(w, h) * 0.44;

  ctx.save();
  ctx.strokeStyle = 'rgba(120,190,255,0.16)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, TAU);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(120,190,255,0.10)';
  ctx.lineWidth = 1.4;
  for (const rr of [outer * 0.93, outer * 0.62, outer * 0.36]) {
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, TAU);
    ctx.stroke();
  }

  // Degree ticks on the outer band.
  ctx.strokeStyle = 'rgba(140,210,255,0.22)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * TAU;
    const long = i % 6 === 0;
    const r0 = outer - (long ? 13 : 7);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    ctx.stroke();
  }

  // Etched glyphs between the two middle rings. Each is a few short strokes from
  // a seeded generator, so the ring looks inscribed rather than patterned.
  ctx.strokeStyle = 'rgba(150,215,255,0.30)';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  const glyphR = outer * 0.485;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    const gx = cx + Math.cos(a) * glyphR;
    const gy = cy + Math.sin(a) * glyphR;
    ctx.save();
    ctx.translate(gx, gy);
    ctx.rotate(a + Math.PI / 2);
    const strokes = 2 + Math.floor(rng() * 3);
    for (let s = 0; s < strokes; s++) {
      ctx.beginPath();
      ctx.moveTo((rng() - 0.5) * 15, (rng() - 0.5) * 15);
      ctx.lineTo((rng() - 0.5) * 15, (rng() - 0.5) * 15);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Radial spokes, faded toward the rim.
  ctx.strokeStyle = 'rgba(120,190,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * outer * 0.36, cy + Math.sin(a) * outer * 0.36);
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    ctx.stroke();
  }
  ctx.restore();

  // ── stone frame ───────────────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = 'rgba(90,130,200,0.28)';
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, w - 14, h - 14);
  ctx.strokeStyle = 'rgba(150,200,255,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(14, 14, w - 28, h - 28);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(1, 1, w - 2, h - 2);

  // Corner brackets.
  const L = 46;
  ctx.strokeStyle = 'rgba(160,215,255,0.4)';
  ctx.lineWidth = 3;
  for (const [sx, sy] of [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ]) {
    const bx = sx > 0 ? 22 : w - 22;
    const by = sy > 0 ? 22 : h - 22;
    ctx.beginPath();
    ctx.moveTo(bx + sx * 18, by);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx, by + sy * 18);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The living part of the ritual circle: two rings turning against each other,
 * plus a centre glow that reddens as the wave clock runs down.
 */
export function drawRitualGlow(ctx, w, h, time, danger) {
  const cx = w / 2;
  const cy = h / 2;
  const outer = Math.min(w, h) * 0.44;
  const pulse = 0.55 + 0.45 * Math.sin(time * 1.6);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // Centre pool of light, tinted by danger.
  const base = danger > 0.5 ? '255,90,120' : '110,190,255';
  ctx.fillStyle = `rgba(${base},0.05)`;
  ctx.beginPath();
  ctx.arc(cx, cy, outer * 0.95, 0, TAU);
  ctx.fill();

  // Two dashed rings rotating opposite ways.
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(${base},${0.16 + 0.14 * pulse})`;
  ctx.setLineDash([16, 22]);
  ctx.lineDashOffset = -time * 26;
  ctx.beginPath();
  ctx.arc(cx, cy, outer * 0.93, 0, TAU);
  ctx.stroke();

  ctx.strokeStyle = `rgba(${base},${0.12 + 0.1 * pulse})`;
  ctx.setLineDash([7, 30]);
  ctx.lineDashOffset = time * 40;
  ctx.beginPath();
  ctx.arc(cx, cy, outer * 0.62, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);

  // Inner ring breathes with the clock.
  ctx.strokeStyle = `rgba(${base},${0.2 + 0.25 * pulse})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, outer * 0.36 + pulse * 3, 0, TAU);
  ctx.stroke();

  ctx.restore();
}

/** Corner braziers: warm pools of light with a flickering flame. */
export function drawBraziers(ctx, w, h, time) {
  const inset = 44;
  const spots = [
    [inset, inset],
    [w - inset, inset],
    [inset, h - inset],
    [w - inset, h - inset],
  ];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  spots.forEach(([x, y], i) => {
    const flick = 0.75 + 0.25 * Math.sin(time * 9 + i * 2.1) * Math.sin(time * 3.3 + i);
    ctx.globalAlpha = 0.12 * flick;
    ctx.fillStyle = '#ffa23d';
    ctx.beginPath();
    ctx.arc(x, y, 62, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.22 * flick;
    ctx.beginPath();
    ctx.arc(x, y, 24, 0, TAU);
    ctx.fill();

    // Flame.
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#ffd08a';
    ctx.beginPath();
    ctx.moveTo(x, y - 12 * flick);
    ctx.quadraticCurveTo(x + 6, y - 2, x, y + 3);
    ctx.quadraticCurveTo(x - 6, y - 2, x, y - 12 * flick);
    ctx.fill();
  });
  ctx.restore();
}

/** Drifting dust motes. Cheap, and they make the air feel like it is moving. */
export function makeMotes(count, w, h, seed = 99) {
  const rng = mulberry32(seed);
  const motes = [];
  for (let i = 0; i < count; i++) {
    motes.push({
      x: rng() * w,
      y: rng() * h,
      r: 0.8 + rng() * 1.8,
      vy: -(3 + rng() * 11),
      vx: (rng() - 0.5) * 7,
      phase: rng() * TAU,
      a: 0.1 + rng() * 0.3,
    });
  }
  return motes;
}

export function drawMotes(ctx, motes, w, h, dt, time) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const m of motes) {
    m.y += m.vy * dt;
    m.x += m.vx * dt + Math.sin(time * 0.7 + m.phase) * 0.35;
    if (m.y < -8) {
      m.y = h + 8;
      m.x = Math.random() * w;
    }
    if (m.x < -8) m.x = w + 8;
    if (m.x > w + 8) m.x = -8;
    ctx.globalAlpha = m.a * (0.6 + 0.4 * Math.sin(time * 2 + m.phase));
    ctx.fillStyle = '#bcd9ff';
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** Red wash creeping in from the edges when the clock is nearly out. */
export function drawDangerWash(ctx, w, h, danger) {
  if (danger <= 0.01) return;
  const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 180);
  ctx.save();
  ctx.globalAlpha = Math.min(0.5, danger * 0.5 * pulse);
  ctx.strokeStyle = '#ff3b5c';
  for (let i = 0; i < 5; i++) {
    ctx.lineWidth = 26 - i * 4;
    ctx.globalAlpha = Math.min(0.5, danger * 0.5 * pulse) * (1 - i / 5);
    ctx.strokeRect(3 + i * 5, 3 + i * 5, w - 6 - i * 10, h - 6 - i * 10);
  }
  ctx.restore();
}

// ── the wizard ──────────────────────────────────────────────────────────────

/**
 * A hooded mage, seen from a high three-quarter view so the face stays readable
 * from any facing. Direction is communicated by the staff sweeping toward the
 * aim, which is far clearer than rotating a top-down figure.
 */
export function drawWizard(ctx, o) {
  const { x, y, radius, time, aimAngle, moveMag = 0, hurt = false, healing = false, invuln = false, castFlash = 0 } = o;
  const R = radius * VIS.wizard;
  const bob = Math.sin(time * 7) * R * 0.045 * (0.4 + moveMag);
  const sway = Math.sin(time * 5.5) * R * 0.03;

  ctx.save();
  ctx.translate(x + sway * 0.4, y + bob);

  // Shadow on the floor, offset by how much they are leaning.
  ctx.save();
  ctx.globalAlpha = 0.38;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, R * 0.86, R * 0.78, R * 0.24, 0, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Robe colours shift with state so damage and healing read instantly.
  const robeOuter = hurt ? '#6e1830' : healing ? '#1d5c3a' : '#2b3566';
  const robeInner = hurt ? '#a32846' : healing ? '#2f8a56' : '#3d4a86';
  const trim = hurt ? '#ffb3c1' : healing ? '#9df5bd' : '#8fc4ff';

  // ── cloak ────────────────────────────────────────────────────────────────
  const shoulderY = -R * 0.5;
  const hemY = R * 0.92;
  const shoulderW = R * 0.5;
  const hemW = R * 0.98;

  const hem = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    hem.push([-hemW + hemW * 2 * t, hemY + Math.sin(time * 5 + i * 1.6) * R * 0.07 * (0.5 + moveMag)]);
  }

  ctx.beginPath();
  ctx.moveTo(-shoulderW, shoulderY);
  ctx.bezierCurveTo(-hemW * 0.95, shoulderY + R * 0.4, -hemW, hemY - R * 0.3, hem[0][0], hem[0][1]);
  for (const [hx, hy] of hem) ctx.lineTo(hx, hy);
  ctx.bezierCurveTo(hemW, hemY - R * 0.3, hemW * 0.95, shoulderY + R * 0.4, shoulderW, shoulderY);
  ctx.closePath();
  ctx.fillStyle = robeOuter;
  ctx.fill();

  // Inner robe panel.
  ctx.beginPath();
  ctx.moveTo(-R * 0.2, shoulderY + R * 0.05);
  ctx.lineTo(R * 0.2, shoulderY + R * 0.05);
  ctx.lineTo(R * 0.42, hemY - R * 0.05);
  ctx.lineTo(-R * 0.42, hemY - R * 0.05);
  ctx.closePath();
  ctx.fillStyle = robeInner;
  ctx.fill();

  // Hem highlight.
  ctx.beginPath();
  ctx.moveTo(hem[0][0], hem[0][1]);
  for (const [hx, hy] of hem) ctx.lineTo(hx, hy);
  ctx.strokeStyle = trim;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Belt.
  ctx.fillStyle = '#c9a24a';
  ctx.fillRect(-R * 0.34, R * 0.06, R * 0.68, R * 0.11);

  // ── arms ─────────────────────────────────────────────────────────────────
  ctx.fillStyle = robeInner;
  ctx.beginPath();
  ctx.ellipse(-R * 0.5, R * 0.02, R * 0.17, R * 0.24, -0.25, 0, TAU);
  ctx.fill();

  // ── staff, swept toward the aim ──────────────────────────────────────────
  // Compressing Y turns the sweep into an arc rather than a flat spin, which is
  // what sells the three-quarter perspective.
  const reach = R * 1.65;
  const orbX = Math.cos(aimAngle) * reach;
  const orbY = Math.sin(aimAngle) * reach * 0.5 - R * 0.28;
  const gripX = orbX * 0.34 + R * 0.2;
  const gripY = orbY * 0.34 + R * 0.22;

  ctx.strokeStyle = hurt ? '#6b4a3a' : '#6d5a4a';
  ctx.lineWidth = R * 0.12;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(gripX - (orbX - gripX) * 0.35, gripY - (orbY - gripY) * 0.35);
  ctx.lineTo(orbX, orbY);
  ctx.stroke();

  // Hand on the shaft.
  ctx.fillStyle = robeInner;
  ctx.beginPath();
  ctx.arc(gripX, gripY, R * 0.15, 0, TAU);
  ctx.fill();

  // Staff orb: brighter and larger mid-cast.
  const flash = castFlash;
  glowDisc(ctx, orbX, orbY, R * (0.42 + flash * 0.5), hurt ? '#ff6b81' : '#8fe3ff', 0.3 + flash * 0.4, 3);
  ctx.fillStyle = flash > 0.05 ? '#ffffff' : hurt ? '#ffd0d8' : '#dff4ff';
  ctx.beginPath();
  ctx.arc(orbX, orbY, R * (0.19 + flash * 0.13), 0, TAU);
  ctx.fill();

  // ── head and hood ────────────────────────────────────────────────────────
  const headY = -R * 0.72;
  ctx.fillStyle = robeOuter;
  ctx.beginPath();
  ctx.ellipse(0, headY, R * 0.42, R * 0.44, 0, Math.PI, 0);
  ctx.quadraticCurveTo(R * 0.46, headY + R * 0.3, R * 0.3, headY + R * 0.42);
  ctx.lineTo(-R * 0.3, headY + R * 0.42);
  ctx.quadraticCurveTo(-R * 0.46, headY + R * 0.3, -R * 0.42, headY);
  ctx.closePath();
  ctx.fill();

  // Face void.
  ctx.fillStyle = '#05060c';
  ctx.beginPath();
  ctx.ellipse(0, headY + R * 0.08, R * 0.26, R * 0.22, 0, 0, TAU);
  ctx.fill();

  // Eyes.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = hurt ? '#ff4d6d' : '#8fe3ff';
  ctx.globalAlpha = 0.95;
  for (const ex of [-0.1, 0.1]) {
    ctx.beginPath();
    ctx.arc(ex * R * 2, headY + R * 0.07, R * 0.055, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  // Hood rim.
  ctx.strokeStyle = trim;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, headY, R * 0.42, R * 0.44, 0, Math.PI, 0);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // ── state overlays ───────────────────────────────────────────────────────
  if (healing) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 5; i++) {
      const t = (time * 1.4 + i / 5) % 1;
      ctx.globalAlpha = (1 - t) * 0.7;
      ctx.fillStyle = '#9df5bd';
      const a = (i / 5) * TAU + time;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * R * 0.8, R * 0.9 - t * R * 1.9, R * 0.1, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  if (invuln) {
    ctx.save();
    ctx.globalAlpha = 0.45 + 0.45 * Math.sin(time * 40);
    ctx.strokeStyle = '#c39bff';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.arc(0, R * 0.1, R * 1.15, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

// ── enemies ─────────────────────────────────────────────────────────────────

/** Dispatch to the right creature. `opts` carries the player position for facing. */
export function drawEnemy(ctx, e, opts) {
  if (e.type === 'wisp') drawWisp(ctx, e, opts);
  else if (e.type === 'brute') drawBrute(ctx, e, opts);
  else drawShade(ctx, e, opts);
}

/** SHADE - a hooded wraith. Leans toward the player, claws out. */
function drawShade(ctx, e, { time, px, py }) {
  const R = e.radius * VIS.shade;
  const flash = e.hitFlash > 0;
  const body = flash ? '#ffffff' : e.color;
  const dark = flash ? '#ffd9e0' : '#3a0f1e';
  const bob = Math.sin(e.bob) * R * 0.12;
  const towards = Math.atan2(py - e.y, px - e.x);

  ctx.save();
  ctx.translate(e.x, e.y + bob);

  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, R * 0.85, R * 0.72, R * 0.2, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Tattered robe: a cone with a ragged hem.
  const hemY = R * 0.95;
  const hemW = R * 0.85;
  ctx.beginPath();
  ctx.moveTo(0, -R * 0.9);
  ctx.bezierCurveTo(R * 0.55, -R * 0.5, R * 0.8, R * 0.2, hemW, hemY);
  for (let i = 7; i >= 0; i--) {
    const t = i / 7;
    const hx = -hemW + hemW * 2 * t;
    ctx.lineTo(hx, hemY + Math.sin(e.bob * 2 + i * 2.2) * R * 0.18 - (i % 2) * R * 0.16);
  }
  ctx.bezierCurveTo(-R * 0.8, R * 0.2, -R * 0.55, -R * 0.5, 0, -R * 0.9);
  ctx.closePath();
  ctx.fillStyle = body;
  ctx.globalAlpha = 0.92;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Inner shadow.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(0, -R * 0.12, R * 0.34, R * 0.5, 0, 0, TAU);
  ctx.fill();

  // Claws, angled toward the player.
  ctx.strokeStyle = body;
  ctx.lineWidth = R * 0.13;
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    const sx = side * R * 0.62;
    const sy = -R * 0.05;
    const reach = R * 0.62;
    const dir = towards + (side < 0 ? Math.PI : 0);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(dir) * reach * 0.6, sy + Math.sin(dir) * reach * 0.35 + R * 0.2);
    for (let c = -1; c <= 1; c++) {
      ctx.moveTo(sx + Math.cos(dir) * reach * 0.6, sy + Math.sin(dir) * reach * 0.35 + R * 0.2);
      ctx.lineTo(
        sx + Math.cos(dir + c * 0.5) * reach,
        sy + Math.sin(dir + c * 0.5) * reach * 0.5 + R * 0.34,
      );
    }
    ctx.stroke();
  }

  // Hood with a black void and two burning eyes.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(0, -R * 1.25);
  ctx.quadraticCurveTo(R * 0.52, -R * 1.0, R * 0.36, -R * 0.42);
  ctx.lineTo(-R * 0.36, -R * 0.42);
  ctx.quadraticCurveTo(-R * 0.52, -R * 1.0, 0, -R * 1.25);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#06060c';
  ctx.beginPath();
  ctx.ellipse(0, -R * 0.72, R * 0.28, R * 0.24, 0, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const eyeGlow = 0.7 + 0.3 * Math.sin(time * 6 + e.bob);
  ctx.globalAlpha = eyeGlow;
  ctx.fillStyle = flash ? '#ffffff' : '#ff2d55';
  for (const ex of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(ex * R * 0.13, -R * 0.73, R * 0.075, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  ctx.restore();
}

/** WISP - a caged lantern-spirit that keeps its distance and spits bolts. */
function drawWisp(ctx, e, { time, px, py }) {
  const R = e.radius * VIS.wisp;
  const flash = e.hitFlash > 0;
  const body = flash ? '#ffffff' : e.color;
  const bob = Math.sin(e.bob * 1.3) * R * 0.22;

  ctx.save();
  ctx.translate(e.x, e.y + bob);

  ctx.globalAlpha = 0.25;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, R * 1.5 - bob, R * 0.5, R * 0.15, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Trailing tail, drifting away from the player.
  const away = Math.atan2(e.y - py, e.x - px);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 1; i <= 4; i++) {
    const t = i / 4;
    ctx.globalAlpha = 0.22 * (1 - t);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(
      Math.cos(away) * R * 1.1 * t,
      Math.sin(away) * R * 1.1 * t + Math.sin(time * 4 - i) * R * 0.16,
      R * (0.5 - t * 0.3),
      0,
      TAU,
    );
    ctx.fill();
  }
  ctx.restore();

  // Halo.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, R * 3, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.2;
  ctx.beginPath();
  ctx.arc(0, 0, R * 1.7, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Lantern collar.
  ctx.strokeStyle = flash ? '#ffffff' : '#e3d2ff';
  ctx.lineWidth = R * 0.16;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.95, 0, TAU);
  ctx.stroke();

  // Core.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.62, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#0a0a12';
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.3, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.14, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Orbiting motes.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const a = time * 2.2 + (i / 3) * TAU;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(Math.cos(a) * R * 1.25, Math.sin(a) * R * 0.75, R * 0.13, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  ctx.restore();
}

/** BRUTE - a slab of armour with a glowing core. */
function drawBrute(ctx, e, { time, px, py }) {
  const R = e.radius * VIS.brute;
  const flash = e.hitFlash > 0;
  const plate = flash ? '#ffffff' : e.color;
  const shade = flash ? '#ffd9b0' : '#7a4210';
  const stomp = Math.abs(Math.sin(e.bob * 0.55)) * R * 0.08;

  ctx.save();
  ctx.translate(e.x, e.y - stomp);

  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, R * 0.92 + stomp, R * 0.82, R * 0.22, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Legs.
  ctx.fillStyle = shade;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.roundRect
      ? ctx.roundRect(side * R * 0.34 - R * 0.16, R * 0.3, R * 0.32, R * 0.55, R * 0.1)
      : ctx.rect(side * R * 0.34 - R * 0.16, R * 0.3, R * 0.32, R * 0.55);
    ctx.fill();
  }

  // Torso.
  ctx.fillStyle = plate;
  ctx.beginPath();
  ctx.moveTo(-R * 0.72, -R * 0.55);
  ctx.quadraticCurveTo(0, -R * 0.82, R * 0.72, -R * 0.55);
  ctx.lineTo(R * 0.62, R * 0.42);
  ctx.quadraticCurveTo(0, R * 0.6, -R * 0.62, R * 0.42);
  ctx.closePath();
  ctx.fill();

  // Chest core.
  const corePulse = 0.7 + 0.3 * Math.sin(time * 4 + e.bob);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.35 * corePulse;
  ctx.fillStyle = '#ffd27a';
  ctx.beginPath();
  ctx.arc(0, -R * 0.05, R * 0.55, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#2a1405';
  ctx.beginPath();
  ctx.arc(0, -R * 0.05, R * 0.26, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#ffe6a8';
  ctx.beginPath();
  ctx.arc(0, -R * 0.05, R * 0.13 * corePulse, 0, TAU);
  ctx.fill();

  // Shoulder plates.
  ctx.fillStyle = shade;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * R * 0.74, -R * 0.44, R * 0.3, R * 0.24, side * 0.3, 0, TAU);
    ctx.fill();
  }

  // Fists.
  ctx.fillStyle = plate;
  for (const side of [-1, 1]) {
    const swing = Math.sin(e.bob * 0.55 + (side > 0 ? 0 : Math.PI)) * R * 0.1;
    ctx.beginPath();
    ctx.arc(side * R * 0.66, R * 0.28 + swing, R * 0.25, 0, TAU);
    ctx.fill();
  }

  // Head, sunk between the shoulders, glaring at the player.
  const towards = Math.atan2(py - e.y, px - e.x);
  ctx.fillStyle = plate;
  ctx.beginPath();
  ctx.ellipse(0, -R * 0.78, R * 0.32, R * 0.28, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#1a0d02';
  ctx.beginPath();
  ctx.ellipse(0, -R * 0.76, R * 0.22, R * 0.13, 0, 0, TAU);
  ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = '#ffb03d';
  ctx.globalAlpha = 0.9;
  for (const ex of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(ex * R * 0.1, -R * 0.76, R * 0.05, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  void towards;

  ctx.restore();
}

// ── spell effects ───────────────────────────────────────────────────────────

/** Player projectiles, drawn by spell kind. */
export function drawBolt(ctx, b, time) {
  const R = b.radius;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(Math.atan2(b.vy, b.vx));
  ctx.globalCompositeOperation = 'lighter';

  if (b.kind === 'fireball') {
    // Flame tail, tapering behind the head.
    for (let i = 0; i < 5; i++) {
      const t = i / 5;
      const len = R * (0.9 + t * 3.2);
      const wob = Math.sin(time * 22 + i * 1.9) * R * 0.22;
      ctx.globalAlpha = 0.5 * (1 - t);
      ctx.fillStyle = i < 2 ? '#ffd27a' : '#ff6b35';
      ctx.beginPath();
      ctx.moveTo(-len, -R * (0.7 - t * 0.5) + wob);
      ctx.lineTo(-len - R * 0.5, wob * 0.5);
      ctx.lineTo(-len, R * (0.7 - t * 0.5) + wob);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = '#ff8c42';
    ctx.beginPath();
    ctx.arc(0, 0, R * 2.1, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ff7a3d';
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fff3d0';
    ctx.beginPath();
    ctx.arc(R * 0.12, 0, R * 0.5, 0, TAU);
    ctx.fill();
  } else if (b.kind === 'waterball') {
    // Droplet trail.
    for (let i = 0; i < 4; i++) {
      const t = i / 4;
      ctx.globalAlpha = 0.4 * (1 - t);
      ctx.fillStyle = '#8fd4ff';
      ctx.beginPath();
      ctx.arc(-R * (1.3 + t * 2.4), Math.sin(time * 12 + i) * R * 0.4, R * (0.42 - t * 0.24), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#3fa9f5';
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.5, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#2f86d8';
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#cdeaff';
    ctx.beginPath();
    ctx.arc(-R * 0.3, -R * 0.32, R * 0.34, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#eaf7ff';
    ctx.lineWidth = R * 0.14;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.82, -2.4, -0.6);
    ctx.stroke();
  } else {
    // SPARK: a bright dart with a collapsing tail.
    for (let i = 0; i < 3; i++) {
      const t = i / 3;
      ctx.globalAlpha = 0.45 * (1 - t);
      ctx.fillStyle = '#cfe6ff';
      ctx.beginPath();
      ctx.arc(-R * (0.9 + t * 2.2), 0, R * (0.8 - t * 0.4), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#8fe3ff';
    ctx.beginPath();
    ctx.arc(0, 0, R * 2, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(R * 1.6, 0);
    ctx.lineTo(-R * 0.6, -R * 0.85);
    ctx.lineTo(-R * 0.2, 0);
    ctx.lineTo(-R * 0.6, R * 0.85);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Enemy bolts: a hostile, sickly dart. */
export function drawEnemyBolt(ctx, b, time) {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = b.color;
  ctx.beginPath();
  ctx.arc(0, 0, b.radius * 2.4, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, b.radius * 0.95, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.6 + 0.4 * Math.sin(time * 18);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, b.radius * 0.36, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Spell and status rings, drawn by kind. */
export function drawRing(ctx, ring, time) {
  const life = Math.max(0, ring.ttl / ring.maxTtl);
  const r = ring.r;

  if (ring.kind === 'frost') {
    // Crystalline wave: a band of ice with spikes growing off it.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = ring.color;
    ctx.globalAlpha = 0.22 * life;
    ctx.lineWidth = 26;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.85 * life;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();

    // Radial ice spikes.
    ctx.globalAlpha = 0.7 * life;
    ctx.fillStyle = '#dff6ff';
    const spikes = 26;
    for (let i = 0; i < spikes; i++) {
      const a = (i / spikes) * TAU + time * 0.25;
      const len = 12 + Math.sin(i * 2.7 + time * 3) * 7;
      const w = 0.055;
      ctx.beginPath();
      ctx.moveTo(ring.x + Math.cos(a - w) * r, ring.y + Math.sin(a - w) * r);
      ctx.lineTo(ring.x + Math.cos(a) * (r + len), ring.y + Math.sin(a) * (r + len));
      ctx.lineTo(ring.x + Math.cos(a + w) * r, ring.y + Math.sin(a + w) * r);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (ring.kind === 'nova') {
    // Explosion shockwave: a jagged fire ring with a white-hot core.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45 * life;
    ctx.fillStyle = '#ffce8a';
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r * 0.72, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = 0.9 * life;
    ctx.fillStyle = '#ff7a3d';
    ctx.beginPath();
    const lobes = 18;
    for (let i = 0; i <= lobes; i++) {
      const a = (i / lobes) * TAU;
      const wob = 1 + Math.sin(a * 5 + time * 8) * 0.08;
      const rr = r * wob;
      const x = ring.x + Math.cos(a) * rr;
      const y = ring.y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 0.95 * life;
    ctx.fillStyle = '#fff0c2';
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r * 0.34, 0, TAU);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (ring.kind === 'heal') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6 * life;
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.25 * life;
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r * 0.94, 0, TAU);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + time * 1.5;
      ctx.globalAlpha = 0.7 * life;
      ctx.fillStyle = '#bfffd4';
      ctx.beginPath();
      ctx.arc(ring.x + Math.cos(a) * r, ring.y + Math.sin(a) * r - (1 - life) * 20, 3.2, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  // Fallback: a plain glowing band.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = ring.color;
  ctx.globalAlpha = 0.3 * life;
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.arc(ring.x, ring.y, r, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 0.85 * life;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(ring.x, ring.y, r, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

/** Particles, shaped by element so a fire hit does not look like an ice hit. */
export function drawParticle(ctx, p) {
  // Expired particles must draw nothing. Clamping the alpha alone would leave
  // them silently costing a full path build every frame.
  if (p.life <= 0) return;
  const a = Math.max(0, p.life / p.maxLife);
  const size = p.size * (0.4 + a * 0.6);
  if (size < 0.4) return;

  ctx.globalAlpha = a * 0.92;
  ctx.fillStyle = p.color;

  switch (p.shape) {
    case 'ember': {
      // Rotating fleck of fire.
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle ?? 0);
      ctx.fillRect(-size * 0.5, -size * 0.5, size, size);
      ctx.restore();
      break;
    }
    case 'shard': {
      // Splinter of ice.
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle ?? 0);
      ctx.beginPath();
      ctx.moveTo(size * 1.9, 0);
      ctx.lineTo(0, -size * 0.55);
      ctx.lineTo(-size * 1.9, 0);
      ctx.lineTo(0, size * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'droplet': {
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, size * 0.8, size * 1.25, Math.atan2(p.vy, p.vx) + Math.PI / 2, 0, TAU);
      ctx.fill();
      break;
    }
    case 'mote': {
      ctx.globalAlpha = a * 0.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 1.9, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = a * 0.95;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 0.7, 0, TAU);
      ctx.fill();
      break;
    }
    default: {
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** Short arc drawn from the caster to the muzzle when a spell leaves the staff. */
export function drawCastLink(ctx, link) {
  const a = Math.max(0, link.ttl / link.max);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = a * 0.55;
  ctx.strokeStyle = link.color;
  ctx.lineWidth = 6 * a;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(link.x1, link.y1);
  ctx.lineTo(link.x2, link.y2);
  ctx.stroke();
  ctx.restore();
}
