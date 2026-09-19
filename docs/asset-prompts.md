# Generation record

Every shipped bitmap in `assets/` is traceable to a raw model output in `art/raw/`, a
prompt in `art/specs/`, and a deterministic normalization step. This file is the
human-readable half of that record; `assets/asset-manifest.json` is the machine-readable
half.

## Pipeline

1. Prompt written as a structured brief — role, subject, view, art direction,
   game-scale read, technical output, locks, exclusions.
2. `tools/gen-image.py art/specs/<spec>.json` → raw output in `art/raw/`.
   Alternate poses go through `tools/gen-pose.py`, which posts the approved seed to the
   edits endpoint so identity, costume and scale survive the pose change.
3. `tools/normalize-sprites.py` → the shipped frame in `assets/`. This is the only step
   that decides scale, ground line and canvas size; geometry is written to
   `art/normalize-report.json`.
4. `scripts/asset_report.py` (from the `create-game-assets` skill) → measured gate.
5. Judged in-engine at native scale over the real playfield, never at source resolution.

## Step 3 matters more than it looks

`drawPainted` in `src/sprites.js` sizes a bitmap by height and derives its **width from
the image's own aspect ratio**:

```js
const w = ((R * height) / img.height) * img.width * (2 - stretch);
```

So every pose of a creature must share one canvas size. The first walk set shipped at
154 / 234 / 245 px wide on a 320 px canvas, which would have widened the wizard's body by
up to 60 % mid-stride. `tools/normalize-sprites.py` now guarantees one canvas, one body
height (300 px of a 320 px canvas) and one ground line for the idle pose and both step
poses, so the renderer can only ever translate the bitmap.

The anchors are measured rather than assumed: the ground line is the lowest opaque row,
the body height runs from there up to the top of the hood — found as the first row whose
last opaque run is wide enough to be a head rather than the staff — and the body centre is
the mean x of that head run. Frames are rescaled to a common body height and re-placed on
a common ground line and centre.

## Generation parameters

| | |
|---|---|
| Endpoint | `POST https://api.openai.com/v1/images/generations` (seeds), `POST https://api.openai.com/v1/images/edits` (poses) |
| Model | `gpt-image-2.5-flare` |
| Output | `png`, `n: 1`; seeds with a figure use `background: transparent` |
| Credentials | `~/.hermes/credentials/openai-image.json` — not in this repository |

## Prompts

### `art/specs/01-wizard-seed.json` — the approved visual target

The single image every other actor is built from. Nothing else may be produced until this
one is signed off, or the cast drifts into several different visual systems.

```text
ROLE/PURPOSE: player character seed asset for a fixed top-down arena game; the single approved visual target the rest of the cast is built from.
SUBJECT: a young mage standing in a neutral idle pose, holding a staff in one hand, feet together on the ground.
VIEW: fixed three-quarter view from above (camera roughly 55 degrees above the horizon), body facing the viewer, standing upright, symmetrical stance, no lean, no motion.
ART DIRECTION: cel-shaded anime; FLAT 2-3 tone shading, hard terminator between light and shadow, single key light from upper-left, cool ambient fill; 2px dark desaturated indigo ink outline around the whole silhouette only (no interior line noise); saturated royal blue and white robe with gold trim; glowing cyan staff crystal as the single brightest accent in the image.
GAME-SCALE READ: the whole figure is drawn 64 pixels tall on screen. Silhouette priority, in order: the hood, the staff and its crystal above the shoulder line, the robe hem flare. These must stay separated from the body mass and must not merge at 64 pixels.
TECHNICAL OUTPUT: square, TRANSPARENT background (real alpha channel), single isolated figure, centred, with a small even margin on all four sides, whole body inside the frame including feet.
LOCKS: three-quarter top-down camera, upright stance, blue/white/gold palette, ink outline weight, upper-left key light.
EXCLUDE: cast shadows on the ground, ground plane, scenery, props, second characters, text, labels, UI, frames, mockup chrome, watermark, signature, cropped or cut-off limbs, motion blur, dramatic pose.
```

### `art/specs/02-wizard-walk-strip.json` — step poses

