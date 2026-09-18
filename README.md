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
| Left (left 46% of the screen) | floating stick | **drag anywhere to move** |
| Right | the element wheel | **tap the circles** |

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
   WIND ◀   ✦   ▶ WATER        ✦ = SPARK (centre)
             ■
           EARTH
```

Five circles. The **centre** fires SPARK: weak, cheap, auto-aimed, always
available. The **four outer** circles are the elements — tap them in a recipe
order and a real spell goes off.

Shape carries meaning as well as colour (triangle, droplet, square, strokes), so
the wheel stays readable for colourblind players and at a glance under pressure.

### The five spells

| Spell | Tap in order | | Cost | What it does |
| --- | --- | --- | --- | --- |
| **FIREBALL** | FIRE · FIRE · WIND | ▲▲≡ | 24 | Fast bolt, bursts on impact and catches what is beside the target. |
| **WATERBALL** | WATER · WATER · EARTH | ◆◆■ | 20 | Heavy orb. Hurts, shoves hard, and drenches (slows) what it hits. |
| **HEAL** | WATER · WATER · FIRE | ◆◆▲ | 26 | Restores 28 health. |
| **EXPLOSION** | EARTH · FIRE · WATER | ■▲◆ | 36 | Erupts around you. Big damage, falls off with distance, throws everything back. |
| **FREEZE** | WIND · WATER · EARTH | ≡◆■ | 30 | A cold wave sweeping outward. Little damage, but everything it touches crawls. |
| **SPARK** | *(centre circle)* | ✦ | 8 | Weak auto-aimed dart. Needs no recipe. |

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

Everything is **procedural vector art** — real character sprites drawn with canvas
paths, still zero image files and zero dependencies. That keeps the whole game
shippable as-is and lets the art scale to any resolution from a 5" phone to a
desktop monitor.

**The wizard.** A hooded mage in three-quarter view so the face reads from any
facing. The cloak billows with a sine-driven hem and leans when you walk, the hood
holds two glowing eyes, and a staff sweeps on a squashed arc toward whatever the
auto-aim has picked — that sweep is the only directional read on the character, so
it does the job the old flat wedge did. The staff orb flares after every cast, so
you can see the mage *do* something even when HEAL resolves instantly.

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

**The arena.** A stone-flagged ritual chamber: seeded flagstones with bevels and
cracks, an inscribed circle with procedural glyphs, two dashed rings turning
against each other, four flickering braziers, and drifting dust motes. The light
reddens and a wash creeps in from the edges as the wave clock runs down.

### Keeping it fast on a phone

- The detailed floor is rendered **once** into an offscreen canvas and blitted, so
  a rich background costs one `drawImage` per frame. If a platform refuses an
  offscreen surface, it falls back to drawing directly rather than failing.
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
src/haptics.js      haptic cues, rate limiting, pluggable native driver
src/render.js       layout, wheel, HUD, recipe chart, floor cache
src/input.js        twin-zone pointer handling -> wheel taps -> Game API
src/audio.js        synthesised WebAudio cues (no audio files shipped)
src/main.js         bootstrap, main loop, event -> sound wiring

src/legacy/         RETIRED: the old freehand glyph-casting build. Unused by
                    anything in src/. Kept (with tests) because there is no
                    version control here. Safe to delete.

test/spells.test.mjs       recipes, grammar, sequence matching
test/sprites.test.mjs      every sprite actually draws; no per-frame gradients
test/haptics.test.mjs      cue table, rate limiting, platform fallbacks
test/game.test.mjs         rules, spells, waves, failure modes, multi-seed bot
test/browser.test.mjs      fake-DOM suite driving real wheel taps
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
| Break lock-out / idle dissolve | `SEQUENCE.breakLock`, `SEQUENCE.idleTimeout` |
| Wheel size and placement | `WHEEL.*` (all clamped, so it is thumb-sized everywhere) |
| Sprite sizes | `VIS` in `src/sprites.js` |
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

---

## Known limits (deliberate, for a prototype)

- No audio assets and no music — cues are synthesised, and there is no loop yet.
- No persistence beyond a best score in `localStorage`.
- No meta-progression, unlocks, or run variety. Waves are a fixed curve.
- Desktop keyboard shortcuts exist for testing (`WASD`, `1`-`4` for elements,
  `space` for SPARK, `X` to clear, `M` mute, `V` haptics) but touch is the real
  input.
- Haptics are unavailable on iOS until the game runs in a native shell. That is a
  platform limit, not an oversight — see *Shipping*.
- Aiming is fully automatic. If you later want manual aim, the natural place is a
  right-thumb flick on the arena, but that competes with the wheel for the thumb.
- All recipes are three taps. The matcher is written for variable lengths, so
  shorter or longer spells need no code change — but a 2-tap spell would be a
  prefix of a 3-tap spell, and the resolver would need a "longest match, commit on
  timeout" rule instead of the current cast-on-match.
- No walk animation frames: the wizard leans and billows, but does not take steps.
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
