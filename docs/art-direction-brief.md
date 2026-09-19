# Art direction brief — RUNE PRESSURE

Filled from the `create-game-assets` template. This is the contract: every later
output is compared against it at the same size, under the same background and the
same light assumptions.

## Game frame

- **Player fantasy:** a lone mage holding a ritual circle against waves of monsters by
  recalling glyph recipes under pressure.
- **Core verbs:** analog move; tap four element circles in recipe order; hold the centre
  circle to charge a shot.
- **Engine and renderer:** vanilla JS + Canvas 2D, zero runtime dependencies, hand-written
  renderer. No engine, no sprite batcher, no shader pipeline.
- **Target platforms:** mobile web (Android Chrome, iOS Safari) and desktop; landscape only.
- **Camera/view/facing:** **fixed** top-down three-quarter (camera ~55° above the horizon),
  no scroll, no zoom, no rotation. World is letterboxed at 960×540. Creatures face the
  viewer and mirror left/right rather than turning — a rotating three-quarter figure reads
  as falling over, so turning is not available.
- **Native viewport and scale:** 1280×720 CSS is the common capture (world scale 1.333×);
  device pixel ratio up to 2.5.
- **Typical asset size on screen:** 45–82 px tall. Measured: wizard 73 px, brute 82 px,
  shade 51 px, wisp 45 px. **This is the only size at which an asset is judged.**

## Setting: medieval (current), revised 2026-09-19

The third pass. Proportions are **unchanged** from the Q-style pass — still a 2.5-head chibi
with a 45%-of-height head — and what moved is the world: a medieval European castle
courtyard, with costumes and props of wool, linen, leather, hand-forged iron and rough wood.

- **The cast, re-cast:** the mage is a village hedge-wizard in a hooded wool cloak with a
  hand-carved quarterstaff and an amber crystal held in twisted root and iron. The shade is a
  cowled revenant in tattered rust-crimson. The wisp is a will-o'-the-wisp, a violet marsh
  flame loose inside a broken iron hoop. The brute is a man-at-arms in scorched plate with a
  faded crimson surcoat and a great helm. The brazier is an iron fire basket on rough stone.
- **Materials must read as hand-made.** Wool, linen, leather, iron, unpolished amber, worn
  stone. Anything glossy, synthetic or machine-made breaks the setting, and the prompts
  exclude it explicitly.
- **Palette:** parchment, sepia ink and brass for the chrome; terracotta, heraldic blue,
  forest green and muted violet for the four elements; warm amber as the single emissive
  (the staff crystal and spell cores). The bright cyan of the two earlier passes is gone.
- **Two constraints carried over, unchanged.** The four element hues are load-bearing
  gameplay — the wheel, the recipe pips and the spell effects are colour-coded — so they were
  *deepened*, never converged. And the chrome is drawn ON the arena, so it has to stay darker
  than the arena at all times.
- **The arena gate still applies, and caught a real failure.** The generated courtyard came
  back at central-60% mean **110** with **28%** saturation against a 180-205 / ≤18 / low-chroma
  gate: a dark, rich floor that made the sepia HUD ink unreadable and swallowed the cast. It
  was corrected to **185.5 / std 18.0 / 14.0%** by solving a linear levels lift and measuring
  the result (`tools/prepare-floor.py`), not by eyeballing it — and note that a gamma curve,
  the reflex fix, flattened the stone texture from std 13.9 to 9.0 before the linear solve
  preserved it.
- **The ritual circle stays heraldic blue**, deliberately: it is the one cool colour in the
  arena, which is what lets it read against warm stone and keeps the shift to red at the end
  of a wave a real signal rather than a nudge.

## Visual system

### Proportion: Q-style (super-deformed), revised 2026-09-19

The first pass through this brief was cel-shaded but **realistically proportioned** — a
seven-head figure whose face is a small part of its silhouette. It has been replaced by
**Q-style / super-deformed chibi**: about **two and a half heads tall**, an enormous head
roughly **45% of the figure height**, huge round eyes filling most of the face, short
stubby limbs, oversized hands and feet, and a very thick ink outline.

This is not a cosmetic preference — it is a readability decision at the size the game
actually draws. At 73 px the realistic hero's face was a handful of pixels and the
character read as a coloured shape; the chibi hero's face reads as a face. The trade is
that a chibi is much *wider* relative to its height, so every creature is now a broader,
heavier silhouette than before (the hero alone went from 37 px to 71 px wide at the same
drawn height).

Rules that follow from the proportion change:

- The head is the anchor. It is the largest, most contrasty mass, and it must sit clear of
  everything else in the silhouette.
- Limbs are short: a pose reads from the head angle, the arm swing and the squash, not from
  leg extension. Walk cycles are **waddles**, not strides.
- The thick outline is load-bearing. At this scale it is what keeps a head from merging
  into a hood, and a hood into a shoulder.
- Do not let any single creature drift back toward realistic proportions. One tall figure
  among chibis reads as a bug, not as a style choice.