An edit of the seed. The model was asked for a three-frame strip and for the frames to be
evenly spaced on a shared baseline; it delivered that, which is what makes the gutter-based
slice in step 3 reliable.

```text
Image 1: an anime cel-shaded mage in a blue and white robe with gold trim, holding a tall staff with a glowing cyan crystal, standing in a neutral idle pose, seen from a fixed three-quarter top-down view.

Instruction: Draw ONE horizontal sprite strip of this EXACT same character, showing a three-frame walk cycle in a single row, left to right, evenly spaced, all three figures the SAME height, the SAME scale, the SAME camera angle, standing on the SAME invisible baseline, with clear empty gaps between them so each frame can be cut out. Frame 1 (left): neutral contact pose, feet together, exactly like Image 1. Frame 2 (middle): mid-stride with the left leg forward and the free arm swung forward. Frame 3 (right): mid-stride with the right leg forward and the free arm swung back. The staff stays gripped in the same hand at the same angle in all three frames.

Keep identical: costume, colours, the 2px dark ink outline, flat cel shading, the single upper-left key light, the glowing cyan staff crystal, and the transparent background. No ground, no shadows, no frame borders, no numbers, no labels, no text.
```

The strip did not fully honour "the same height": measured body heights were 568 / 582 / 584
px, and the poses differ by a few pixels of horizontal placement. Step 3 absorbs both, which
is why the frames are sliced from one strip and re-normalized rather than used as generated.

### `art/specs/03-playfield.json` — arena floor

```text
ROLE/PURPOSE: environment playfield for a fixed top-down arena game; the background every character and projectile is read against.
SUBJECT: an empty circular duelling ground of pale weathered flagstone, with an inscribed ritual circle CUT INTO the stone.
VIEW: directly overhead, orthographic top-down, no perspective, no horizon.
ART DIRECTION: cel-shaded anime; LOW CHROMA pale stone (value 68-80 percent, saturation under 15 percent); NO ink outlines on the stone; flat 2-tone shading only. The ritual circle is a TONAL STONE INLAY only - engraved grooves and slightly darker and lighter slabs, roughly 8-14 percent darker than the surrounding stone, with NO glow, NO colour, NO light emission. The vivid saturated colour in this game belongs to the characters and spells drawn on top, so the floor must not compete with them.
GAME-SCALE READ: at 1280x720 this whole image sits behind 45-80 pixel tall characters. It must read as quiet, even, walkable ground. It must NOT draw the eye.
TECHNICAL OUTPUT: 3:2 landscape, opaque, edge-to-edge surface, no transparency.
LOCKS: pale cool-grey and cream stone, muted sage moss in the seams, flat even lighting from upper-left, no hotspots, concentric ring layout centred in frame.
EXCLUDE: glowing lines, neon runes, luminous sigils, gemstones, braziers, torches, fire, any light source, any character or creature, strong cast shadows, high-contrast cracks, text, labels, UI, borders, frames, vignette.
```

The first attempt is kept for comparison at `art/raw/rejected-floor-v2.png`. It measured a
playfield mean luminance of 216.6 with a standard deviation of 27.5 — brighter than most of
the cast, and too varied to sit behind it. The shipped floor measures a mean of 185.6 and a
standard deviation of 17.4. The rejected variant is not referenced by any code.

## Building the rest of the cast

The remaining four actors were produced only after the target was signed off, and each was
posted to the edits endpoint with the **approved seed as the reference image**, so identity,
camera, outline weight and light direction carry across mechanically rather than by hoping a
text prompt reproduces them. The prompts are `art/specs/04-cast-base.json` (shade, wisp,
brute, brazier), `art/specs/05-cast-strips.json` (shade and brute hover/walk cycles),
`06-cast-retry.json` and `07-shade-strip-v2.json`. Each shares one fixed preamble:

> Image 1 is the approved visual target for this game's cast: an anime cel-shaded character
> with a 2px dark indigo ink outline, flat 2-3 tone shading with a hard light terminator, a
> single key light from the upper-left, cool ambient fill, and a fixed three-quarter view from
> above (camera about 55 degrees above the horizon). … Match Image 1's rendering style,
> outline weight, shading model, light direction and level of detail precisely.

