/**
 * RUNE PRESSURE - input layer.
 *
 * Two thumbs, two zones:
 *   left  - a floating movement stick: press anywhere and a stick appears under
 *           the thumb. No fixed position to hunt for.
 *   right - the element wheel. Five circles: four elements and a centre.
 *
 * Taps register on pointer DOWN, not up. A sequence game is a rhythm game in
 * disguise, and waiting for the release adds latency the player can feel.
 *
 * The wheel's on-screen geometry is owned by the renderer (it is screen-space
 * layout), and this module hit-tests against it. One source of truth, so the
 * circles you see are exactly the circles you can press.
 */

import { STICK } from './config.js';
import { STATE } from './game.js';
import { ELEMENT_HOTKEYS } from './spells.js';

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export class Input {
  constructor({ canvas, renderer, game, onFirstInput }) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.game = game;
    this.onFirstInput = onFirstInput ?? (() => {});

    this.pointers = new Map(); // pointerId -> { role, ox, oy, x, y, buttonId }
    this.movePointerId = null;

    this.stick = { active: false, ox: 0, oy: 0, x: 0, y: 0, radius: 66 };
    this.stickRadius = 66;
    /** Visual press flashes: buttonId -> { ttl, max }. */
    this.presses = new Map();
    this.lastTap = null; // { id, ok, reason, t }
    this.keys = new Set();

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onContextMenu = (e) => e.preventDefault();
    this.onBlur = () => this.releaseAll();
  }

  attach() {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    c.addEventListener('pointermove', this.onPointerMove, { passive: false });
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('pointerleave', this.onPointerUp);
    c.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  detach() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
    c.removeEventListener('pointerleave', this.onPointerUp);
    c.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  localPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── pointer handling ──────────────────────────────────────────────────────

  onPointerDown(e) {
    e.preventDefault();
    this.onFirstInput();

    if (this.game.state !== STATE.PLAYING) {
      this.startOrRetry();
      return;
    }

    const pt = this.localPoint(e);
    const inMoveZone = pt.x < this.renderer.castZoneStart();

    if (inMoveZone && this.movePointerId === null) {
      this.movePointerId = e.pointerId;
      this.stickRadius = clamp(
        Math.min(this.renderer.w, this.renderer.h) * STICK.radiusFrac,
        STICK.radiusMin,
        STICK.radiusMax,
      );
      this.stick = {
        active: true,
        ox: pt.x,
        oy: pt.y,
        x: pt.x,
        y: pt.y,
        radius: this.stickRadius,
        deadZone: this.stickRadius * STICK.deadZone,
        magnitude: 0,
      };
      this.pointers.set(e.pointerId, { role: 'move', ox: pt.x, oy: pt.y, x: pt.x, y: pt.y });
      this.updateMoveVector();
      return;
    }

    // Casting half: hit-test the wheel and fire immediately on press.
    const hit = this.renderer.hitWheel(pt.x, pt.y);
    if (hit) {
      this.pointers.set(e.pointerId, { role: 'cast', ox: pt.x, oy: pt.y, x: pt.x, y: pt.y, buttonId: hit.id });
      this.fireTap(hit);
    }
    // A press that misses every circle is dead space, not a mistake. Ignore it
    // rather than punishing a stray thumb.
  }

  fireTap(button) {
    const result = button.kind === 'focus' ? this.game.tapFocus() : this.game.tapElement(button.elementId);
    this.presses.set(button.id, { ttl: 0.22, max: 0.22 });
    this.lastTap = { id: button.id, ok: result.ok, reason: result.reason, cast: result.cast ?? null, t: 0.3 };
    return result;
  }

  onPointerMove(e) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    e.preventDefault();
    const pt = this.localPoint(e);
    rec.x = pt.x;
    rec.y = pt.y;
    if (rec.role === 'move') {
      this.stick.x = pt.x;
      this.stick.y = pt.y;
      this.updateMoveVector();
    }
  }

  onPointerUp(e) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    this.pointers.delete(e.pointerId);
    if (rec.role === 'move' && this.movePointerId === e.pointerId) {
      this.movePointerId = null;
      this.stick.active = false;
      this.game.setMove(0, 0);
    }
  }

  releaseAll() {
    this.pointers.clear();
    this.movePointerId = null;
    this.stick.active = false;
    this.game.setMove(0, 0);
    this.keys.clear();
  }

  /**
   * Analog movement.
   *
   * Deflection is measured from where the thumb first landed. Inside the dead
   * zone the mage stands perfectly still; from there to the rim, speed ramps
   * continuously to 100%. Past the rim it stays at 100%, so over-dragging is
   * harmless and the control never "runs out".
   *
   * The old version returned a unit vector the moment you cleared a 9px dead
   * zone, which made the mage dart between two speeds and nothing else.
   */
  updateMoveVector() {
    const rec = [...this.pointers.values()].find((r) => r.role === 'move');
    if (!rec) {
      this.game.setMove(0, 0);
      this.stick.magnitude = 0;
      return;
    }
    const dx = rec.x - rec.ox;
    const dy = rec.y - rec.oy;
    const len = Math.hypot(dx, dy);
    const radius = this.stickRadius;
    const dead = radius * STICK.deadZone;

    if (len <= dead) {
      this.stick.magnitude = 0;
      this.game.setMove(0, 0);
      return;
    }

    const t = Math.min(1, (len - dead) / (radius - dead));
    const speed = STICK.response === 0 ? 1 : Math.pow(t, STICK.response);
    this.stick.magnitude = speed;
    this.game.setMove((dx / len) * speed, (dy / len) * speed);
  }

  // ── keyboard (desktop convenience; touch is the real input) ───────────────

  onKeyDown(e) {
    const key = e.key.toLowerCase();
    if (this.keys.has(key) && !ELEMENT_HOTKEYS[key]) return;
    this.keys.add(key);
    this.onFirstInput();

    if (key === ' ' || key === 'enter') {
      e.preventDefault();
      // Space is the centre circle: the panic button.
      if (this.game.state !== STATE.PLAYING) this.startOrRetry();
      else this.fireTap({ id: 'focus', kind: 'focus' });
      return;
    }
    if (ELEMENT_HOTKEYS[key]) {
      if (this.game.state === STATE.PLAYING) {
        const el = ELEMENT_HOTKEYS[key];
        this.fireTap({ id: el, kind: 'element', elementId: el });
      }
      return;
    }
    if (key === 'x') this.game.clearSequence();
    if (key === 'm') this.onToggleMute?.();
    if (key === 'v') this.onToggleHaptics?.();
    this.recomputeKeys();
  }

  onKeyUp(e) {
    this.keys.delete(e.key.toLowerCase());
    this.recomputeKeys();
  }

  recomputeKeys() {
    if (this.movePointerId !== null) return; // a thumb always wins over a keyboard
    let x = 0;
    let y = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) x -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) x += 1;
    if (this.keys.has('w') || this.keys.has('arrowup')) y -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) y += 1;
    this.game.setMove(x, y);
  }

  startOrRetry() {
    this.game.startRun();
    this.presses.clear();
  }

  // ── per-frame housekeeping ────────────────────────────────────────────────

  update(dt) {
    for (const [id, p] of this.presses) {
      p.ttl -= dt;
      if (p.ttl <= 0) this.presses.delete(id);
    }
    if (this.lastTap) {
      this.lastTap.t -= dt;
      if (this.lastTap.t <= 0) this.lastTap = null;
    }
  }

  hudState() {
    return {
      stick: this.stick,
      presses: this.presses,
      lastTap: this.lastTap,
    };
  }
}
