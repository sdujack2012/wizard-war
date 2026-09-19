# RUNE PRESSURE

**Tap the elements. Survive the wave.**

An action + puzzle arena game for Android and iOS. You are a rune mage in a
sealed circle. Enemies close in on a clock. You have no attack button — you cast
by **tapping the four elements in a remembered order**, and a wrong tap breaks
the spell you were building.

Zero dependencies. No build step. No binary assets. Pure ES modules + Canvas 2D.

---

## Quick start

```bash
npm start          # http://localhost:5173
```

Then open <http://localhost:5173>. To play on a real phone on the same Wi-Fi:

```bash
npm run dev        # binds 0.0.0.0 and prints your LAN URL
```

```bash
npm test           # 120 tests: recipes, sprites, haptics, rules, browser smoke
```

---

## How it plays

Landscape, two thumbs:

| Thumb | Zone | Verb |
| --- | --- | --- |
| Left (left 46% of the screen) | floating stick | **drag anywhere to move** — **tap the corner book** for the recipe reference |
| Right | the element wheel | **tap or drag through the circles** — **hold a circle** to repeat it, **hold the centre** to charge |

### Movement

Press anywhere on the left and a stick appears under your thumb. It is **analog**:
how far you push sets how fast you walk, from a standstill up to full speed.

```
thumb travel -> speed
     0px    0%
    11px    0%   <- dead zone: rest here and the mage holds position
    16px   12%
    25px   33%
    34px   51%   <- ~104 u/s, half speed
    44px   68%
    53px   84%
    62px  100%   <- full tilt, 232 u/s
    94px  100%   <- over-dragging past the rim is harmless
```

The dashed inner ring on the stick is the dead zone — it is drawn so that "how do
I stand still?" is answered by looking rather than by trial and error. The knob
turns grey at rest and cyan under tilt, so you can tell whether you are moving
without looking away from the arena.

This started out **digital**: any travel past a 9px dead zone meant full speed, so
the mage had exactly two states, standing still or sprinting, and nothing in
between. That reads as uncontrollable — you cannot creep up on a brute, ease off a
wall, or make a small correction while holding a line. `STICK.response` in
`src/config.js` controls the curve (`1` = linear, `<1` = finer near the centre,
`0` = back to digital).

### The wheel

```
            FIRE
             ▲
   WIND ◀   ✦   ▶ WATER        ✦ = SPARK (centre: tap, or HOLD to charge)
             ■
           EARTH
```

Five circles. The **centre** fires SPARK: weak, cheap, auto-aimed, always
available — tap it and it goes. **Hold** it instead and it winds up; let go and
the whole charge leaves in one heavier shot. The **four outer** circles are the
elements — tap them in a recipe order and a real spell goes off.

Shape carries meaning as well as colour (triangle, droplet, square, strokes), so
the wheel stays readable for colourblind players and at a glance under pressure.

### Casting by drag

A press on an element also opens a **stroke**: drag on across the wheel and every
element the thumb passes over registers once. `EARTH → FIRE → WATER` becomes one
sweep instead of three blind taps, which is worth having because that recipe is
314px of thumb travel on a 375px-tall phone — 84% of the screen height, executed
while your eyes are on the arena rather than the wheel.

The centre circle is **inert** during a stroke. It is the charge button, and the
straight line between two opposite elements crosses it, so a sweep over the
middle is a no-op rather than something to steer around.

### Repeating an element: hold it

Three of the five recipes open with the same element twice (`FIRE+FIRE+WIND`).
Rather than asking a thumb to leave a circle and come back mid-sweep, **hold the
circle**: it fires again every `STROKE.repeatMs`, so FIREBALL is one press, one
short wait, and one drag to WIND.

The wait is drawn as an arc inside the circle — the same idiom as the centre's
charge, and inside the edge so the target never grows — because an auto-repeat
nobody can see coming is an auto-repeat nobody can use. Each repeat rides the
ordinary `element` event, so it ticks and clicks exactly like a tap.

An over-long hold goes **inert** rather than cycling. `FIRE+FIRE+FIRE` leads
nowhere, so once the repeat can no longer extend the recipe, waiting simply stops
doing anything instead of breaking the sequence the player is still building.

### The spell book

A book icon sits in the bottom-left corner. Tapping it **freezes the wave** and
opens a card listing every recipe, what it costs, and how it is cast in words
("press FIRE, hold, drag to WIND"). Tapping a row **draws that gesture on the
wheel**, which stays live and unobstructed on the right — the card holds the left
of the screen precisely so the two never overlap.

It is a `STATE.SPELLBOOK` rather than a pause flag, so every system that already
refuses to act outside `PLAYING` — casting, spawning, the sequence's idle timer —
is frozen by construction instead of by one more condition that could be
forgotten. A partial recipe survives the visit, so you can check a recipe
mid-cast and come back to the same taps.

The gesture is drawn as a **path with numbered steps**, counted by *press* and not
by circle: `FIRE+FIRE+WIND` is three presses across two circles, so the first
badge reads `1,2` and the second reads `3`. Repeats collapse into one node
carrying a count, because a line from FIRE to itself is not a gesture. The
description in the row names the input rather than the elements, because "press,
hold, drag" is what the thumb has to do and "FIRE + FIRE + WIND" is only what it
means.

The path is drawn **over** the circles, not under them. Two of the five recipes
move between opposite elements, so their path runs straight through the centre
circle; underneath, the middle of that line was painted out by SPARK and the
sweep read as two disconnected stubs.

