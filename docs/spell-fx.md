# Spell effects: the visual and audio system

How the five spells and the charged centre circle look and sound, why the two
were built the way they are, and what was broken before.

Applies to `src/sprites.js` (the drawing), `src/game.js` (when each effect is
spawned) and `src/audio.js` (the cues).

## The visual language

The cast is cel-shaded: flat fills, hard edges, one dark outline. The spell
effects were not. They were stacks of translucent discs and additive glow —
which is what you draw over a dark arena, and which the arena stopped being when
the art direction moved to bright pale stone. Two consequences, both of which
looked like art bugs and were really the same bug:

- **Additive effects vanish.** Light added to an already-light floor is nothing.
- **Translucent stacks turn to mud.** Filling the same silhouette six times at
  0.8 alpha does not produce six tones, it produces an average of six tones.

So every spell shape is now built the same way, from a **colour ramp**: the
silhouette is filled once per rung, largest and darkest first, each rung at
**full opacity**. Each fill hides the middle of the one beneath it and leaves
only its rim showing, and that rim *is* the outline. This is the whole trick, and
it is why `starPath` and `boltSilhouette` exist as separate functions from the
colours they are drawn in.

A ramp drawn at a partial alpha is not a cel shape — it is the mud again. The
fade is therefore held to the last third of a ring's life and run quickly, so the
shape reads solid for as long as it is on screen and then dissipates.

### Per-spell

| Spell | In flight | On impact | On cast |
|---|---|---|---|
| SPARK | a flat lance with speed lines; grows and gains a body with charge | — | — |
| FIREBALL | comet: round head, flame plume, ink-outlined | spiked 7-point star + burning wedges | — |
| WATERBALL | fat droplet with three trailing beads | splayed 6-lobe crown + thrown beads | — |
| HEAL | — | — | green ring, rising motes, `+N` |
| EXPLOSION | — | — | spiked 9-point star through a 6-rung ramp + shrapnel |
| FREEZE | — | — | expanding front with a solid ice rind, rime decal left behind |

## Three bugs found while building this

**The scorch decal was a hole in the floor.** It was `#14100d` at 0.62 alpha over
a 132px radius, once per explosion, for nine seconds, up to 26 at a time. On the
old near-black arena that read as damage; on pale flagstone it read as a punch
through the playfield, and it out-shouted every character standing in it. It is
now built from warm browns a clear step below the stone (`#6d5c4c` at 0.42), at
92px for 5.5s, with a higher point count so the rim curves instead of showing the
straight edges of a 13-gon.

**The explosion drew in the corner of the world.** `starPath` traces around the
origin, and the nova block never translated to `ring.x, ring.y` — so every
explosion star in the game stacked at world (0,0) and what the player actually
saw was a cloud of dust near their feet. This is invisible in a code review and
obvious in one isolated render; `tools/` has no test for it, so the guard is the
`ctx.translate` comment.

**A fireball that missed looked exactly like one that hit.** The impact had
particles but no shape, and no sound at all. Both now exist.

## The audio

Everything is synthesised at runtime; the game ships one audio file and it is the
music track. Cues are built from four primitives in `Audio`: `blip` (one
oscillator, optional filter), `fm` (two-operator, for glass and metal), `noise`
(filtered burst) and the envelopes around them.

### Element signatures

Each element has a timbre, so a tap tells you *which* circle you hit and not just
that you hit one — and so the spells built from it inherit a family resemblance:

| Element | Voice |
|---|---|
| FIRE | sawtooth through a lowpass — a rasp |
| WATER | sine through a lowpass — round and hollow |
| EARTH | triangle through a low lowpass — dull, heavy |
| WIND | triangle through a bandpass — thin and airy |

The four are still pitched a fifth apart (`ELEMENT_PITCH`), so a recipe is also a
melody and a wrong tap is audible.

### Spell voices

- **FIREBALL** — filtered noise sweep over a falling saw, with a crackle riding behind.
- **WATERBALL** — a hollow gulp (`lowpass` + `bandpass`), landed on a low thump.
- **HEAL** — a warm pad under a glass arpeggio that keeps climbing; relief, not impact.
- **EXPLOSION** — four layers: a high crack transient, a sub, a noise body, and a
  rumble that outlives them. It reads as one event rather than a pile.
- **FREEZE** — FM. A struck-glass ring over a rising sine, with ice shards.
- **SPARK** — squares through a bandpass; past half charge it acquires a sub, so a
  full wind-up is felt as well as heard.
- **chargeFull** — two quiet notes a fifth apart when the wind-up completes.

### Impacts

`spell-hit` is emitted from the bolt-collision block in `game.js`, not derived
from the cast. That placement is the point: a projectile that misses never
reaches it, so the cue distinguishes a hit from a miss — which is most of why
casting previously felt like it happened in a different room from the fight.

## Verification

`npm test` covers the graph: 12 tests in `test/audio.test.mjs` assert that every
cue builds voices, that the five spells and three impacts are pairwise distinct
in the parameters they synthesise, that charge scaling is real, and that a muted,
unknown or throwing context fails soft. One more test pins `spell-hit` to an
actual collision, and to the *absence* of one when the shot misses.

Parameters are not samples, though, so `tools/render-cues.mjs` renders every cue
through an `OfflineAudioContext` and measures the output. Latest run:

```
cue             peak      rms   zcr/s  audible ms
fireball       0.068  0.00419     624         154
waterball     0.1053    0.009     135         147
heal          0.0731  0.00995     923         380
explosion      0.217  0.01877     312         363
freeze        0.1413  0.01026    1831         270
hitFire       0.0708   0.0027     150          59
hitWater      0.067  0.00417      81          67
hitIce        0.0989  0.00471     875         123
spark         0.1596  0.01065     380         200
```

It fails if any cue is silent, if a spell is as short as a tap, if a landing is
not shorter than its cast, or if two cues render to the same fingerprint
(peak / RMS / zero-crossing rate / duration). Zero-crossing rate is a crude
brightness proxy — enough to separate ice from earth, not a spectrum.

Nothing here has been listened to by a human. The measurements prove the cues are
audible, distinct and correctly shaped in time; whether they are *good* is a
judgement that still needs ears.

## Tuning

| What | Where |
|---|---|
| Scorch and rime size, lifetime | `DECAL` in `src/config.js` |
| Element pitches, music gain | `ELEMENT_PITCH`, `MUSIC` in `src/audio.js` |
| Cue re-trigger limits | `CUES` in `src/audio.js` |
| Which cue an event plays | `handleEvents` in `src/main.js` |
| Explosion radius, freeze radius | `spellSpec()` in `src/spells.js` |