- **Shape language:** rounded, chunky masses with a few hard geometric accents (staff
  crystal, rune pips, UI plates). Nothing wiry or thin — it vanishes at 45 px.
  Q-style pushes this further: every mass is a big simple round shape.
- **Silhouette priorities:** wizard — the huge head under the floppy hood, then the staff
  crystal breaking the shoulder line. Shade — a big round hooded head with glowing eyes,
  stubby claw arms out wide, tapering to a floating point below. Wisp — one big round flame
  ball with a cute face and flame puffs tucked inside its width. Brute — a wide, low,
  top-heavy mass with a small grumpy head sunk between enormous shoulders.
- **Value structure (measured, not asserted):** three bands. Playfield mean luminance
  **180–205 with std ≤ 18** across the central 60% (it must be quiet); actors mid-to-dark;
  spells and the staff crystal hold the only pure white. Baseline measured before this
  pass was mean **216.6 / std 27.5**, which put **77% of the playfield at or above the
  brightness that 75% of the hero's pixels are darker than** — the background was as bright
  as the cast. This design pass exists to fix that.
- **Palette roles and exact swatches:**
  | Role | Swatch | Where |
  | --- | --- | --- |
  | Playfield stone | `#cfcdc6` `#bdbab2` | floor body, low chroma |
  | Playfield seam | `#9a9a8e` | engraved grooves, ≤14% darker |
  | Moss accent | `#8a9a72` | seams only, desaturated |
  | Ink outline | `#241f38` | actors only, ~2 px at 64 px tall |
  | Player key | `#2f5fd0` | robe |
  | Player light | `#f2f4f8` | robe panel, trim |
  | Player trim | `#e0a832` | belt, staff metal |
  | Emissive (only) | `#4fd8ff` | staff crystal, spell cores |
  | Danger | `#e02a4a` | HP, overtime, break flash |
  | Reward | `#3fbf6a` | heal |
- **Materials:** stone — matte, no gloss, no reflection. Cloth — matte with hard folds.
  Metal — one flat highlight, never a gradient. Crystal — the only emissive material in
  the game.
- **Edge/line treatment:** actors carry a ~4 px ink outline (`#241f38`) at 1024 source —
  proportionally thicker than the first pass, because a chibi lives or dies on its outline
  separating a head from a hood — and no interior line noise. The **environment carries no outline at all**.
  Effects carry none — they are light, and outlines would cage them.
- **Lighting:** one key from the upper-left, hard cel terminator, cool ambient fill. The
  floor art bakes **no** cast shadows; the engine draws a contact shadow per creature.
- **Detail density and focal hierarchy:** detail is permitted only **outside the central
  60%** of the arena and outside HUD safe areas (left 46% of the screen below mid-height
  for the recipe chart, top 80 px for bars and timer, right ~35% for the wheel). The
  centre of the arena must stay quiet.
- **Motion character:** snappy and weighty. Deformation is capped at ±3% squash and
  0.075 rad of lean; poses swap on a smoothstep so a step reads as a step, not a shimmer.
- **Explicit exclusions:** glowing runes or sigils inside the play area; rim-lit or
  backlit floor; neon; any light source drawn into the floor; text or labels of any kind
  inside generated art; baked drop shadows; cropped limbs.

## Technical contract

- **Asset dimensions:** creatures ~300–320 px tall at source (drawn 45–82 px); floor
  1920×1080; brazier 160 px tall.
- **Alpha/background:** actors — transparent PNG, real alpha, `background: transparent`
  requested at generation and then verified; floor — opaque WebP q86.
- **Grid/tile/frame size:** no tile grid (one fixed arena). Three poses per walking
  creature: neutral, left-foot, right-foot.
- **Anchor/pivot/baseline:** bottom-center for grounded creatures, center for the floating
  wisp; enforced by `ART.height`/`ART.foot` in `src/config.js`, not by the art.
- **Filtering/compression:** browser bilinear (smooth). **Not** nearest — this is not
  pixel art, and the source is ~4× the drawn size.
- **Color space:** sRGB throughout.
- **Budgets:** whole asset payload ≤ 4 MB; floor ≤ 500 KB; each creature ≤ 200 KB.
- **Naming and folders:** `assets/<id>.png`, `assets/<id>-b.png` / `<id>-c.png` for the
  two step poses, `assets/floor.webp`.

## Visual target

- **Approved seed/reference paths:** `assets/wizard.png` (this pass) — every other actor
  is produced as an edit referenced to it.
- **Do/don't:** DO keep the ink outline weight and the upper-left key identical across the
  cast. DO keep the crystal the brightest pixel. DON'T add interior line noise. DON'T let
  a creature's silhouette merge into one blob at 64 px. DON'T put bright detail in the
  arena centre or under the HUD.
- **Native-scale gameplay capture:** `docs/target/native-1280x720.png`.
- **Approval owner/date:** **pending — Kai.** The pipeline requires the target to be
  approved before the remaining catalog is produced.