The demonstrated gesture is **animated, not a still diagram**: the path draws
itself, a head travels along it, and each circle rings as the thumb arrives. A
repeated circle visibly *waits* — its beat is `STROKE.repeatMs` long, exactly as
long as the real control makes you wait — which is the only way to show a hold as
a hold rather than as a symbol to decode.

### The drawn line

While the thumb is down, the wheel draws **the line the player actually drew** —
the raw finger path, with its curve and its overshoot, fading along its tail with
a dot at the head. This is deliberately not the same thing as the circle-to-circle
path: the snapped path says which circles were passed through, the drawn line says
what the gesture looked like, and the thumb itself is covering the evidence while
it happens.

The line is kept for `TRAIL.ttl` after the thumb lifts so it can fade rather than
vanish, and it is drawn **over** the wheel — the backing plate and the circles are
opaque enough to swallow it entirely otherwise.

Once the thumb is up, the snapped circle-path takes over again: the drawn line is
what you did, the path is what the game registered.

### The cast confirmation

When a spell fires, the circles that made it **light up in the order they were
pressed** (`SEQUENCE.castGlowDur`, staggered by `castGlowStagger`). A recipe is
three taps the player has to remember having made while watching the arena, and
the spell itself fires away from the wheel — so without this the reward for a
correct sequence is invisible at the moment it lands. It is also the only place
the game confirms the *order* rather than just the ingredients.

Duplicates are kept, not collapsed: `FIRE+FIRE+WIND` lights FIRE, FIRE, WIND, and
a recipe that has been reduced to a set would only be able to light FIRE once.

The glow runs on the spell's own clock, so it slows with the resolution beat it is
confirming — and holds still through the impact freeze.

The corner poses one problem worth naming: it is inside the walking zone. The
button is therefore a **click, not a press** — it only counts if the pointer goes
down and comes back up without travelling more than `clickSlopPx`, so a drag that
starts on the icon is a movement attempt and movement wins. A corner of the
walking zone must never become a trap.

### Charging the centre circle

The centre was the one control in the game with no depth: tap it as fast as the
cooldown allowed, and nothing else was ever true of it. Holding gives the
fallback a second mode without adding a sixth circle to learn.

Press and the wind-up starts; the charge ring fills inside the circle and the
price printed above it climbs with it, so you can see the shot you are buying
before you commit. Release and it fires.

| Hold | Shot | Cost |
| --- | --- | --- |
| under 0.12s | SPARK, exactly as it always was | 8 |
| 0.5s | roughly half the charge | ~27 |
| 0.9s and beyond | full charge: ~5.7× the damage, visibly fatter, faster, and it shoves | 46 |

Three deliberate rules:

- **A tap is still a tap.** Inside the 0.12s threshold nothing changes at all —
  same damage, same price, same cooldown. The centre circle is the panic button,
  and a panic button whose price depends on how long you happened to press it is
  not a panic button.
- **Holding buys burst, never efficiency.** A full charge returns 0.74 damage per
  point of mana; plain SPARK returns 0.75, WATERBALL 0.9, FIREBALL 1.08. If
  holding ever beat the recipes on throughput, "hold the centre forever" would
  become the optimal attack and the wheel would be decoration. A test asserts a
  fully charged SPARK never out-efficiencies a damage recipe.
- **The price is time, and it is real.** A second of standing still while the
  wave closes in, plus a longer cooldown (0.22s + up to 0.28s) — and the charge
  runs on *real* seconds, so slow motion and the hit-stop cannot stretch or stall
  it. It is the player's thumb being held down, not a simulation clock.

The wheel itself is the right thumb's control, so it sits hard right, clamped so
the outer circles are never clipped by the edge of the screen.

### The five spells

| Spell | Tap in order | | Cost | What it does |
| --- | --- | --- | --- | --- |
| **FIREBALL** | FIRE · FIRE · WIND | ▲▲≡ | 24 | Fast bolt, bursts on impact and catches what is beside the target. |
| **WATERBALL** | WATER · WATER · EARTH | ◆◆■ | 20 | Heavy orb. Hurts, shoves hard, and drenches (slows) what it hits. |
| **HEAL** | WATER · WATER · FIRE | ◆◆▲ | 26 | Restores 28 health. |
| **EXPLOSION** | EARTH · FIRE · WATER | ■▲◆ | 36 | Erupts around you. Big damage, falls off with distance, throws everything back. |
| **FREEZE** | WIND · WATER · EARTH | ≡◆■ | 30 | A cold wave sweeping outward. Little damage, but everything it touches crawls. |
| **SPARK** | *(centre circle)* | ✦ | 8–46 | Auto-aimed dart. Tap for the cheap one; hold to charge it up. |

### The grammar — this is what makes it learnable

```
two of a kind, then a third   ->  an AIMED spell
three different elements      ->  a spell that ERUPTS AROUND YOU
```

A player who has forgotten a recipe can still reason their way to the right
*shape*: "I need this to hit everything near me, so it has to be three different
elements." That is the difference between five arbitrary codes and a system.

### Why these exact orders

Every one of the four elements must be able to **start** a spell. If only water
and fire can open a recipe, half the wheel is dead as an opener and the first tap
carries almost no information. Fixing that needed no new ingredients — the two
radial spells are pure re-orderings of the same three elements:

- **EXPLOSION** was `fire, water, earth` → now **`earth, fire, water`**
- **FREEZE** was `water, wind, earth` → now **`wind, water, earth`**

Still steam and shrapnel; still water and cold wind. But now **EARTH and WIND can
open a spell too**, and all four first taps are distinct.

`HEAL`, `FIREBALL` and `WATERBALL` are exactly as specified.

### Haptic feedback

