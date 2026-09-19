/**
 * RUNE PRESSURE - all the drawing.
 *
 * Two art paths live here, and they must agree about where a character stands:
 *
 *   - the PROCEDURAL vector art, which needs no files and scales to any
 *     resolution (the same build runs on a 5" phone and a desktop monitor);
 *   - the PAINTED bitmaps in assets/ (see src/assets.js), which the renderer
 *     hands in per entity as `sprite` / `spriteFlash`.
 *
 * Every creature is written against its drawn radius `R`, and the painted path
 * uses the same `R` through the ART table in config.js, so a missing or
 * still-loading asset silently changes how the game looks and nothing else -
 * not where a creature stands, not what a hit flash looks like.
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

import { ART, MOTION } from './config.js';
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

// ── the painted art path ─────────────────────────────────────────────────────

/**
 * Draw a painted creature at (x, y), or return false so the caller can draw its
 * vector art instead.
 *
 * The bitmap is trimmed to its content, so `ART.height` is the whole silhouette:
 * the sprite is scaled to `R * height`, hung so its bottom edge sits at
 * `y + R * foot`, and centred on x. `lean` tilts it into its motion and `mirror`
 * flips it to face left or right - together they stand in for the vector art's
 * turning and leaning without ever rotating a three-quarter-view character far
 * enough to read as falling over.
 *
 * `hop` is where the creature is in its step: 0 at a footfall, 1 at the top of
 * the stride. The body lifts and stretches through the middle of a step and
 * squashes as the foot lands, which is most of what makes a walk look weighted.
 *
 * A missing image, a zero-sized one, or a platform without drawImage all fall
 * through to the vector art, so this can never be the reason nothing appears.
 */
function drawPainted(ctx, o) {
  const { img, R, x, y, height, foot, lean = 0, mirror = 0, alpha = 1, hop = 0 } = o;
  if (!img || !img.width || !img.height || typeof ctx.drawImage !== 'function') return false;

  const stretch = 1 + ART.walkSquash * (hop * 2 - 1);
  const h = R * height * stretch;
  const w = ((R * height) / img.height) * img.width * (2 - stretch);
  const lift = -R * MOTION.lift * hop;

  ctx.save();
  // Multiply, do not assign: the renderer fades a spawning enemy out of nothing
  // by setting globalAlpha first, and the painted path used to silently drop it.
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y + R * foot - h / 2 + lift);
  if (lean) ctx.rotate(lean);
  if (mirror) ctx.scale(-1, 1);
  // Drawn from its own centre, which is what the trim made the anchor.
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  return true;
}

/**
 * A painted creature mid-walk.
 *
 * Three bitmaps do the work of a walk cycle: two step poses (left foot forward,
 * right foot forward) crossfaded against each other, and the neutral standing
 * pose faded in as the creature slows to a stop. Which pose is showing comes
 * from `gait` - strides actually travelled - so the feet keep pace with the
 * ground however fast or slow the creature is going, and stop when it stops.
 *
 * A hit flash draws the white silhouette instead: at that moment the pose tells
 * the player nothing and the flash tells them everything.
 */
function drawPaintedWalk(ctx, o) {
  const { sprite, spriteFlash, poseA, poseB, flash = false, moveK = 1, gait = 0 } = o;
  if (!sprite) return false;
  if (flash && spriteFlash) return drawPainted(ctx, { ...o, img: spriteFlash });

  const cycle = gait - Math.floor(gait);
  const raw = 0.5 - 0.5 * Math.cos(cycle * TAU);
  // Smoothstep the blend. A plain cosine cross-fade spends the whole cycle with
  // both poses half-visible, which reads as a shimmering double image; this
  // holds each pose flat and swaps quickly between them.
  const k = raw * raw * (3 - 2 * raw);
  const still = Math.max(0, 1 - moveK);

  if (still > 0.01) drawPainted(ctx, { ...o, img: sprite, alpha: still });
  if (moveK > 0.01 && poseA && poseB) {
    drawPainted(ctx, { ...o, img: poseA, alpha: moveK * (1 - k) });
    drawPainted(ctx, { ...o, img: poseB, alpha: moveK * k });
  } else if (moveK > 0.01) {
    drawPainted(ctx, { ...o, img: sprite, alpha: moveK });
  }
  return true;
}

/** Where in its step a creature is: `hop` 0 at a footfall, 1 at the top. */
function hopOf(motion) {
  const cycle = (motion?.gait ?? 0) - Math.floor(motion?.gait ?? 0);
  return Math.abs(Math.sin(cycle * Math.PI * 2)) * (motion?.moveK ?? 0);
}

/** Lean, corrected for the mirror: a flipped sprite tilts the other way. */
function leanOf(motion) {
  const lean = motion?.lean ?? 0;
  return motion?.mirror ? -lean : lean;
}

