/**
 * RUNE PRESSURE - input layer.
 *
 * Two thumbs, two zones:
 *   left  - a floating movement stick: press anywhere and a stick appears under
 *           the thumb. No fixed position to hunt for.
 *   right - the element wheel. Five circles: four elements and a centre.
 *
 * Element taps register on pointer DOWN, not up. A sequence game is a rhythm
 * game in disguise, and waiting for the release adds latency the player can
 * feel. The CENTRE circle is the one exception, and for a concrete reason: it is
 * held to charge (see CHARGE in config.js), so it can only fire when the thumb
 * comes off.
 *
 * A press that lands on an element also opens a STROKE: dragging on through the
 * wheel fires each element the thumb passes over, once. Three taps across a
 * 184px disc is a lot of blind travel on a phone, and the two radial recipes are
 * the worst offenders, so the gesture pays for itself exactly where the tap
 * scheme is weakest. See dragCast() for the rules and STROKE in config.js.
 *
 * The wheel's on-screen geometry is owned by the renderer (it is screen-space
 * layout), and this module hit-tests against it. One source of truth, so the
 * circles you see are exactly the circles you can press.
 */

import { STICK, STROKE, TRAIL, UI, WHEEL } from './config.js';
import { STATE } from './game.js';
import { ELEMENT_HOTKEYS, isLivePrefix, matchSequence } from './spells.js';

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
    /**
     * Who owns the centre circle's wind-up: a pointerId, or 'key' for space on
     * a desktop. Only the owner may release the shot, so a second thumb resting
     * on the centre cannot fire someone else's charge.
     */
    this.chargeOwner = null;

    /**
     * The live drag-through stroke, or null: { pointerId, last, armed, leftAt,
     * awayMax, holdMs }. `last` is the wheel button the stroke fired most
     * recently; `holdMs` is how long the thumb has rested on it, and the rest is
     * the re-arm bookkeeping described in dragCast().
     */
    this.stroke = null;

    /** A live press on the corner book icon: { pointerId, x, y, at }, or null. */
    this.bookPress = null;

    /**
     * The line the thumb has actually drawn: [{ x, y }, ...] in screen space,
     * newest last, plus the seconds it has left to live. Kept after the stroke
     * ends so the line can fade instead of vanishing under the thumb.
     */
    this.trail = [];
    this.trailTtl = 0;

    this.stick = { active: false, ox: 0, oy: 0, x: 0, y: 0, radius: 66 };
    this.stickRadius = 66;
    /** Visual press flashes: buttonId -> { ttl, max }. */
    this.presses = new Map();
    this.lastTap = null; // { id, ok, reason, t }
    this.keys = new Set();

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPointerCancel = this.onPointerCancel.bind(this);
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
    c.addEventListener('pointercancel', this.onPointerCancel);
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
    c.removeEventListener('pointercancel', this.onPointerCancel);
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

    if (this.game.state === STATE.SPELLBOOK) {
      this.onSpellBookDown(e);
      return;
    }

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
      // The book button lives in the walking corner, so its press is recorded
      // here and only cashed in on release if the thumb never travelled. A drag
      // that starts on the icon is a movement attempt, and movement wins: a
      // corner of the walking zone must never become a trap.
      if (this.renderer.hitSpellBook(pt.x, pt.y).kind === 'button') {
        this.bookPress = { pointerId: e.pointerId, x: pt.x, y: pt.y, at: performance.now() };
      }
      this.updateMoveVector();
      return;
    }

    // Casting half: hit-test the wheel.
    const hit = this.renderer.hitWheel(pt.x, pt.y);
    if (hit) {
      // The centre is held to charge and fires on release; the elements fire
      // here and now (see the header for why they differ).
      if (hit.kind === 'focus') {
        if (this.chargeOwner !== null) return;
        if (!this.game.beginCharge().ok) return;
        this.chargeOwner = e.pointerId;
        this.pointers.set(e.pointerId, { role: 'charge', ox: pt.x, oy: pt.y, x: pt.x, y: pt.y, buttonId: hit.id });
        return;
      }
      this.pointers.set(e.pointerId, { role: 'cast', ox: pt.x, oy: pt.y, x: pt.x, y: pt.y, buttonId: hit.id });
      // Landing on an element also opens a stroke: this press is the first tap,
      // and dragging on from here fires whatever else the thumb crosses.
      this.stroke = { pointerId: e.pointerId, last: hit, armed: false, leftAt: null, awayMax: 0, holdMs: 0 };
      // Start the drawn line at the press, so a tap still draws a dot's worth of
      // line rather than nothing.
      this.trail.length = 0;
      this.pushTrail(pt.x, pt.y);
      this.fireTap(hit);
    }
    // A press that misses every circle is dead space, not a mistake. Ignore it
    // rather than punishing a stray thumb.
  }

  /**
   * Release the centre circle. The shot is already committed, so where the
   * thumb ended up does not matter: dragging off the circle still fires.
   */
  releaseCharge() {
    if (this.chargeOwner === null) return null;
    this.chargeOwner = null;
    const result = this.game.releaseCharge();
    this.presses.set('focus', { ttl: 0.22, max: 0.22 });
    this.lastTap = {
      id: 'focus',
      ok: result.ok,
      reason: result.reason,
      cast: null,
      charge: result.charge ?? 0,
      t: 0.3,
    };
    return result;
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
    const fromX = rec.x;
    const fromY = rec.y;
    rec.x = pt.x;
    rec.y = pt.y;
    if (rec.role === 'move') {
      this.stick.x = pt.x;
      this.stick.y = pt.y;
      // Any real travel turns a corner press into a movement drag for good.
      if (this.bookPress && this.bookPress.pointerId === e.pointerId) {
        const S = UI.spellBook;
        if (Math.hypot(pt.x - this.bookPress.x, pt.y - this.bookPress.y) > S.clickSlopPx) {
          this.bookPress = null;
        }
      }
      this.updateMoveVector();
      return;
    }
    // Only the stroke needs the previous point, and the movement stick is the
    // hot path here, so the pair is built on the one branch that reads it.
    if (rec.role === 'cast') {
      this.pushTrail(pt.x, pt.y);
      this.dragCast(e.pointerId, { x: fromX, y: fromY }, pt);
    }
  }

  /**
   * Drag-through casting: carry on a stroke that began on an element.
   *
   * Fires every element circle the thumb sweeps through, once each, so
   * EXPLOSION becomes one arc instead of three blind taps. Two rules keep it
   * from fighting the tap scheme it sits on top of:
   *
   *   - The centre circle is INERT here. It is the charge button, and a drag
   *     between two opposite elements runs straight across it by design -
   *     EXPLOSION's first move is exactly that 184px sweep - so a hit on it has
   *     to be a no-op rather than something the player must steer around.
   *   - A circle may only fire again after the thumb has left its reach and come
   *     back, which is what makes the repeated-element recipes (FIRE+FIRE+WIND
   *     and friends) expressible as a gesture at all. Both a time and a distance
   *     gate have to pass; see STROKE in config.js.
   */
  dragCast(pointerId, from, to) {
    const st = this.stroke;
    if (!st || st.pointerId !== pointerId) return;

    // Re-arm bookkeeping, on the real pointer position and once per event.
    const last = st.last;
    if (last) {
      const reach = last.r * WHEEL.hitPadding;
      const over = Math.hypot(to.x - last.x, to.y - last.y) - reach;
      if (over > 0) {
        if (st.leftAt === null) st.leftAt = performance.now();
        if (over > st.awayMax) st.awayMax = over;
        // Leaving the circle also abandons a hold: the thumb is on its way
        // somewhere else, so it is not waiting for a repeat.
        st.holdMs = 0;
      } else {
        const long = st.leftAt !== null && performance.now() - st.leftAt >= STROKE.rearmMs;
        if (long && st.awayMax >= STROKE.rearmPx) st.armed = true;
        st.leftAt = null;
        st.awayMax = 0;
      }
    }

    // Walk the segment instead of testing its endpoint: a flick across a 130px
    // chord can arrive as one coalesced event, and sampling the path is what
    // stops a fast sweep from skipping the circles it actually crossed.
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.min(STROKE.maxSamples, Math.ceil(dist / STROKE.samplePx)));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const hit = this.renderer.hitWheel(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
      if (!hit || hit.kind !== 'element') continue;
      if (st.last && hit.id === st.last.id && !st.armed) continue;
      // A different circle consumes the re-arm window the last one had earned.
      st.last = hit;
      st.armed = false;
      st.leftAt = null;
      st.awayMax = 0;
      st.holdMs = 0;
      this.fireTap(hit);
    }
  }

  /**
   * Hold-to-repeat: waiting on a circle presses it again.
   *
   * This is the answer to the doubled element. Three recipes open with the same
   * element twice, and the alternatives are both worse: two blind taps of the
   * same circle, or leaving the circle and coming back mid-sweep. Waiting costs
   * nothing but the second STROKE.repeatMs of standing still, needs no aim, and
   * announces itself with the same tick a tap makes.
   *
   * It runs on the FRAME TICK, not in the pointer handler, and that is the whole
   * reason it works: a thumb held still emits no pointermove at all, so a timer
   * driven by movement would never fire for the one gesture it exists to serve.
   */
  updateStroke(dt) {
    const st = this.stroke;
    if (!st || !st.last) return;
    // A lock-out means the wheel is already telling the player "not now"; the
    // hold must not talk over it.
    if (this.game.seqLock > 0) return;

    st.holdMs += dt * 1000;
    if (st.holdMs < STROKE.repeatMs) return;
    st.holdMs = 0;

    // Only repeat while it still builds toward something, using the very test
    // tapElement applies. Without this, a thumb left resting on a circle cycles
    // FIRE, FIRE, broke, FIRE, FIRE... forever, which reads as a malfunction
    // rather than a rule. Stopping instead means an over-long hold is simply
    // inert, and moving on is what the player was going to do anyway.
    const next = [...this.game.sequence, st.last.elementId];
    if (!matchSequence(next) && !isLivePrefix(next)) return;

    this.fireTap(st.last);
  }

  /**
   * Record one point of the drawn line.
   *
   * Points closer together than a couple of pixels are dropped: a slow thumb
   * produces dozens of them in one spot, and they would spend the whole tail
   * budget on a blur instead of on the shape of the stroke.
   */
  pushTrail(x, y) {
    const last = this.trail[this.trail.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 2.5) {
      this.trailTtl = TRAIL.ttl;
      return;
    }
    this.trail.push({ x, y });
    if (this.trail.length > TRAIL.maxPoints) this.trail.shift();
    this.trailTtl = TRAIL.ttl;
  }

  endStroke(pointerId) {
    if (this.stroke && this.stroke.pointerId === pointerId) this.stroke = null;
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
    if (rec.role === 'cast') this.endStroke(e.pointerId);
    if (rec.role === 'charge' && this.chargeOwner === e.pointerId) this.releaseCharge();
    this.settleBookPress(e.pointerId);
  }

  /**
   * A corner press only becomes a click if it stayed put. The press that opened
   * the movement stick and the press that opens the book are the same press, so
   * the distinction has to be made at the END, on evidence, rather than guessed
   * at the start: the thumb is already down before anyone knows whether it means
   * to walk or to read.
   */
  settleBookPress(pointerId) {
    const p = this.bookPress;
    if (!p || p.pointerId !== pointerId) return;
    this.bookPress = null;
    const S = UI.spellBook;
    if (performance.now() - p.at > S.clickMaxMs) return;
    if (this.renderer.hitSpellBook(p.x, p.y).kind !== 'button') return;
    if (!this.game.openSpellBook()) return;
    this.presses.clear();
    this.stroke = null;
  }

  /**
   * The browser or the OS took the pointer away - a system gesture, palm
   * rejection, an incoming call. That is NOT the player letting go, so a
   * wind-up must be abandoned rather than thrown. Before the charge existed the
   * two were interchangeable, which is why this used to share onPointerUp.
   */
  onPointerCancel(e) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    this.pointers.delete(e.pointerId);
    if (rec.role === 'move' && this.movePointerId === e.pointerId) {
      this.movePointerId = null;
      this.stick.active = false;
      this.game.setMove(0, 0);
    }
    if (rec.role === 'cast') this.endStroke(e.pointerId);
    if (this.bookPress && this.bookPress.pointerId === e.pointerId) this.bookPress = null;
    if (rec.role === 'charge' && this.chargeOwner === e.pointerId) {
      this.chargeOwner = null;
      this.game.cancelCharge();
    }
  }

  releaseAll() {
    this.pointers.clear();
    this.movePointerId = null;
    this.stroke = null;
    this.bookPress = null;
    this.stick.active = false;
    this.game.setMove(0, 0);
    this.keys.clear();
    // A blur or a tab switch is not a release either: abandon the wind-up
    // rather than throwing a shot nobody asked for.
    if (this.chargeOwner !== null) {
      this.chargeOwner = null;
      this.game.cancelCharge();
    }
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
      // Space is the centre circle. Hold it to charge, let go to fire - the
      // same contract as the thumb, and the key-repeat guard above means the
      // wind-up cannot restart under a held key.
      if (this.game.state !== STATE.PLAYING) this.startOrRetry();
      else if (this.chargeOwner === null && this.game.beginCharge().ok) this.chargeOwner = 'key';
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
    // Desktop has no thumb to hold on a corner icon, so the book gets a key. B
    // toggles it, Escape closes it, and the recipe keys still work while it is
    // open - so a player can read a recipe and then try it without leaving.
    if (key === 'b') {
      if (this.game.state === STATE.SPELLBOOK) this.closeBook();
      else this.game.openSpellBook();
      return;
    }
    if (key === 'escape' && this.game.state === STATE.SPELLBOOK) {
      this.closeBook();
      return;
    }
    this.recomputeKeys();
  }

  onKeyUp(e) {
    const key = e.key.toLowerCase();
    this.keys.delete(key);
    if ((key === ' ' || key === 'enter') && this.chargeOwner === 'key') this.releaseCharge();
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

  /**
   * While the book is open the whole screen belongs to it - there is no world to
   * touch. Rows select a recipe to watch; the card is deliberately inert
   * everywhere else so a mis-tap while reading does not lose the page; only the
   * explicit close, or a tap off the card, shuts it.
   */
  onSpellBookDown(e) {
    const pt = this.localPoint(e);
    const hit = this.renderer.hitSpellBook(pt.x, pt.y);
    this.presses.clear();
    if (hit.kind === 'row') {
      this.game.selectSpell(hit.row.id);
      this.presses.set(`book:${hit.row.id}`, { ttl: 0.22, max: 0.22 });
      return;
    }
    if (hit.kind === 'close' || hit.kind === 'scrim') this.closeBook();
  }

  closeBook() {
    if (!this.game.closeSpellBook()) return;
    this.presses.clear();
    this.stroke = null;
    this.bookPress = null;
  }

  /**
   * The primary action, whatever the current screen makes of it.
   *
   * On the splash it advances to the how-to-play screen instead of starting a
   * run, so the first press is never a surprise. This is also the press that
   * unlocks the audio context (see onFirstInput), which is why it must be a real
   * gesture rather than an auto-advance.
   */
  startOrRetry() {
    if (this.game.dismissSplash()) {
      this.presses.clear();
      return;
    }
    this.game.startRun();
    this.presses.clear();
  }

  // ── per-frame housekeeping ────────────────────────────────────────────────

  update(dt) {
    this.updateStroke(dt);
    if (this.trailTtl > 0) {
      this.trailTtl -= dt;
      if (this.trailTtl <= 0) this.trail.length = 0;
    }
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
      // Progress of a hold-to-repeat, so the renderer can show the second tap
      // coming. An auto-repeat with no warning reads as a malfunction.
      dwell: this.stroke && this.stroke.last
        ? { id: this.stroke.last.id, k: Math.min(1, this.stroke.holdMs / STROKE.repeatMs) }
        : null,
      // The drawn line, and how much of its life is left, so it fades out rather
      // than disappearing the instant the thumb comes off.
      trail: this.trail.length > 1 ? this.trail : null,
      trailFade: this.trailTtl > 0 ? Math.min(1, this.trailTtl / (TRAIL.ttl * 0.6)) : 0,
    };
  }
}