The wheel is a rhythm control you work while your eyes are on the arena, so a tap
has to confirm itself through the thumb rather than the eye. Without feedback a
mis-tap is silent, and you only find out when the spell you were building fails to
appear.

Every cue is short, because a 3-tap recipe has to land as **three separate ticks**
rather than one long rumble:

| What | Feel | Cue |
| --- | --- | --- |
| Element accepted | one crisp tick | `11ms` |
| Centre circle (SPARK) | lighter than an element | `8ms` |
| Charge begins | a light touch under the thumb | `6ms` |
| Charge full | a distinct double-tap, so you can release on feel | `12 · 30 · 16` |
| Sequence broken | a double thud, unmistakable | `26 · 42 · 26` |
| Not enough mana | a weak sputter, a dud | `8 · 32 · 8 · 32 · 8` |
| HEAL | a soft pulse | `18ms` |
| FIREBALL / WATERBALL | a solid pulse | `30ms` |
| EXPLOSION / FREEZE | a thump with an after-shock | `36 · 24 · 62` |
| Taking a hit | a sharp jolt | `22 · 14 · 34` |
| Wave cleared | a rising flourish | `12 · 40 · 12 · 40 · 34` |
| Overtime | an alarm | `46 · 52 · 46 · 52 · 46` |
| Death | heavy, and final | `95 · 50 · 180` |

Two details that matter more than the numbers:

- **Each cue has its own cooldown.** That is what keeps a fast combo reading as
  separate taps instead of one continuous buzz — without it, replays arrive faster
  than the actuator can settle and the whole sequence smears into mush.
- **The tap that completes a recipe gives the cast pulse, not a tick.** Two
  vibrations in the same millisecond would just fight each other, so the payoff
  *is* the confirmation for that tap. Three taps produce exactly three feedback
  events, never four.

**Platform reality.** This uses the Web Vibration API, which exists on Android
browsers and **does not exist on iOS Safari at all**. There is no web workaround
worth shipping. On iOS the game detects the absence, says `NO HAPTICS HERE` in the
HUD so you know it is the platform and not you, and plays on silently.

For iOS you need the native shell — and the hook is already there. `Haptics`
takes a driver, so swapping in `@capacitor/haptics` is six lines and touches no
game code. Drivers receive the **cue name** as well as the durations, precisely so
a native backend can map to its own vocabulary of impact styles instead of
imitating a millisecond pattern:

```js
import { Haptics as NativeHaptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
const heavy = new Set(['castHeavy', 'death', 'overtime']);
const error = new Set(['break', 'fizzle']);
api.haptics.setDriver(async (name) => {
  if (error.has(name)) return NativeHaptics.notification({ type: NotificationType.Error });
  return NativeHaptics.impact({
    style: heavy.has(name) ? ImpactStyle.Heavy
         : name === 'tick' || name === 'spark' ? ImpactStyle.Light
         : ImpactStyle.Medium,
  });
});
```

Press **`V`** to toggle it, and the choice is remembered between visits.

### Reading the wheel

The **recipe chart** sits bottom-left all through a run. As you tap, every spell
that is no longer compatible dims out. You can learn the wheel by watching the
list narrow instead of memorising a table — it is the single most important
teaching aid in the game. The three slots above the wheel show how many taps you
have entered, in colour.

### What a wrong tap costs

**Time, never health.** A tap that cannot lead anywhere breaks the sequence, locks
you out for 0.45s, and flashes `NO SUCH SPELL`. The wave clock keeps running.
That is the punishment: on a five-button pad, a fat finger should not be a health
bar event, but hesitation should still cost you.

An abandoned partial recipe quietly dissolves after 3 seconds, with no penalty —
changing your mind is not a mistake. And **the centre circle wipes any partial
recipe**, so SPARK doubles as the panic button when you have lost track: forget
the combo, just shoot.

That is the whole risk/reward. SPARK is always there and always weak. A real spell
is three taps you have to get right while a brute is chewing on you.

### Aiming

There is no aiming control. **Every aimed spell targets the nearest enemy**, and
only falls back to your facing direction when the arena is empty. The staff on the
mage shows where the next shot will actually go.

This is deliberate. The obvious alternative — aim along the way you are walking —
sounds fine until you try to strafe, because the movement vector overwrites your
facing every frame, so a spell cast while dodging flies off perpendicular to
whatever you meant to hit. On a touch screen with no second stick, auto-targeting
keeps the skill in the wheel, where it belongs, instead of in an invisible
requirement to stand still and face the right way.

---

## Visuals

The game ships **bright Japanese-cartoon bitmaps** for the things you look at
most — the arena floor, the wizard, the three enemy types and the corner braziers —
generated with `gpt-image-2.5-flare` and committed under `assets/` (1.7 MB total).
Every asset is cel-shaded with crisp ink outlines, saturated colour and high-key
lighting, because that is the register the whole game now plays in: the arena is a
sunlit duelling ground, not a dark chamber. Everything
else is still **procedural vector art**, and the vector art is still the fallback
for *every* painted asset: if an image is missing, still in flight, or refused by
the platform, that draw path falls back to its vector version and the game carries
on. That is not decoration — it is what lets the test suite (which has no image
loader at all) exercise the real renderer, and what makes the game playable from a
cold cache on a bad connection.

| Asset | Size | Replaces |
| --- | --- | --- |
| `floor.webp` | 1920×1080, 480 KB | the procedural flagstones, inscribed circle and glyphs |
| `wizard.png` + `-b`/`-c` | 168×320, ~99 KB each | the wizard's body, in three poses *(the staff is still vector — see below)* |
| `shade/b|shade/c`, `brute/b|brute/c` | ~300 px tall, ~150 KB each | the two step poses each creature walks with |
| `shade.png` / `wisp.png` / `brute.png` | ~300 px tall, 88–179 KB | the three enemy silhouettes |
| `brazier.png` | 153×160, 45 KB | the brazier bowl *(the vector pass on top is its firelight)* |
| `bgm.mp3` | 95 s, 1.9 MB | *nothing* — the game had no music at all before this |