/** The soft floor shadow both art paths use, so grounding never changes. */
function groundShadow(ctx, R, spread = 0.78, squash = 0.24, offset = 0.86) {
  ctx.save();
  ctx.globalAlpha = 0.38;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, R * offset, R * spread, R * squash, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/**
 * A soft dark scrim behind a painted creature, fading outward.
 *
 * The vector art had hard silhouettes and flat fills, so it read against the
 * floor for free. A painted bitmap has neither: it has to out-contrast a painted
 * background, and the cheapest way to buy that is a dark pool underneath it.
 */
function contactScrim(ctx, R, spread = 1.2, h = 1.3) {
  if (ART.contactShade <= 0) return;
  const layers = 3;
  ctx.save();
  ctx.fillStyle = '#04060c';
  for (let i = layers; i >= 1; i--) {
    const k = i / layers;
    ctx.globalAlpha = (ART.contactShade * k) / (layers * layers);
    ctx.beginPath();
    ctx.ellipse(0, R * 0.1, R * spread * k, R * h * k, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

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

/**
 * A spiked burst outline: alternating outer and inner radii around a circle.
 *
 * Flat, hard-edged and closed, so it can be filled several times at shrinking
 * scales to draw a cel shape with an outline. This is the backdrop of an
 * impact - a soft radial gradient reads as fog, a star reads as a HIT.
 */
function starPath(ctx, rOuter, points, innerRatio, phase = 0) {
  ctx.beginPath();
  const n = points * 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + phase;
    const rr = i % 2 === 0 ? rOuter : rOuter * innerRatio;
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Soft glow: concentric translucent discs. Cheaper and steadier than shadowBlur. */function glowDisc(ctx, cx, cy, r, color, strength = 0.22, layers = 3) {
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
      // Explicit sqrt rather than Math.hypot: the port shares this primitive, and
      // Math.hypot's extra precision is not reproducible across the two runtimes.
      // The convention is established in the simulation path (dist2/norm2).
      const ddx = x + cw / 2 - cx;
      const ddy = y + chh / 2 - cy;
      const dist = Math.sqrt(ddx * ddx + ddy * ddy) / Math.sqrt(cx * cx + cy * cy);
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
  // Opaque, not additive: this is the run that tells the player time is nearly
  // out, and an additive ring that adds nothing to a bright floor tells them
  // nothing. The colour shift to red is the whole point.
  const base = danger > 0.5 ? '178,58,46' : '47,93,168';

  // Centre pool, tinted by danger.
  ctx.fillStyle = `rgba(${base},0.07)`;
  ctx.beginPath();
  ctx.arc(cx, cy, outer * 0.95, 0, TAU);
  ctx.fill();

  // Two dashed rings rotating opposite ways.
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(${base},${0.3 + 0.28 * pulse})`;
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
  // Opaque firelight, not added light. This pass is what animates the braziers,
  // and additive orange over a pale floor is nothing at all - the corners went
  // dark and quiet the moment the arena turned bright.
  spots.forEach(([x, y], i) => {
    const flick = 0.75 + 0.25 * Math.sin(time * 9 + i * 2.1) * Math.sin(time * 3.3 + i);
    ctx.globalAlpha = 0.16 * flick;
    ctx.fillStyle = '#ff9c2e';
    ctx.beginPath();
    ctx.arc(x, y, 54, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.3 * flick;
    ctx.fillStyle = '#ffb547';
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, TAU);
    ctx.fill();

    // Flame.
    ctx.globalAlpha = 0.95;
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
  // Dust on a bright floor: a soft grey-blue speck rather than a glow, which
  // would be invisible against pale stone.
  for (const m of motes) {
    m.y += m.vy * dt;
    m.x += m.vx * dt + Math.sin(time * 0.7 + m.phase) * 0.35;
    if (m.y < -8) {
      m.y = h + 8;
      m.x = Math.random() * w;
    }
    if (m.x < -8) m.x = w + 8;
    if (m.x > w + 8) m.x = -8;
    ctx.globalAlpha = m.a * 0.8 * (0.6 + 0.4 * Math.sin(time * 2 + m.phase));
    ctx.fillStyle = '#9a8f78';
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
  ctx.strokeStyle = '#b23a2e';
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
  groundShadow(ctx, R);

  // ── painted path ─────────────────────────────────────────────────────────
  // The body is a bitmap; the STAFF stays vector, because the sweep toward the
  // aim is the only directional read the character has and it has to keep
  // pointing at whatever the auto-aim picked.
  if (o.sprite) {
    // `hurt` and `healing` are the vector art's instant damage/heal tells. The
    // renderer hands in the pre-tinted variant; this only has to pick it.
    const body =
      hurt && o.spriteHurt ? o.spriteHurt : healing && o.spriteHeal ? o.spriteHeal : o.sprite;
    contactScrim(ctx, R);
    // The rune is painted on the FLOOR, so it goes down before the character.
    drawAimRune(ctx, { R, aimAngle, hurt });
    drawPaintedWalk(ctx, {
      sprite: body,
      spriteFlash: o.spriteFlash,
      poseA: o.spritePoseA,
      poseB: o.spritePoseB,
      flash: o.hitFlash,
      motion: o.motion,
      hop: hopOf(o.motion),
      lean: leanOf(o.motion),
      mirror: o.motion?.mirror ?? 0,
      R,
      x: 0,
      y: 0,
      height: ART.height.wizard,
      foot: ART.foot.wizard,
    });
    // The staff is IN these bitmaps, gripped in the hand in every pose, because
    // a vector staff sweeping on its own arc is exactly what looked detached
    // from the character. What is left for the renderer is the aim read and the
    // cast flare, and both are anchored to the staff rather than being the staff.
    drawCastFlare(ctx, { R, castFlash, hurt });
    wizardStateOverlays(ctx, { R, time, healing, invuln });
    ctx.restore();
    return;
  }

  // Robe colours shift with state so damage and healing read instantly.
  const robeOuter = hurt ? '#6e1830' : healing ? '#1d5c3a' : '#2f4d8f';
  const robeInner = hurt ? '#a32846' : healing ? '#2f8a56' : '#3f5f9e';
  const trim = hurt ? '#ffb3c1' : healing ? '#9df5bd' : '#c1913a';

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
  drawWizardStaff(ctx, { R, aimAngle, castFlash, hurt, gripColor: robeInner });

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
  ctx.fillStyle = hurt ? '#b23a2e' : '#e8c07a';
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
  wizardStateOverlays(ctx, { R, time, healing, invuln });

  ctx.restore();
}

/**
 * A targeting rune on the floor, in the aim direction.
 *
 * This replaces the staff sweep as the directional read. Once the staff is part
 * of the painted poses it cannot also point anywhere, and a rune under the mage
 * is the anime-appropriate answer: it says where the next shot goes without
 * fighting the character art for the same pixels.
 */
function drawAimRune(ctx, { R, aimAngle, hurt = false }) {
  // Saturated ink, not a pale glow: the arena is a light cream, so the rune has
  // to be darker than what it sits on.
  const color = hurt ? '#d61f3f' : '#2f5da8';
  // Close in, at the feet: at R * 1.55 it read as a mark on the floor beyond the
  // mage rather than as his own targeting circle.
  const r = R * 1.02;
  const spread = 0.42;

  // Source-over, in a saturated colour: additive light cannot add anything to a
  // near-white arena, so as a glow the rune simply was not there.
  ctx.save();
  ctx.translate(0, R * 0.72);

  // The arc it will fire into.
  ctx.globalAlpha = 0.72;
  ctx.strokeStyle = color;
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.arc(0, 0, r, aimAngle - spread, aimAngle + spread);
  ctx.stroke();

  // A thin full ring, so it reads as a circle the mage is standing in even when
  // the bright wedge is pointing away from the viewer's eye.
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 0.95;

  // Three chevrons along it, the middle one brightest.
  for (const [t, alpha] of [
    [-0.6, 0.5],
    [0, 0.95],
    [0.6, 0.5],
  ]) {
    const a = aimAngle + spread * t;
    const cx2 = Math.cos(a) * r;
    const cy2 = Math.sin(a) * r;
    ctx.globalAlpha = alpha;
    ctx.save();
    ctx.translate(cx2, cy2);
    // Y-compressed like the rest of the 3/4 view, so the rune lies flat.
    ctx.scale(1, 0.55);
    ctx.rotate(a);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(R * 0.3, 0);
    ctx.lineTo(-R * 0.1, -R * 0.16);
    ctx.lineTo(-R * 0.1, R * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/**
 * The cast tell: a magic circle flaring at the mage's feet, and a bloom of light
 * over the body.
 *
 * This deliberately does NOT sit on the staff. The staff is part of the painted
 * poses, and the artist angled it differently in the idle pose than in the two
 * walking poses - so any fixed anchor for a crystal flare is wrong for some pose
 * and pops when the walk cycle swaps. A flare at the feet belongs to the
 * character rather than to a bitmap coordinate, so it is right in every pose.
 */
function drawCastFlare(ctx, { R, castFlash = 0, hurt = false }) {
  if (castFlash <= 0.01) return;
  const color = hurt ? '#e03a5c' : '#2f8fd8';

  ctx.save();
  // Ring on the floor, snapping outward as the spell leaves. Opaque, because
  // additive light does nothing on a bright arena.
  ctx.globalAlpha = 0.7 * castFlash;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 + 4 * castFlash;
  ctx.beginPath();
  ctx.ellipse(0, R * 0.86, R * (1.1 + (1 - castFlash) * 0.7), R * (0.42 + (1 - castFlash) * 0.26), 0, 0, TAU);
  ctx.stroke();

  // A wash over the body rather than added light.
  ctx.globalAlpha = 0.22 * castFlash;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, R * 1.4, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/**
 * The staff, swept toward the aim.
 *
 * Shared by both art paths and deliberately NOT painted: this sweep is the only
 * directional read the character has, and it has to keep pointing at whatever
 * the auto-aim picked. Compressing Y turns the sweep into an arc rather than a
 * flat spin, which is what sells the three-quarter perspective.
 */
function drawWizardStaff(ctx, { R, aimAngle, castFlash = 0, hurt = false, gripColor = '#3d4a86' }) {
  const reach = R * 1.65;
  const orbX = Math.cos(aimAngle) * reach;
  const orbY = Math.sin(aimAngle) * reach * 0.5 - R * 0.28;
  const gripX = orbX * 0.34 + R * 0.2;
  const gripY = orbY * 0.34 + R * 0.22;

  ctx.strokeStyle = hurt ? '#6b4a3a' : '#6d5a4a';
  ctx.lineWidth = R * 0.085;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(gripX - (orbX - gripX) * 0.35, gripY - (orbY - gripY) * 0.35);
  ctx.lineTo(orbX, orbY);
  ctx.stroke();

  // Hand on the shaft.
  ctx.fillStyle = gripColor;
  ctx.beginPath();
  ctx.arc(gripX, gripY, R * 0.14, 0, TAU);
  ctx.fill();

  // Staff orb: a small gem, not a torch. Against the painted characters the old
  // wide disc read as a flat balloon stuck onto the art, so the glow is tight
  // and the core stays small except in the moment after a cast.
  glowDisc(ctx, orbX, orbY, R * (0.26 + castFlash * 0.4), hurt ? '#ff6b81' : '#e8c07a', 0.22 + castFlash * 0.3, 2);
  ctx.fillStyle = castFlash > 0.05 ? '#ffffff' : hurt ? '#ffd0d8' : '#dff4ff';
  ctx.beginPath();
  ctx.arc(orbX, orbY, R * (0.1 + castFlash * 0.11), 0, TAU);
  ctx.fill();
}

/** Healing motes and the invulnerability bubble: drawn over either art path. */
function wizardStateOverlays(ctx, { R, time, healing, invuln }) {
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
}

// ── enemies ─────────────────────────────────────────────────────────────────

/** Dispatch to the right creature. `opts` carries the player position for facing. */
export function drawEnemy(ctx, e, opts) {
  if (e.type === 'wisp') drawWisp(ctx, e, opts);
  else if (e.type === 'brute') drawBrute(ctx, e, opts);
  else drawShade(ctx, e, opts);
}

/** SHADE - a hooded wraith. Leans toward the player, claws out. */
function drawShade(ctx, e, { time, px, py, sprite, spriteFlash }) {
  const R = e.radius * VIS.shade;
  const flash = e.hitFlash > 0;
  const body = flash ? '#ffffff' : e.color;
  const dark = flash ? '#ffd9e0' : '#3a0f1e';
  const bob = Math.sin(e.bob) * R * 0.12;
  const towards = Math.atan2(py - e.y, px - e.x);

  ctx.save();
  ctx.translate(e.x, e.y + bob);

  if (sprite) {
    groundShadow(ctx, R, 0.72, 0.2, 0.85);
    contactScrim(ctx, R);
    drawPaintedWalk(ctx, {
      sprite,
      spriteFlash,
      poseA: e.poseA,
      poseB: e.poseB,
      flash,
      motion: e.motion,
      hop: hopOf(e.motion),
      lean: leanOf(e.motion),
      mirror: e.motion?.mirror ?? 0,
      R,
      x: 0,
      y: 0,
      height: ART.height.shade,
      foot: ART.foot.shade,
    });
    ctx.restore();
    return;
  }

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
function drawWisp(ctx, e, { time, px, py, sprite, spriteFlash }) {
  const R = e.radius * VIS.wisp;
  const flash = e.hitFlash > 0;
  const body = flash ? '#ffffff' : e.color;
  const bob = Math.sin(e.bob * 1.3) * R * 0.22;

  ctx.save();
  ctx.translate(e.x, e.y + bob);

  if (sprite) {
    // The wisp floats, so its shadow sits well below it and stays faint.
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, R * 1.5, R * 0.5, R * 0.15, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
    // The wisp has no limbs to animate: it drifts, so it gets the lift and the
    // lean and none of the stepping.
    drawPainted(ctx, {
      img: flash ? spriteFlash : sprite,
      R,
      x: 0,
      y: 0,
      height: ART.height.wisp,
      foot: ART.foot.wisp,
      lean: leanOf(e.motion),
      mirror: e.motion?.mirror ?? 0,
      hop: hopOf(e.motion) * 0.5,
    });
    ctx.restore();
    return;
  }

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
function drawBrute(ctx, e, { time, px, py, sprite, spriteFlash }) {
  const R = e.radius * VIS.brute;
  const flash = e.hitFlash > 0;
  const plate = flash ? '#ffffff' : e.color;
  const shade = flash ? '#ffd9b0' : '#7a4210';
  const stomp = Math.abs(Math.sin(e.bob * 0.55)) * R * 0.08;

  ctx.save();
  ctx.translate(e.x, e.y - stomp);

  if (sprite) {
    groundShadow(ctx, R, 0.82, 0.22, 0.92);
    contactScrim(ctx, R);
    drawPaintedWalk(ctx, {
      sprite,
      spriteFlash,
      poseA: e.poseA,
      poseB: e.poseB,
      flash,
      motion: e.motion,
      hop: hopOf(e.motion),
      // A brute does not lean much; it is already committed.
      lean: leanOf(e.motion) * 0.5,
      mirror: e.motion?.mirror ?? 0,
      R,
      x: 0,
      y: 0,
      height: ART.height.brute,
      foot: ART.foot.brute,
    });
    ctx.restore();
    return;
  }

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
/**
 * The colour ladder a bolt is built from, darkest and largest first. Each rung
 * is the same silhouette filled at a smaller scale, so every rung but the
 * outermost keeps a hard rim of the one before it - which is what draws the
 * outline. Flat fills and hard edges are the whole point: this is the treatment
 * the cel-shaded cast gets, applied to a projectile, and it replaces a stack of
 * translucent additive discs that over a pale arena read as a smear rather than
 * as an object you could point at.
 */
const BOLT_RAMP = {
  fireball: [
    [1.0, '#4f1c07'],
    [0.86, '#8f3411'],
    [0.62, '#c24a1b'],
    [0.4, '#e09a3c'],
    [0.19, '#f6e6cb'],
  ],
  waterball: [
    [1.0, '#0f2c44'],
    [0.86, '#1d4d78'],
    [0.62, '#2f6fae'],
    [0.4, '#7fa8c4'],
    [0.19, '#dde8ec'],
  ],
  spark: [
    [1.0, '#3a2a18'],
    [0.8, '#8a6f42'],
    [0.5, '#ddcba2'],
    [0.24, '#fbf3e2'],
  ],
};

/** One rung of a bolt silhouette, in the bolt's local space (+x is forward). */
function boltSilhouette(ctx, kind, R, s, time) {
  if (kind === 'fireball') {
    // A comet: round head, flame plume tapering out behind it.
    const lick = 1 + Math.sin(time * 19) * 0.1;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.18 * s, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-R * 0.35 * s, -R * 1.0 * s);
    ctx.quadraticCurveTo(-R * 2.2 * s, -R * 0.72 * s, -R * 3.9 * s * lick, -R * 0.16 * s);
    ctx.quadraticCurveTo(-R * 2.4 * s, R * 0.1 * s, -R * 1.9 * s, R * 0.62 * s);
    ctx.quadraticCurveTo(-R * 1.5 * s, R * 1.12 * s, -R * 0.35 * s, R * 1.0 * s);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'waterball') {
    // A fat droplet: point at the back, plus three trailing beads.
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.16 * s, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-R * 0.4 * s, -R * 0.95 * s);
    ctx.quadraticCurveTo(-R * 2.3 * s, -R * 0.4 * s, -R * 2.6 * s, 0);
    ctx.quadraticCurveTo(-R * 2.3 * s, R * 0.4 * s, -R * 0.4 * s, R * 0.95 * s);
    ctx.closePath();
    ctx.fill();
    for (const [dx, dy, r] of [
      [-2.5, -0.5, 0.45],
      [-3.2, 0.28, 0.33],
      [-1.9, 0.72, 0.27],
    ]) {
      ctx.beginPath();
      ctx.arc(R * dx * s, R * dy * s, R * r * s, 0, TAU);
      ctx.fill();
    }
  } else {
    // SPARK: a lance. Longer and thinner than the recipe bolts, so the free
    // shot is never mistaken for one that cost mana.
    ctx.beginPath();
    ctx.moveTo(R * 2.15 * s, 0);
    ctx.lineTo(-R * 0.45 * s, -R * 0.86 * s);
    ctx.lineTo(-R * 1.75 * s, 0);
    ctx.lineTo(-R * 0.45 * s, R * 0.86 * s);
    ctx.closePath();
    ctx.fill();
  }
}

export function drawBolt(ctx, b, time) {
  const R = b.radius;
  const ramp = BOLT_RAMP[b.kind] ?? BOLT_RAMP.spark;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(Math.atan2(b.vy, b.vx));

  // Speed lines first, so they sit behind the body. Flat wedges, not blur.
  if (b.kind === 'spark') {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#cfe6ff';
    for (let i = 0; i < 3; i++) {
      const off = (i - 1) * R * 0.8;
      const len = R * (2.6 + i * 0.5);
      ctx.beginPath();
      ctx.moveTo(-R * 1.2, off);
      ctx.lineTo(-R * 1.2 - len, off);
      ctx.lineTo(-R * 1.2 - len * 0.7, off + R * 0.18);
      ctx.lineTo(-R * 1.2, off + R * 0.18);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  for (const [s, color] of ramp) {
    ctx.fillStyle = color;
    boltSilhouette(ctx, b.kind, R, s, time);
  }

  // One specular pip, which is what stops a flat fill reading as a sticker.
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(-R * 0.3, -R * 0.34, R * 0.3, R * 0.18, -0.6, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();
}

/** Enemy bolts: a hostile, sickly dart. */
export function drawEnemyBolt(ctx, b, time) {
  ctx.save();
  ctx.translate(b.x, b.y);
  // Same ink pass as the player's bolts.
  ctx.fillStyle = '#4b2f72';
  ctx.beginPath();
  ctx.arc(0, 0, b.radius * 1.15, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = '#241238';
  ctx.lineWidth = Math.max(1.5, b.radius * 0.28);
  ctx.stroke();
  ctx.globalAlpha = 1;
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
    // Crystalline wave: a cold front of ice with spikes growing off it.
    ctx.save();

    // First a DARK base, painted normally. The arena is a bright painted floor
    // now, and an additive-only effect disappears into it - the freeze has to
    // take light away from the ground it passes over before it adds any back.
    ctx.globalAlpha = 0.3 * life;
    ctx.fillStyle = '#0b2233';
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r * 0.99, 0, TAU);
    ctx.fill();

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = ring.color;
    ctx.globalAlpha = 0.18 * life;
    ctx.lineWidth = 34;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.9 * life;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();

    // Short needles just behind the front: the ice that has this instant formed.
    // They belong to the leading edge - run the full radius and the wave reads
    // as a starburst instead of a front.
    ctx.globalAlpha = 0.4 * life;
    ctx.strokeStyle = '#dff6ff';
    ctx.lineCap = 'round';
    const needles = 10;
    for (let i = 0; i < needles; i++) {
      const a = (i / needles) * TAU + time * 0.12;
      const inner = r * (0.8 + ((i * 7) % 5) * 0.035);
      ctx.lineWidth = 2.2 - (i % 3) * 0.5;
      ctx.beginPath();
      ctx.moveTo(ring.x + Math.cos(a) * inner, ring.y + Math.sin(a) * inner);
      ctx.lineTo(ring.x + Math.cos(a) * r, ring.y + Math.sin(a) * r);
      ctx.stroke();
    }

    // The crystal rind on the leading edge, drawn as CEL ice: a dark rim pass,
    // then two flat pale fills, all source-over.
    //
    // These spikes used to be additive and nearly white on a white-ish ring, so
    // on bright stone the front of the wave dissolved into a soft smudge instead
    // of reading as a wall of ice closing in. Three shrinking passes give each
    // wedge a hard dark edge like everything else on the board.
    ctx.globalCompositeOperation = 'source-over';
    const rind = life < 0.3 ? life / 0.3 : 1;
    const spikes = 30;
    for (const [inset, color] of [
      [0, '#1d5c86'],
      [3.4, '#bfe9ff'],
      [6.0, '#ffffff'],
    ]) {
      ctx.globalAlpha = rind;
      ctx.fillStyle = color;
      for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * TAU + time * 0.25;
        const len = 17 + Math.sin(i * 2.7 + time * 3) * 9;
        const w = 0.055;
        const r0 = r - inset * 0.6;
        const r1 = r + len - inset;
        if (r1 <= r0) continue;
        ctx.beginPath();
        ctx.moveTo(ring.x + Math.cos(a - w) * r0, ring.y + Math.sin(a - w) * r0);
        ctx.lineTo(ring.x + Math.cos(a) * r1, ring.y + Math.sin(a) * r1);
        ctx.lineTo(ring.x + Math.cos(a + w) * r0, ring.y + Math.sin(a + w) * r0);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    return;
  }

  if (ring.kind === 'nova') {
    // Explosion, drawn as a CEL blast.
    //
    // This was stacked additive lobes with a big white core. Over a dark arena
    // that read as fire; over a pale one, at a 172px radius, it added up to a
    // soft white hole that swallowed the screen - the larger it grew the less it
    // looked like anything. It is now a flat spiked silhouette filled through a
    // colour ramp, so it keeps a hard edge and a readable shape at any size, and
    // the hot core is small and deliberate rather than the whole middle.
    ctx.save();

    // starPath() traces around the origin, so the ring's own position has to be
    // applied here. Without this every nova in the game stacked in the arena's
    // top-left corner and the explosion appeared to be nothing but dust.
    ctx.translate(ring.x, ring.y);

    // A compressed, darker base so the fire has something to sit on. Warm brown,
    // not black: a black base at this radius punches a hole in the floor.
    ctx.globalAlpha = 0.38 * life;
    ctx.fillStyle = '#5a2a12';
    starPath(ctx, r, 9, 0.62, time * 0.3);
    ctx.fill();

    const ramp = [
      [1.0, '#7a2a0e'],
      [0.9, '#8f3411'],
      [0.72, '#c24a1b'],
      [0.5, '#d98b2e'],
      [0.31, '#e8c581'],
      [0.15, '#f6e6cb'],
    ];
    // The rungs must be OPAQUE, or they blend with each other instead of
    // stacking: six translucent layers of dark-to-light fire average out to a
    // muddy brown cloud, which is exactly what this was before. Opaque means
    // each rung hides the middle of the one beneath it and only its rim shows,
    // which is what draws the cel outline. The fade is therefore held off until
    // the last third of the life and then runs quickly.
    const a = life >= 0.3 ? 1 : life / 0.3;
    for (let i = 0; i < ramp.length; i++) {
      const [s, col] = ramp[i];
      ctx.globalAlpha = a;
      ctx.fillStyle = col;
      // Each rung is spiked a little differently and counter-rotates, so the
      // edge boils rather than reading as one static polygon.
      starPath(ctx, r * s, 9 + (i % 3), 0.6 - i * 0.02, time * 0.3 * (i % 2 ? -1 : 1) + i * 0.4);
      ctx.fill();
    }

    // Shrapnel wedges thrown clear of the fireball, on their own rotation.
    ctx.globalAlpha = 0.85 * a;
    ctx.fillStyle = '#8a3a16';
    const shards = 7;
    for (let i = 0; i < shards; i++) {
      const a = (i / shards) * TAU - time * 0.5;
      const w = 0.07;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9);
      ctx.lineTo(Math.cos(a + w) * r * 1.28, Math.sin(a + w) * r * 1.28);
      ctx.lineTo(Math.cos(a - w) * r * 1.2, Math.sin(a - w) * r * 1.2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (ring.kind === 'blast') {
    // The leading shockwave: a thin ring that outruns the fire, plus the
    // compression ring just behind it. Two circles is all a shockwave is.
    ctx.save();
    // A white shockwave is invisible on a near-white floor, so it is drawn as a
    // dark compression edge with the white ring riding on it.
    ctx.strokeStyle = '#7a5a30';
    ctx.globalAlpha = 0.5 * life;
    ctx.lineWidth = 6 + 10 * life;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.95 * life;
    ctx.lineWidth = 4 + 8 * life;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();

    ctx.globalAlpha = 0.45 * life;
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r * 0.82, 0, TAU);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (ring.kind === 'impactfire' || ring.kind === 'impactwater') {
    // Where an aimed spell lands.
    //
    // This used to be particles only, which is why a fireball connecting looked
    // almost identical to a fireball flying past. A single flat cel burst at the
    // contact point is what makes the hit a moment: a spiked star for fire, a
    // splayed crown for water, both built from hard-edged rungs so they carry an
    // outline like everything else on the board.
    const fire = ring.kind === 'impactfire';
    const rr = r * (0.62 + 0.38 * (1 - life));
    const ramp = fire
      ? [
          [1.0, '#7a2a0e'],
          [0.82, '#8f3411'],
          [0.56, '#c24a1b'],
          [0.3, '#e09a3c'],
          [0.13, '#f6e6cb'],
        ]
      : [
          [1.0, '#123f63'],
          [0.8, '#1d4d78'],
          [0.52, '#2f6fae'],
          [0.26, '#dde8ec'],
        ];

    ctx.save();
    ctx.translate(ring.x, ring.y);
    ctx.rotate(ring.seedAngle ?? 0);
    for (const [s, col] of ramp) {
      ctx.fillStyle = col;
      if (fire) starPath(ctx, rr * s, 7, 0.42, time * 0.5);
      else starPath(ctx, rr * s, 6, 0.66, time * 0.3);
      ctx.globalAlpha = life < 0.35 ? life / 0.35 : 1;
      ctx.fill();
    }
    ctx.globalAlpha = life;

    // Water throws beads clear of the crown; fire throws burning shrapnel.
    const bits = fire ? 5 : 6;
    for (let i = 0; i < bits; i++) {
      const a = (i / bits) * TAU + 0.4;
      const d = rr * (1.05 + (i % 3) * 0.13);
      const bx = Math.cos(a) * d;
      const by = Math.sin(a) * d;
      ctx.fillStyle = fire ? '#ffb056' : '#bfe6ff';
      ctx.beginPath();
      if (fire) {
        // A wedge, pointing the way it was thrown.
        const w = 0.1;
        ctx.moveTo(Math.cos(a) * rr * 0.9, Math.sin(a) * rr * 0.9);
        ctx.lineTo(bx + Math.cos(a + w) * rr * 0.2, by + Math.sin(a + w) * rr * 0.2);
        ctx.lineTo(bx + Math.cos(a - w) * rr * 0.2, by + Math.sin(a - w) * rr * 0.2);
        ctx.closePath();
      } else {
        ctx.ellipse(bx, by, rr * 0.11, rr * 0.15, a, 0, TAU);
      }
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (ring.kind === 'shockdust') {
    // The dust a blast kicks up: slow, wide, brown-grey, and it outlives the fire.
    ctx.save();
    ctx.globalAlpha = 0.34 * life;
    ctx.strokeStyle = '#6b5f52';
    ctx.lineWidth = 30 + 18 * (1 - life);
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();

    // Ragged inner edge, so it reads as a cloud rather than a drawn circle.
    ctx.globalAlpha = 0.22 * life;
    const puffs = 22;
    for (let i = 0; i < puffs; i++) {
      const a = (i / puffs) * TAU;
      const wob = 1 + Math.sin(a * 4 + i) * 0.16;
      ctx.beginPath();
      ctx.arc(ring.x + Math.cos(a) * r * wob, ring.y + Math.sin(a) * r * wob, 12 + (i % 4) * 4, 0, TAU);
      ctx.fillStyle = '#8d8378';
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (ring.kind === 'frostrim') {
    // The bright rim that leads the freeze, arriving a hair ahead of the body.
    ctx.save();
    // Same reason: a dark leading edge, so the bright rim has something to be
    // bright against.
    ctx.strokeStyle = '#1d4f7a';
    ctx.globalAlpha = 0.55 * life;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.9 * life;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.35 * life;
    ctx.strokeStyle = ring.color;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (ring.kind === 'heal') {
    ctx.save();
    // An opaque green ring first: additive-only healing was invisible over the
    // light patches of the bright arena, which is the worst possible spell to
    // fail silently.
    ctx.globalAlpha = 0.8 * life;
    ctx.strokeStyle = '#1f8a52';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, r, 0, TAU);
    ctx.stroke();

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
/** Deterministic 0..1 hash: decal detail must never come from Math.random,
 *  or the scorch would boil with a new shape every frame. */
function hash01(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * A mark left on the floor: explosion scorch, or the frost a freeze leaves.
 *
 * Drawn UNDER every entity, right after the arena, because that is what it is -
 * the floor has been changed. Nothing here is random per frame: the shape comes
 * from the decal's seeded `t`, and only the ember flicker animates, so the mark
 * stays put instead of crawling.
 */
export function drawDecal(ctx, d, time) {
  const k = Math.max(0, Math.min(1, d.ttl / d.maxTtl));
  // Hold full strength for the first half of the life, then fade out: a scorch
  // that starts fading the instant it lands never reads as having landed.
  const alpha = Math.min(1, k * 2.2);
  const seed = d.seed % 997;

  if (d.kind === 'scorch') {
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.rot);

    // Soot, in warm mid-values rather than black.
    //
    // On the old near-black arena a big opaque scorch read as damage. On pale
    // flagstone a near-black blot reads as a HOLE PUNCHED IN THE FLOOR, and it
    // out-shouts every character standing in it. Burnt stone is a desaturated
    // brown sitting a clear step below the stone, not a void - so the whole
    // decal is built from browns, and the point count is high enough that the
    // rim curves instead of showing the straight edges of a 13-gon.
    ctx.globalAlpha = 0.42 * alpha;
    ctx.fillStyle = '#6d5c4c';
    blobPath(ctx, 0, 0, d.r * 0.92, d.r * 0.78, 26, 0.13, seed);
    ctx.fill();
    // A slightly darker rim, which is what makes the edge read as charred
    // rather than as a soft smudge on the lens.
    ctx.globalAlpha = 0.3 * alpha;
    ctx.strokeStyle = '#3f342a';
    ctx.lineWidth = 3;
    ctx.stroke();
    // Heart of the burn: only a shade darker than the soot around it.
    ctx.globalAlpha = 0.3 * alpha;
    ctx.fillStyle = '#4a3d31';
    blobPath(ctx, 0, 0, d.r * 0.5, d.r * 0.44, 20, 0.16, seed + 3);
    ctx.fill();

    // Radial scorch streaks.
    ctx.globalAlpha = 0.22 * alpha;
    ctx.strokeStyle = '#33291f';
    ctx.lineCap = 'round';
    for (let i = 0; i < 11; i++) {
      const h = hash01(seed + i * 3.1);
      const a = (i / 11) * TAU + h * 0.5;
      const inner = d.r * (0.3 + h * 0.2);
      const outer = d.r * (0.7 + hash01(seed + i * 7.7) * 0.5);
      ctx.lineWidth = 1.5 + h * 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
      ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
      ctx.stroke();
    }

    // Embers still alive in the ash, burning down as the decal fades.
    ctx.globalCompositeOperation = 'lighter';
    const embers = 9;
    for (let i = 0; i < embers; i++) {
      const h = hash01(seed + i * 5.3);
      const h2 = hash01(seed + i * 11.9);
      const a = (i / embers) * TAU + h * 0.9;
      const rr = d.r * (0.18 + h2 * 0.6);
      const flick = 0.45 + 0.55 * Math.sin(time * (2.4 + h * 4) + i * 2.1);
      ctx.globalAlpha = alpha * k * flick * 0.85;
      ctx.fillStyle = '#ff8a3c';
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.85, 1.6 + h * 2.4, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = alpha * k * flick * 0.5;
      ctx.fillStyle = '#ffe6a8';
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.85, 0.8 + h, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (d.kind === 'frost') {
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.rot);

    // Rime: pale, wide, and palest in the middle.
    ctx.globalAlpha = 0.2 * alpha;
    ctx.fillStyle = '#cfeaff';
    blobPath(ctx, 0, 0, d.r * 0.95, d.r * 0.82, 24, 0.16, seed + 5);
    ctx.fill();
    ctx.globalAlpha = 0.16 * alpha;
    ctx.fillStyle = '#8fd4ff';
    blobPath(ctx, 0, 0, d.r * 0.62, d.r * 0.54, 20, 0.2, seed + 9);
    ctx.fill();

    // A frozen CRUST: a jagged rim of rime around the patch, and separate
    // crystals scattered inside it. Radiating needles from the centre looked
    // like a sunburst; frost on stone is a crust with growths on it.
    ctx.globalAlpha = 0.5 * alpha;
    ctx.strokeStyle = '#eaf7ff';
    ctx.lineWidth = 2;
    blobPath(ctx, 0, 0, d.r * 0.9, d.r * 0.76, 26, 0.1, seed + 13);
    ctx.stroke();

    ctx.globalAlpha = 0.6 * alpha;
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    const crystals = 11;
    for (let i = 0; i < crystals; i++) {
      const h = hash01(seed + i * 2.7);
      const h2 = hash01(seed + i * 6.1);
      const a = (i / crystals) * TAU + h * 1.4;
      const rr = d.r * (0.22 + h2 * 0.6);
      const cx2 = Math.cos(a) * rr;
      const cy2 = Math.sin(a) * rr * 0.86;
      const size = d.r * (0.05 + h * 0.06);
      ctx.lineWidth = 1 + h * 1.6;
      // Three crossing needles, each crystal rotated its own way.
      for (let j = 0; j < 3; j++) {
        const a2 = h * TAU + (j / 3) * Math.PI;
        ctx.beginPath();
        ctx.moveTo(cx2 - Math.cos(a2) * size, cy2 - Math.sin(a2) * size);
        ctx.lineTo(cx2 + Math.cos(a2) * size, cy2 + Math.sin(a2) * size);
        ctx.stroke();
      }
    }

    // Frost glitter, and it keeps catching the light while it lasts.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 14; i++) {
      const h = hash01(seed + i * 9.7);
      const h2 = hash01(seed + i * 4.3);
      const a = (i / 14) * TAU + h * 1.2;
      const rr = d.r * (0.2 + h2 * 0.72);
      const twinkle = 0.35 + 0.65 * Math.max(0, Math.sin(time * (1.6 + h * 2.8) + i));
      ctx.globalAlpha = alpha * k * twinkle * 0.85;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(Math.cos(a) * rr, Math.sin(a) * rr * 0.88, 1.2 + h * 1.6, 0, TAU);
      ctx.fill();
    }

    // A cold haze over the whole patch, so it reads as low ground mist.
    ctx.globalAlpha = 0.07 * alpha * (0.7 + 0.3 * Math.sin(time * 0.9));
    ctx.fillStyle = '#bfeaff';
    blobPath(ctx, 0, 0, d.r * 1.02, d.r * 0.88, 13, 0.2, seed + 21);
    ctx.fill();
    ctx.restore();
    return;
  }
}

/**
 * Draw a particle.
 *
 * `opts.ink` draws a slightly larger, flattened silhouette in a dark colour
 * instead of the particle itself. The renderer uses it as a base pass: on a
 * bright arena an additive spark is a pale smudge, so every glowing particle
 * gets an opaque mark under it first. See drawParticles() in render.js.
 */
export function drawParticle(ctx, p, opts = {}) {
  if (opts.ink) {
    const saved = { color: p.color, size: p.size };
    p.color = opts.inkColor ?? PARTICLE_INK[p.shape] ?? '#33415c';
    p.size = p.size * 1.35;
    drawParticleShape(ctx, p);
    p.color = saved.color;
    p.size = saved.size;
    return;
  }
  drawParticleShape(ctx, p);
}

/** Ink colours per particle shape: darker cousins of each effect's own colour. */
const PARTICLE_INK = {
  ember: '#8a2f10',
  spark: '#8a5a12',
  shard: '#1d5f86',
  droplet: '#1c5f96',
  crystal: '#2a6f96',
  mote: '#4a6a8f',
};

function drawParticleShape(ctx, p) {
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
    case 'spark': {
      // A hot streak along its own velocity: sparks read as fast, embers as slow.
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(p.vy, p.vx));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(size * 2.6, 0);
      ctx.lineTo(0, -size * 0.42);
      ctx.lineTo(-size * 1.5, 0);
      ctx.lineTo(0, size * 0.42);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      break;
    }
    case 'crystal': {
      // Six-sided ice crystal: three crossing needles.
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle ?? 0);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(1, size * 0.32);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const a2 = (i / 3) * Math.PI;
        ctx.moveTo(-Math.cos(a2) * size * 1.5, -Math.sin(a2) * size * 1.5);
        ctx.lineTo(Math.cos(a2) * size * 1.5, Math.sin(a2) * size * 1.5);
      }
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'smoke': {
      // A slow, expanding blot. Three offset discs, so it has no outline.
      ctx.globalAlpha = a * 0.34;
      ctx.fillStyle = p.color;
      for (let i = 0; i < 3; i++) {
        const a2 = (p.angle ?? 0) + (i / 3) * TAU;
        ctx.beginPath();
        ctx.arc(p.x + Math.cos(a2) * size * 0.5, p.y + Math.sin(a2) * size * 0.4, size * (1.1 - i * 0.18), 0, TAU);
        ctx.fill();
      }
      break;
    }
    case 'vapour': {
      ctx.globalAlpha = a * 0.26;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, size * 1.5, size * 1.05, (p.angle ?? 0) * 0.4, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 0.34, 0, TAU);
      ctx.fill();
      break;
    }
    case 'dust': {
      // Kicked-up grit: flat, wide, and gone quickly.
      ctx.globalAlpha = a * 0.4;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, size * 1.7, size * 1.05, Math.atan2(p.vy, p.vx), 0, TAU);
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