Each creature then keeps the hue the game's config already assigned it — shade `#ff5c7a`,
wisp `#c58bff`, brute `#ffa33d` — so the colour language survives the restyle.

### The shade retry

The first shade brief asked for a *tall narrow taper*, because the creature is a fast melee
wraith and that seemed like the right read. It is not, at this size. The pipeline scales a
sprite by height, so a narrow source becomes a narrow sprite, and at the 51 px the game draws
it the result was a 26 px-wide smudge where the art it replaced had been a 45 px-wide
creature. Squinting at source resolution would never have caught this; it was only visible
against the real floor at true drawn size.

The v2 brief therefore makes **silhouette aspect the primary requirement**, and says why:

> SILHOUETTE - THIS IS THE MOST IMPORTANT REQUIREMENT. The creature must be ABOUT AS WIDE AS
> IT IS TALL, filling a roughly square area and touching all four sides of that square. A
> previous attempt was drawn tall and narrow and became an unreadable smudge at the size the
> game draws it, so width is essential.

The wisp failed the same way for a subtler reason: its orbiting shards stuck out above and
below the flame body, which stretched the total measured height and therefore shrank
everything else once the sprite was scaled to fit. Its v2 brief keeps the shards *inside the
body's width* and forbids anything from extending the total height.

Both v2 attempts were re-briefed, not re-rolled blindly, and both read correctly at native
size. The brute and the brazier passed on their first attempt and were kept.

### The brazier's draw box

`render.js` draws the brazier with `drawImage(bowl, x, y, w, h)`, which forces **both**
dimensions from `ART.brazier` (82×104). Every other sprite has its width derived from its own
aspect ratio; this one does not. So for the brazier the canvas aspect has to equal the box
aspect or the art is stretched — the normalizer takes `--box 82x104` and pads with transparent
columns to reach 0.7875 rather than squashing the flame. The asset it replaced was 153×160 in
an 82×104 box, i.e. already about 18 % narrow, so this is a fix rather than a new problem.

## The Q-style pass (current)

The cel-shaded pass above was replaced wholesale by **Q-style / super-deformed chibi**:
about two and a half heads tall, an enormous head at roughly 45% of the figure height, huge
round eyes, short stubby limbs and oversized hands and feet. The reason is in the brief
(`docs/art-direction-brief.md`), but the short version is that at the 73 px the game actually
draws, a realistically proportioned face is a handful of pixels and the character reads as a
coloured shape, while a chibi face reads as a face.

Everything was re-rolled rather than adapted: proportions are not a texture change, they
alter every silhouette, every walk cycle and every contact point. Specs:

| Spec | Covers |
|---|---|
| `art/specs/08-qstyle-target.json` | the new approved target — the chibi wizard seed |
| `art/specs/09-qstyle-cast.json` | shade, wisp, brute, brazier as edits of that seed |
| `art/specs/10-qstyle-poses.json` | the chibi waddle strip |
| `art/specs/12-qstyle-cast-strips.json` | shade hover cycle, brute waddle strip |
| `art/specs/13-qstyle-brute-strip-retry.json` | the brute strip, second attempt |
| `art/specs/11-splash-art.json` | the splash screen key art |

The proportion requirement is stated as the single most important thing in every prompt, with
an explicit failure description, because it is the one property a model will drift on:

> PROPORTION - THIS IS THE MOST IMPORTANT REQUIREMENT. Super-deformed Q-style: the character
> is only about TWO AND A HALF HEADS TALL. The head is enormous, roughly 45 percent of the
> entire figure height. … if the figure looks like a normal person with a big head, it is
> wrong.

### The brute strip that had to be re-rolled

The first brute strip came back with three brutes where the left two **touched** — a 32 px
bridge of shoulder plate, with no empty column between them. The slicer segments a strip on
its empty gutters, so it found two figures instead of three.

The tempting fix is to split the merged run at its narrowest column, and the measurement says
that column is 32 px tall. That is not antialiasing, it is a real overlap: splitting there
would slice through an arm and leave a flat vertical edge on a shoulder plate at 82 px drawn
size. So the strip was re-briefed with the requirement made explicit rather than the symptom
patched:

> IMPORTANT: the three figures must NOT touch or overlap each other anywhere - leave a clear
> empty gap at least half a character wide between one figure's edge and the next figure's
> edge, including between their arms and shoulder plates. Nothing may bridge the gaps.

The second attempt produced 14 px and 10 px gutters and sliced cleanly.

### The splash key art

`art/specs/11-splash-art.json` asks for the hero in a heroic casting pose with smaller
enemies reacting around it, and — importantly — **the top third kept open** so a logo can sit
there. It also excludes text explicitly: a model asked for a title screen will happily render
a misspelled one, and the logo is drawn in code where it stays sharp and editable.

The model did not fully honour the open top third; the staff crystal and hood reach well into
it. That is handled in the layout rather than by re-rolling - the logo is drawn with a heavy
outline over the art, and the prompt sits on a translucent panel (see "What the splash had to
fix").

### The background music

Generated with **MiniMax Music 3** on the workshop ComfyUI, instrumental, and then turned
into a real loop. Two things went wrong and one thing is worth keeping.

**Wrong: the first attempt was 17 seconds.** The brief asked for `max_duration: 96` and sent
**empty lyrics**, on the documented rule that empty lyrics mean instrumental. It came back at
16.8 s: with no structure to follow, the model produced one short idea and stopped. The
previous track, which ran 95 s, had lyrics with many section tags.

**Fixed: section tags, no words.** The second attempt kept the lyrics field but put *only*
section tags in it — `[Intro] [Verse] [Chorus] [Verse] [Chorus] [Bridge] [Instrumental]
[Chorus] [Outro]` — and said explicitly in the caption that every section is played by
instruments only. That gave the model an arrangement to fill without adding a vocal, and it
rendered **113 seconds**. Duration follows structure.

**Worth keeping: the loop is seamless by construction.** A generated track is linear; played
on repeat the join is a hard cut, which is what the previous track had. `tools/make-bgm-loop.py`
overlaps the tail with the head instead:

    out = crossfade(S[L : L+X], S[0 : X])  ++  S[X : L]

`out` is L long, and at the wrap `out[L-e]` is `S[L-e]` while `out[0]` is `S[L]` — the seam is
the same step the track already takes there, so it cannot click. Measured on the shipped file:

| | |
|---|---|
| source | 113.26 s linear |
| loop | 110.26 s (3.0 s crossfade) |
| jump at the wrap | **0.0144** |
| average sample step inside the track | **0.0206** |
| integrated loudness | −16.2 LUFS (target −16) |
| true peak | −1.1 dB |

The wrap moves *less* than a typical sample step, which is the strongest statement available
without listening. The previous track peaked at −0.9 dB with no limiting and no loudness
target. Loudness is two-pass `loudnorm` — the single-pass form undershoots.

## The medieval pass (current)

Proportions unchanged from the Q-style pass; the world, costumes and palette moved to a
medieval European register. Specs: `art/specs/16-medieval-target.json` (the hedge-wizard
seed), `17-medieval-cast.json` (revenant, will-o'-the-wisp, man-at-arms, brazier),
`18-medieval-poses.json` and `19-medieval-cast-strips.json` (walk cycles),
`20-medieval-floor.json` (the courtyard), `21-medieval-splash.json` (the boot screen).

Every prompt carried the same proportion preamble plus an explicit material constraint:

> The game is set in a MEDIEVAL world: wool, linen, leather, hand-forged iron, rough wood,
> hand-made and a little battered. … EXCLUDE: modern clothing, plastic, neon, glowing cyan,
> sci-fi, robots.

Each creature was an **edit referenced to the new medieval wizard**, so the chibi proportions
and the outline weight carried over mechanically rather than being re-described and hoped for.
That is the single biggest practical win of the edits endpoint across all three passes: a
style change becomes a costume change.

### The floor that failed its own gate

The courtyard came back at central-60% mean **110**, std 13.9, saturation **27.9%** — against a
gate of 180-205 / ≤18 / ≤14%. It is a handsome dark cobblestone, and it is unusable: the HUD
draws sepia ink straight onto the arena, and every actor is a mid-to-dark mass with a heavy
outline, so a dark floor makes the readouts illegible and swallows the cast.

Worth recording is that the *first* fix was wrong. A gamma curve is the reflex for brightening,
and it hit the gate — but it compressed the upper range and flattened the stone's texture from
std 13.9 to **9.0**, which looks like painted card. The shipped correction is a linear
gain-and-offset lift (**gain 1.29, offset +44.1**) plus a saturation pull to 14%, solved and
re-measured rather than eyeballed, which lands at **185.5 / 18.0 / 14.0%** with the cobbles and
the carved heraldic roundel intact. `tools/prepare-floor.py` does this and refuses to write a
file that fails the gate.

The general point: "the model was asked for pale stone" is not evidence that it produced pale
stone. It was asked, and it returned something 40% too dark and twice too saturated.

## Derivations and what was done to the files

| Shipped | From | Operations |
|---|---|---|
| `assets/wizard.png` | `art/raw/raw-wizard.png` | scaled ×0.364 onto the shared 175×320 frame |
| `assets/wizard-b.png` | `art/raw/raw-wizard-strip.png`, pose 3 | sliced at the alpha gutters, scaled ×0.514 |
| `assets/wizard-c.png` | `art/raw/raw-wizard-strip.png`, pose 2 | sliced at the alpha gutters, scaled ×0.516 |
| `assets/floor.webp` | `art/raw/raw-floor-v3.png` | 3:2 centre-cropped to 16:9, resized to 1920×1080, encoded WebP |
| `assets/shade.png` / `-b` / `-c` | `art/raw/raw-shade-v2.png`, `raw-shade-v2-strip.png` | sliced at the alpha gutters, scaled ×0.333 / ×0.790 / ×0.807 onto one 352×320 frame |
| `assets/wisp.png` | `art/raw/raw-wisp-v2.png` | scaled ×0.391 onto a 398×320 frame |
| `assets/brute.png` / `-b` / `-c` | `art/raw/raw-brute.png`, `raw-brute-strip.png` | sliced at the alpha gutters, scaled ×0.393 / ×0.826 / ×0.843 onto one 372×320 frame |
| `assets/brazier.png` | `art/raw/raw-brazier.png` | scaled ×0.346, then padded to the 82:104 box aspect |
| `assets/splash.webp` | `art/raw/qstyle-splash.png` | 3:2 cropped to 16:9, resized to 1920×1080, text scrims baked in, WebP |
| `assets/bgm.mp3` | `art/raw/qstyle-bgm-render.mp3` | trimmed, crossfaded to a seamless loop, two-pass loudnorm |

**The table above is the previous (cel-shaded) pass.** The current Q-style files derive from
the `qstyle-` raws listed in `assets/asset-manifest.json`; that file is the authority on what
actually ships, because it is the one that gets checked.

The pose order is not the strip's left-to-right order: the two step frames are chosen as the
pair whose planted feet are furthest apart, because a walk blend cross-fades them. For the
shade that picked poses whose planted feet sit 96 px apart in the source — a strong banking
hover rather than a shuffle.

Re-running `tools/normalize-sprites.py` with the commands above writes byte-identical files
into `assets/`, so every shipped sprite can be re-derived from `art/raw/` alone.

The failed attempts are not kept as image files — they are documented here and in
`assets/asset-manifest.json`, with their prompts preserved in `art/specs/`. Keeping ~5 MB of
rejected renders in the repository would buy nothing that those records do not.

## Rights

Model-generated does not mean licensed. **Every asset here is flagged for a human rights
review before commercial release; that review has not happened.** Specifically unresolved:

- The OpenAI terms applicable to these outputs, including whether commercial use, modification
  and redistribution are permitted and what disclosure obligations apply.
- Whether shipping the model outputs as *editable source assets* in a public repository is
  permitted on the same terms as shipping them inside a built game.
- The licence of the `t8star/YuE2-Comfy` model used for `assets/bgm.mp3`.
- Platform disclosure rules for AI-generated art, which change faster than this document.

Resizing and WebP/PNG re-encoding strip content credentials and metadata, so
`assets/asset-manifest.json` is the retention record required in their place. Raw model
outputs in `art/raw/` are kept unmodified so the shipped files can always be re-derived.