**How they were made.** One shared art direction — dark fantasy, hand-painted,
deep indigo and teal shadows with warm amber accents — was reused verbatim in
every prompt, which is what keeps six separately generated images looking like one
game. Two model variants were trialled on the floor first; `flare` won on contrast.
Sprites were generated on a **transparent** background, trimmed to their content,
and sized to their on-screen budget by `build_assets.py`; the floor was cover-cropped
to the arena's 16:9 and stored as WebP. The raw output is not in the repo — only the
built assets.

**What the swap costs, honestly.** The project no longer holds the "zero image
files" property it used to, and the decoded floor is ~8 MB of RGBA in memory on a
phone. The floor is still drawn as one `drawImage` per frame, so the per-frame cost
is unchanged; the cost moved to load time and memory.

**The wizard.** A young anime mage in three-quarter view: bright royal-blue robe
with white and gold trim, a yellow sash, and a golden staff **held in his hand**.

The staff used to be vector art that swept toward the aim independently of the
sprite, which is exactly why it looked detached — the hand moved with the pose and
the staff did not. It is now part of every painted pose, gripped at the same angle
in all three, and the directional read moved to a **targeting rune** on the floor
at his feet: a thin circle with a heavy wedge in the aim direction, plus a flare at
his feet when a spell leaves. Both belong to the character rather than to a bitmap
coordinate, so they are correct in every pose — a crystal-anchored flare was tried
first and abandoned, because the artist angled the staff differently in the idle
pose than in the walking ones and the flare popped whenever the walk cycle swapped.

**Movement detail.** The walk cycle is driven by ground actually covered, so the
feet keep pace with the floor and stop when it does. The body lifts and squashes
through each step, tilts into its travel, and kicks up dust at every footfall.
The tilt and squash are deliberately small (`MOTION.lean` is 0.075 rad, not the
0.16 it started at): a three-quarter-view figure pivots around its feet, and a
bigger tilt read as tipping over rather than running. The two step poses are
cross-faded on a smoothstep so each pose holds flat and swaps quickly, because a
plain cosine fade spends the whole cycle with both half-visible and shimmers.

**Movement.** Nothing in this game slides any more. Each creature walks through a
three-bitmap rig: a neutral pose, left foot forward, right foot forward. Which one
is showing comes from **strides actually travelled**, not from a clock — the
simulation measures the ground each creature covered last frame and advances the
cycle by that, so the feet keep pace with the ground however fast it is going, and
they stop when it stops. A wraith shoved to a halt mid-knockback does not walk on
the spot, and a mage pressed into a wall does not run against it.

On top of the poses, the body lifts and stretches through the middle of a step and
squashes as the foot lands, tilts into its direction of travel, and kicks up a
small puff of dust at each footfall. The measured velocity drives all of it, so a
creature being shoved reads differently from one walking. `MOTION.*` in
`src/config.js` holds the cadence (`stride`), the lift, the lean, the squash and
the dust.

The cadence is a compromise worth naming: the mage covers 232 world units a
second, and a physically honest stride would put the feet through four and a half
steps a second — panicked scurrying. The tuned values give roughly three steps a
second at full speed. Feet slipping slightly is the price; the alternative, a
fixed cadence, is exactly the ice-skating this replaced.

**The enemies**, each with its own silhouette so they are identifiable at a glance:

| | Silhouette | Behaviour read |
| --- | --- | --- |
| **Shade** | Tattered hooded wraith, claws angled at you | Reaches toward you — it is coming |
| **Wisp** | Caged lantern with orbiting motes and a drifting tail | Floats and keeps its distance |
| **Brute** | Slab of armour, shoulder plates, glowing chest core | Heavy stomp bob, unmistakably slow |

**The spells.** Fire, water and arcane each leave a different fingerprint:
FIREBALL has a flickering flame tail and bursts into embers; WATERBALL is a
translucent orb with a droplet trail that splashes on impact; SPARK is a bright
dart. FREEZE sweeps a crystalline band with ice splinters growing off it;
EXPLOSION is a jagged fire ring around a white-hot core. Even the particles are
shaped per element — embers, splinters, droplets, motes — so a fire hit never
looks like an ice hit.

**Effects, and what they leave behind.** EXPLOSION and FREEZE are layered, and
both of them change the floor rather than just flashing over it:

| | During | After |
| --- | --- | --- |
| **EXPLOSION** | A white shockwave ring that outruns the fire, two turbulent fire lobes at different radii and spins, a white-hot core, sparks, embers, and a slow dust front | Rising smoke, and a **scorch** on the stone — a charred, irregular crater with embers still burning down inside it for nine seconds |
| **FREEZE** | A crystalline front with a bright leading rim, ice spikes on the edge, short needles forming just behind it, sublimating vapour, and crystal shards | **Frost** on the floor: a jagged rime crust with ice crystals grown across it and glitter that keeps catching the light, for seven and a half seconds |

Both ground marks are **inert**. They carry no damage, no slow and no collision —
they cannot even be collided with — so an after-effect can never quietly become a
balance change, and a test asserts exactly that. They are also capped
(`DECAL.max`), oldest-first, so a long run cannot accumulate them until the frame
budget dies.

