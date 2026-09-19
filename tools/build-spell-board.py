#!/usr/bin/env python3
"""Spell review board: every spell's visuals and the measured audio, in one image.

Frames come from the moment-driven capture harness, which freezes the real game
at a known point in a spell's life rather than sampling on a timer - a 220ms ring
can otherwise fall entirely between two screenshots.

    node spell-moments.mjs /tmp/spellfx/final      (from /tmp/spellfx)
    node tools/render-cues.mjs > cues.txt
    python3 tools/build-spell-board.py
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
SRC = Path("/tmp/spellfx/final")
OUT = REPO / "docs" / "target" / "spell-board.png"

W = 1400
PAD = 26
BG = (22, 28, 42)
INK = (238, 242, 250)
DIM = (150, 164, 190)
OK = (120, 226, 160)
WARN = (255, 196, 96)

ORDER = [
    ("spark-plain-bolt", "SPARK — free shot"),
    ("spark-charging", "SPARK — winding up"),
    ("spark-charged-bolt", "SPARK — charged release"),
    ("fireball-flight", "FIREBALL — in flight"),
    ("fireball-impact", "FIREBALL — landing"),
    ("waterball-flight", "WATERBALL — in flight"),
    ("waterball-impact", "WATERBALL — landing"),
    ("heal-ring", "HEAL — cast"),
    ("explosion-nova", "EXPLOSION — the blast"),
    ("explosion-dust", "EXPLOSION — after"),
    ("freeze-mid", "FREEZE — front"),
    ("freeze-wide", "FREEZE — wide"),
]


def font(size, bold=False):
    for name in (
        f"/usr/share/fonts/truetype/dejavu/DejaVuSans{'-Bold' if bold else ''}.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


F_TITLE = font(30, True)
F_H = font(19, True)
F = font(15)
F_S = font(13)
F_MONO = font(13)
IW = W - PAD * 2

blocks = []


def start(h):
    blocks.append(Image.new("RGB", (IW, h), BG))
    return blocks[-1], ImageDraw.Draw(blocks[-1])


# ── 1. the visuals ────────────────────────────────────────────────────────────
cols = 3
cell = IW // cols
shot_h = round((cell - 8) * 380 / 700)
rows = (len(ORDER) + cols - 1) // cols
b, d = start(30 + rows * (shot_h + 22) + 30)
d.text((0, 4), "1.  Every spell, captured at a known moment in its life", font=F_H, fill=INK)
for i, (tag, label) in enumerate(ORDER):
    p = SRC / f"{tag}.png"
    r, c = divmod(i, cols)
    x = c * cell
    y = 30 + r * (shot_h + 22)
    if p.exists():
        im = Image.open(p).convert("RGB").resize((cell - 8, shot_h), Image.LANCZOS)
        b.paste(im, (x, y))
    else:
        d.rectangle([x, y, x + cell - 8, y + shot_h], outline=(90, 40, 40))
        d.text((x + 6, y + 6), f"missing {tag}", font=F_S, fill=(255, 120, 120))
    d.text((x + 4, y + shot_h + 3), label, font=F_S, fill=(215, 228, 245))
d.text((0, 30 + rows * (shot_h + 22) + 4),
       "Bolt shapes, impact bursts and the explosion are built from flat colour ramps at full opacity, so each rung leaves a hard rim — the same treatment the cel-shaded cast gets.",
       font=F_S, fill=DIM)

# ── 2. the audio ──────────────────────────────────────────────────────────────
lines = []
try:
    out = subprocess.run(
        ["node", "tools/render-cues.mjs"], cwd=REPO, capture_output=True, text=True, timeout=180
    ).stdout.strip().splitlines()
    lines = [l for l in out if l.strip()]
except Exception as e:  # noqa: BLE001
    lines = [f"could not render cues: {e}"]

b, d = start(30 + len(lines) * 17 + 30)
d.text((0, 4), "2.  Every cue rendered offline and measured — audible, and distinct", font=F_H, fill=INK)
y = 32
for l in lines:
    col = OK if l.startswith("OK") else WARN if l.startswith("FAIL") else DIM
    d.text((2, y), l, font=F_MONO, fill=col)
    y += 17
d.text((2, y + 6),
       "A parameter test proves the graph differs; only rendering proves it makes a sound. Neither has been listened to by a human.",
       font=F_S, fill=DIM)

# ── 3. what was wrong ─────────────────────────────────────────────────────────
fixes = [
    ("scorch decal", "#14100d @0.62 over 132px for 9s read as a hole in the pale floor", "warm browns, 92px, 5.5s"),
    ("nova position", "starPath draws at the origin and was never translated", "all blast stars stacked in the world corner"),
    ("impact", "a hit had particles but no shape and no sound", "cel burst + per-element hit cue"),
    ("bolt bodies", "translucent additive discs washed out on bright stone", "opaque ramps with a real outline"),
    ("freeze front", "additive white needles dissolved into the ring", "solid cel ice rind in three passes"),
]
b, d = start(30 + len(fixes) * 20 + 12)
d.text((0, 4), "3.  What was actually broken", font=F_H, fill=INK)
y = 34
for what, was, now in fixes:
    d.text((2, y), what, font=F, fill=WARN)
    d.text((170, y), was, font=F_S, fill=DIM)
    d.text((760, y), now, font=F_S, fill=OK)
    y += 20

H = sum(r.height for r in blocks) + PAD * (len(blocks) + 1)
board = Image.new("RGB", (W, H), BG)
yy = PAD
for r in blocks:
    board.paste(r, (PAD, yy))
    yy += r.height + PAD
OUT.parent.mkdir(parents=True, exist_ok=True)
board.save(OUT)
print(f"{OUT}  {board.size}")