One thing the painted floor forced: an additive-only effect vanishes into a bright
background. It was fine over the old flat dark grid, but over painted stone the
freeze now takes light *away* from the ground first (a dark base pass) before it
adds any back, and the explosion scorches its base into the floor the same way.

**The arena.** A stone-flagged ritual chamber: cracked slate, moss in the seams,
an inscribed circle of carved and inlaid runes, and four lit braziers at the
corners. Two dashed rings still turn against each other over the painting, and
drifting dust motes cross it, so the floor is not a still image. The light reddens
and a wash creeps in from the edges as the wave clock runs down.

The painted arena is much brighter than the flat grid it replaced, and its own
glowing ring was out-shining every character on it — the environment must never be
the brightest thing in a fight. `ART.floorShade` lays a 34% shade over it, and each
painted creature gets a soft dark scrim (`ART.contactShade`) because a painted
bitmap has neither the hard silhouette nor the flat fill that made the vector art
read against a background for free. Every one of those numbers is a tunable in
`ART`, next to the sprite heights and foot offsets that map each bitmap onto the
same footprint its vector version occupied.

### Music

The one audio **file** in the project: `assets/bgm.mp3`, a 95-second anime battle
theme written for this game with **YuE2** (T8star's YuE2-T8 ComfyUI suite on the
NUC), looped through the same master gain as the synthesised cues — so `M` mutes
it and the volume is one number. It loads on the first user gesture (browsers will
not start audio before one) and deliberately does not block anything: `resume()`
fires the fetch and moves on, and if the file is missing or will not decode, the
game plays exactly as it did before, with cues and no music.

Everything else in `audio.js` is still generated at runtime. The track is the
exception because a 95-second piece of music is not something a synthesiser in a
game loop should be asked to invent.

### Keeping it fast on a phone

- The detailed floor is rendered **once** into an offscreen canvas and blitted, so
  a rich background costs one `drawImage` per frame. If a platform refuses an
  offscreen surface, it falls back to drawing directly rather than failing. The
  painted floor skips the cache entirely — it is already one image.
- **Tinted sprite variants are built once, not per frame.** The white hit flash and
  the wizard's hurt/heal washes are `source-atop` composites cached on first use by
  `AssetStore.variant()`; a test asserts the cache is actually reused.
- **No `ctx.shadowBlur`** anywhere — it is brutally slow on mobile GPUs. Glow is
  faked with two or three translucent passes.
- **No gradient is created inside the frame loop**, and a test enforces it:
  allocating a gradient per object per frame is what turns smooth 60fps into a
  slideshow. The arena's gradients are built on resize only.
- A packed frame (20 enemies, 200 particles, three live rings) issues around
  **1,790 draw ops**, which a test keeps under a 6,000 ceiling.

---

## Progression

Waves escalate on a real-time clock. Clear the field before it runs out.

- Wave 1 opens with three **Shades** and 36 seconds.
- Wave 2 adds **Wisps** — ranged, they orbit at a standoff instead of charging.
- Wave 4 adds **Brutes** — slow, 78 HP, 40% damage reduction, 26 DPS on contact.
- Each wave shaves 1.35s off the clock. Let it hit zero and **the clock bites**:
  you take damage and reinforcements spawn on the spot.

Score is kills plus a clear bonus scaled by how much clock you had left.

---

## Project layout

```
index.html          shell; boots the module graph
styles.css          full-bleed canvas, mobile input hardening, safe-area insets
serve.mjs           zero-dependency static server (--host for on-device testing)

src/config.js       ALL balance and feel tunables - start here to retune
src/spells.js       the element wheel, the five recipes, sequence matching  [pure]
src/entities.js     entity factories + collision geometry                   [pure]
src/game.js         the simulation: waves, combat, casting, events          [pure]
src/rng.js          seeded PRNG, so a run can be replayed                   [pure]
src/sprites.js      all character, effect and background art (vector)       [pure]
src/assets.js       the painted-art store, loader and tint cache            [pure]
src/haptics.js      haptic cues, rate limiting, pluggable native driver
src/render.js       layout, wheel, HUD, recipe chart, floor cache
src/input.js        twin-zone pointer handling -> wheel taps -> Game API
src/audio.js        synthesised WebAudio cues (no audio files shipped)
src/main.js         bootstrap, main loop, event -> sound wiring

assets/             the painted bitmaps (floor, wizard, 3 enemies, brazier)

src/legacy/         RETIRED: the old freehand glyph-casting build. Unused by
                    anything in src/. Kept (with tests) because there is no
                    version control here. Safe to delete.

test/spells.test.mjs       recipes, grammar, sequence matching, charge curve
test/sprites.test.mjs      every sprite actually draws; no per-frame gradients
test/haptics.test.mjs      cue table, rate limiting, platform fallbacks
test/game.test.mjs         rules, spells, waves, failure modes, multi-seed bot
test/browser.test.mjs      fake-DOM suite driving real wheel taps
test/assets.test.mjs       the painted-art layer, and the vector fallback
test/legacy-glyph.test.mjs the retired stroke recogniser
```

`config.js`, `spells.js`, `entities.js`, `rng.js`, `sprites.js` and `game.js` have
**no DOM references at all**, which is why the entire rule set is testable in Node
and why the renderer cannot silently corrupt game state.

### The simulation is seeded

`new Game({ rng })` takes an injected generator, split into a **gameplay** stream
and a separate **cosmetic** stream. Gameplay and particles draw from different
streams on purpose: adding a particle or changing a burst size must never shift
where the next enemy spawns, or every balance change would silently reshuffle the
tests. `src/rng.js` also has `hashSeed('2026-02-14')` for shareable seeds — the
groundwork for a daily challenge is already in place.

---

## Tuning

Everything you would want to touch is in `src/config.js` and `src/spells.js`:

| What | Where |
| --- | --- |
| Stick size, dead zone, response curve | `STICK.*` in `src/config.js` |
| A spell's recipe | `SPELLS[].sequence` in `src/spells.js` |
| A spell's numbers and cost | `spellSpec()` and `SPELLS[].cost` |
| SPARK's power and cooldown | `spellSpec('spark')`, `SEQUENCE.sparkCooldown` |
| Charge time, power, price, cap | `CHARGE.*` in `src/config.js`, `chargedSparkSpec()` in `src/spells.js` |
| Break lock-out / idle dissolve | `SEQUENCE.breakLock`, `SEQUENCE.idleTimeout` |
| Wheel size and placement | `WHEEL.*` (all clamped, so it is thumb-sized everywhere) |
| Sprite sizes | `VIS` in `src/sprites.js` |
| The music track, its level and its fade-in | `MUSIC.*` in `src/audio.js` |
| Walk cadence, lift, lean, squash, footfall dust | `MOTION.*` in `src/config.js` |
| Painted art: sprite heights, foot offsets, lean, floor shade, brazier size | `ART.*` in `src/config.js` |
| Walk cadence, lift, lean, squash, footfall dust | `MOTION.*` in `src/config.js` |
| How long scorch and frost last, and how many can exist | `DECAL.*` in `src/config.js` |
| Which files the art layer loads | `ASSETS` in `src/assets.js` |
| Haptic patterns and strength | `HAPTICS.cues`, `HAPTICS.strength` in `src/config.js` |
| Wave curve and enemy stats | `WAVE.*`, `ENEMY.*`, `waveComposition()` |

**The recipe tests are a tripwire.** `test/spells.test.mjs` asserts each sequence
literally, plus that all four elements can open a spell and that the grammar
holds. Edit a recipe and the failing test tells you exactly what moved — which is
the point, because a recipe change silently breaks every player's muscle memory.

Two knobs to move together if you retune difficulty: `PLAYER.manaRegen` governs
how often you can cast at all, and the spell costs govern burst. Mana, not the
clock, is the real pace-setter.

---

## Shipping to Android and iOS

The prototype is a self-contained web app, so the shortest path to both stores is
[Capacitor](https://capacitorjs.com/) — it wraps this exact code in a native shell.

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init "Rune Pressure" com.yourstudio.runepressure --web-dir=.
npx cap add android
npx cap add ios
npx cap sync
npx cap open android      # builds in Android Studio
npx cap open ios          # builds in Xcode (macOS required)
```

Before you ship, two things this prototype does not do yet:

1. **Lock landscape** — `AndroidManifest.xml`
   (`android:screenOrientation="sensorLandscape"`) and the iOS target's
   *Supported Interface Orientations*.
2. **Suppress native text selection / callouts / pull-to-refresh.** Most of this
   is in `styles.css`; the native shell needs its own overrides.

**Enable haptics on iOS.** This is the one platform gap that actually costs you
game feel: the Web Vibration API does not exist on iOS Safari, so the wheel is
silent there. Install `@capacitor/haptics` and inject the six-line driver shown
under *Haptic feedback* above — `api.haptics.setDriver(...)`. No game code changes,
because the cue names are already being passed through. Do this before anything
else on the polish list; on a rhythm control it is worth more than better art.

If you would rather build natively: the simulation modules (`config`, `spells`,
`entities`, `rng`, `game`) are plain deterministic logic with no platform
coupling, so they port to **Godot 4** or Unity essentially line for line. Only
`render.js`, `sprites.js`, `input.js` and `audio.js` are web-specific. Godot 4 is
the better fit if you are solo and staying 2D.

---

## Test suite

```bash
npm test
```

120 tests, no dependencies, ~400ms:

- **Recipes** — each of the five sequences asserted literally; no duplicates and
  no prefix collisions; all four elements can open a spell; the doubled/radial
  grammar holds; `reachableSpells` narrows correctly as taps land; and **SPARK is
  asserted to be less mana-efficient than every aimed spell**, because if the
  fallback were the optimal attack the whole wheel would be decoration.
- **Sprites** — a recording canvas context counts what each sprite actually asks
  for, because a creature that silently draws nothing raises no exception and the
  smoke test would never notice. Every wizard state, all three enemy silhouettes,
  all three projectiles, all three ring kinds and all five particle shapes are
  asserted to put marks on the canvas, and the three enemy signatures are asserted
  to differ.
- **Rules** — every recipe casts and charges correctly; a partial recipe is held;
  a dead-end tap breaks the sequence *without* costing HP; every aimed spell
  auto-targets even while strafing; the stick is analog at both the simulation
  and pointer-event level; SPARK clears a partial recipe; fizzles when
  unaffordable; fireball blasts, waterball shoves and drenches, heal clamps at
  max HP, explosion falls off and shoves, freeze chills everything it sweeps.
- **Haptics** — the cue table is asserted to be complete and reachable in both
  directions (no event maps to a missing cue, no cue is unreachable), the power
  ordering is asserted by total buzz length, no duration can round down to zero
  (which `navigator.vibrate` would read as *cancel*), and the per-cue cooldown is
  driven with an injected clock. The browser suite then proves it end to end
  through real wheel taps, including a fake Android `navigator.vibrate`, a fake
  iOS with no API at all, and the `V` toggle persisting across a restart.
- **Browser smoke** — a Proxy-based fake 2D context that honours `save`/`restore`.
  Boots the real game, drives real pointer events at the wheel's reported
  coordinates, taps all five recipes, resolves multi-pointer taps, checks that
  dead space is ignored, verifies the floor cache and its no-offscreen fallback,
  and soaks 300 frames.
- **Multi-seed bot** — a scripted bot plays 90 seconds on five different seeds,
  using only legal taps. It runs on seeded worlds precisely so it can be swept:
  a bot test that passes on one lucky seed is not evidence of anything.

Bugs this suite has caught, all of which would have shipped:

1. `aimY || -1` treated a due-east aim as zero-length, silently rotating every
   horizontal cast 45° north.
2. Killing an enemy splices the enemy array, so an ascending `for...of` over it
   skipped the next enemy — area spells whiffed on stacked foes.
3. A tap produced a one-point stroke and the length guard ran first, so
   tap-to-cancel could never fire. *(retired mechanism)*
4. The minimum readable stroke size scaled with window height with no ceiling, so
   a maximised 1080p window demanded an 81px stroke and silently swallowed
   ordinary input. *(retired mechanism)*
5. The input layer passed the element **object** instead of its **id**, so every
   wheel tap looked like an illegal element and broke the sequence. `tapElement`
   now rejects unknown ids outright rather than treating a programming error as a
   player mistake.
6. SPARK was priced so that mashing the centre circle out-damaged every real
   spell, which would have made the entire wheel pointless. Its damage and cost
   are now pinned by a test.
7. **Aimed spells fired along the movement vector**, which `setMove` overwrites
   every frame — so a spell cast while dodging flew off perpendicular to the
   target and missed. Found by sweeping the bot across multiple seeds after the
   simulation was made seedable; a single-seed run had passed by luck.
8. **The movement stick was binary.** It normalised to a unit vector the moment
   you cleared a 9px dead zone, so the mage had two speeds and no control range.
   `setMove` now preserves magnitude and the stick maps deflection continuously
   from 0 to 100%; a test asserts that half deflection travels half the distance.
9. **Expired particles were still building a full path every frame**, just at zero
   alpha. The simulation spliced them on the next tick so it never showed, but it
   was pure waste in the loop that runs most often. Caught by a sprite test that
   asserts a dead particle draws nothing at all.
10. **A cancelled pointer threw the charged shot.** `pointercancel` shared a
    handler with `pointerup`, which was harmless while every wheel button fired on
    press — nothing was pending at release. Adding the charge made the two
    different things: a browser-cancelled pointer (system gesture, palm rejection,
    an incoming call) is the player having the input taken away, not the player
    letting go, and it must abandon the shot. Found on the first run of the new
    pointer-level tests.
11. **The WIND glyph drew nothing at all.** Every other element glyph is a closed
    shape that gets filled; WIND is three open strokes, and an open path has no
    area, so `fill()` silently marked nothing. The WIND circle had been sitting on
    the wheel looking empty and nobody had noticed. Caught by *looking at a
    screenshot* during the art pass, then pinned by a test that asserts WIND
    strokes and never fills.
12. **`drawPlayer` was defined twice** in the renderer, character-for-character
    identical. The later definition silently won, so the first was dead code that
    would have drifted out of sync with the second the moment anyone edited "the"
    method. Found while adding the painted sprite path to it.
13. **The painted sprite path overwrote `globalAlpha` instead of multiplying it.**
    The renderer fades a materialising enemy in by setting alpha and then calling
    `drawEnemy`, and the bitmap path assigned over it — so painted enemies popped
    into existence at full opacity while the vector ones faded. Found while adding
    the walk rig, by asking what the *caller* had already set.
15. **Every glow effect was invisible on the bright arena.** The whole FX
    language — bolts, glows, motes, firelight, the ritual rings — was written as
    *additive* light (`globalCompositeOperation = 'lighter'`), which is the right
    answer over a dark grid and adds literally nothing to a near-white floor. The
    projectiles became faint smudges, the corner braziers went dark and quiet, and
    the "time is nearly out" ritual ring stopped warning anybody. Each meaningful
    effect now lays down an opaque mark first and stacks the glow on top, and the
    particle pass splits opaque matter (dust, smoke, vapour, motes) from light.
    Nothing in the test suite could see this: only a screenshot could.
17. **The brazier sprite was never drawn at all.** The renderer cached it behind
    an `if (this._brazier === undefined)` guard, but the constructor initialised the
    field to `null` - so the lookup never once ran in the real game. The test that
    covered it *poked the field to `undefined`* first, which made the guard pass and
    the frame draw the sprite, so the suite was green while the game drew nothing.
    The cache is gone: it was a Map hit, and it bought a bug class instead.
18. **Enemies stepped on the clock, not the ground.** `e.bob += dt * 4` advanced at
    a fixed rate regardless of speed, so feet moved at the same rate whether a
    wraith was closing in, being knocked back, or pinned against a wall. The walk
    cycle is now driven by measured travel, and a test asserts that a mage walking
    into a wall stops moving its feet.

---

## Publishing

Live at **https://game.sdujack2012.win** — a static site behind the Traefik gateway
that already fronts the rest of `*.sdujack2012.win`.

```
docker compose up -d      # in the repo root; brings up the site
docker compose down       # takes it down
```

`docker-compose.yaml` runs `nginx-unprivileged` with the repo bind-mounted
**read-only** over the site root, and `deploy/nginx.conf` serves it with hard
caching for the art and music, revalidation for code, gzip, and dotfiles denied.
TLS is Traefik's, obtained through the same Cloudflare DNS-01 resolver as the other
subdomains — there is no certificate configuration in this repo, and the DNS record
is already covered by the wildcard.

Three things about this setup are load-bearing, and all three were found the hard
way:

- **`user: "1000:1000"` is not decoration.** `/services` is mode `750`, so a stock
  nginx container (uid 101) cannot traverse into the repo and would answer 403 for
  every request. Running as the owning uid is what makes the bind mount work, and
  it means the container has no more access than the repo's owner.
- **Do not add a `types { }` block to `deploy/nginx.conf`.** It does not extend the
  table inherited from `mime.types`, it replaces it — which served `index.html`,
  `src/*.js` and `styles.css` as `application/octet-stream`. A browser refuses an ES
  module with the wrong MIME type, so the game would not have started. The stock
  table already covers everything the page asks for.
- The site root genuinely contains `.git` (the repo is mounted straight in), which
  is why the config denies dotfiles. Without that rule the whole history is public.
- **Never serve art or music `immutable` from a stable filename.** These were served
  `max-age=2592000, immutable`, on the reasoning that art changes only when it is
  regenerated. That reasoning had a hole the size of a style pass: because the files keep
  their names, re-skinning the game left every returning player looking at the OLD sprites,
  and `immutable` tells the browser not to revalidate even on a normal reload. It cost a
  round of "the walk cycles are not updated" against a server that was serving the new ones
  perfectly. Art is now `no-cache, must-revalidate` (a 304 on the ETag, so it is cheap), and
  every asset URL carries `?v=ART_VERSION` from `src/assets.js`.

  Note which half fixed it. **Changing the header does not help anyone who already has the
  file** — their cached copy is already marked immutable, and only a URL change or a hard
  refresh displaces it. The version query is what reaches them; the header is what stops it
  recurring. Bump `ART_VERSION` whenever a file under `assets/` changes; two tests in
  `test/assets.test.mjs` assert that every URL is versioned, including the music.

## Front screens

The game boots to a **splash screen** (`STATE.SPLASH`): full-bleed key art, the logo,
and a prompt. It is also the loading screen, and the press that dismisses it is the
gesture that unlocks the audio context on mobile — which is why it is a deliberate press
rather than an auto-advance. One press moves on to the how-to-play screen, a second starts
the run.

The splash draws no gradients. Its scrims are baked into `assets/splash.webp` by
`tools/prepare-splash.py`, so the screen does not break the rule the browser suite holds
the frame loop to.

## Visual style

The cast is **Q-style / super-deformed chibi in a medieval setting** — about two and a half
heads tall, with an enormous head at roughly 45% of the figure height, in a castle courtyard
of wool, linen, leather and hand-forged iron. That is a readability decision at the
size the game draws (45–82 px), not only a taste one: a realistically proportioned face is
a handful of pixels at 73 px, while a chibi face reads as a face. See
`docs/art-direction-brief.md`, and `docs/asset-prompts.md` for the prompts, the rejected
attempts and why each was rejected.

## Known limits (deliberate, for a prototype)

- One music track and no sound *effects* assets — every cue is still synthesised
  at runtime (see `docs/spell-fx.md` for the cue design and how it is measured).
  There is no music *variation*: one loop for the title, the arena and the
  game-over screen, with no ducking, no intensity layer and no crossfade. The
  loop itself IS seamless, though — it is built that way by
  `tools/make-bgm-loop.py` rather than by hoping the generator ends cleanly.
- Spell audio has been verified as audible, distinct and correctly shaped by
  rendering every cue offline (`tools/render-cues.mjs`), but has never been
  listened to. Balance is measured; taste is not.
- No persistence beyond a best score in `localStorage`.
- No meta-progression, unlocks, or run variety. Waves are a fixed curve.
- Desktop keyboard shortcuts exist for testing (`WASD`, `1`-`4` for elements,
  `space` for SPARK — hold it to charge — `X` to clear, `M` mute, `V` haptics)
  but touch is the real input.
- Haptics are unavailable on iOS until the game runs in a native shell. That is a
  platform limit, not an oversight — see *Shipping*.
- Aiming is fully automatic. If you later want manual aim, the natural place is a
  right-thumb flick on the arena, but that competes with the wheel for the thumb.
- All recipes are three taps. The matcher is written for variable lengths, so
  shorter or longer spells need no code change — but a 2-tap spell would be a
  prefix of a 3-tap spell, and the resolver would need a "longest match, commit on
  timeout" rule instead of the current cast-on-match.
- No walk animation frames: the wizard leans and billows, but does not take steps.
  The painted sprites have the same limit for a different reason — they are single
  bitmaps, so motion comes from bobbing, leaning and mirroring, never from frames.
- Painted creatures have **three poses and no turning**. Facing left is the same
  bitmap mirrored, and the tilt is clamped to ±0.22 rad because rotating a
  three-quarter-view figure further reads as falling over. A real 8-way or
  skeletal rig would need a different art pipeline (cut-out parts, not poses).
- The walk poses are cross-faded rather than interpolated, so at the fastest
  speeds a step is a blend of two bitmaps rather than a real in-between.
- The staff and every spell effect are still vector art against painted
  characters. It holds up, but it is a seam — painting the staff would mean
  rotating a bitmap around the grip and losing the squashed 3/4 sweep.
- Balance is untested against real humans.

## Next, in the order I would do it

1. **Haptics + a music loop.** Biggest feel-per-hour available, and the element
   pitches are already tuned a fifth apart so recipes have a melody.
2. **An enemy that punishes a specific element**, so the recipes become a live
   tactical choice instead of a memorised combo.
3. **Rune unlocks between runs.** Start with three of the five spells, earn the
   rest. The recipe table supports it with no new systems.
4. **Daily seed** leaderboard. The simulation is already deterministic and
   seedable (`new Game({ rng })`, `hashSeed('2026-02-14')`), so this is now just
   a UI and a shared scoreboard — no simulation work left.
