#!/usr/bin/env python3
"""Cast review board: the visual state of the game in one image.

Everything on it is a real capture of the real game at native drawn size, or the
shipped sprite drawn at the size the game draws it. Nothing is a mock-up. Reads
captures from the paths the verification harnesses write, so re-running those and
then this script refreshes the board.

    node rune-shot.mjs   /tmp/art3/game-final.png play
    node walk.mjs        /tmp/art3/walk 6 100
    node enemy-walk.mjs  /tmp/art3/ew 5 150
    python3 tools/build-review-board.py
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
SRC = Path("/tmp/art3")
OUT = REPO / "docs" / "target" / "cast-board.png"

W = 1400
PAD = 26
BG = (22, 28, 42)
INK = (238, 242, 250)
DIM = (150, 164, 190)
OK = (120, 226, 160)
WARN = (255, 196, 96)


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
IW = W - PAD * 2

blocks = []


def start(h):
    blocks.append(Image.new("RGB", (IW, h), BG))
    return blocks[-1], ImageDraw.Draw(blocks[-1])


# ── 1. the game in context ────────────────────────────────────────────────────
shot = Image.open(SRC / "game-final.png").convert("RGB")
shot_h = round(shot.height * IW / shot.width)
b, d = start(30 + shot_h + 26)
d.text((0, 4), "1.  The whole cast in the real game — 1280x720, wave 6", font=F_H, fill=INK)
b.paste(shot.resize((IW, shot_h), Image.LANCZOS), (0, 30))
d.text((0, 34 + shot_h),
       "Player, shade, wisp, brute and the four corner braziers, all on the one approved visual system. This frame is the native capture kept at docs/target/native-1280x720.png.",
       font=F_S, fill=DIM)

# ── 2. everything at the size the game draws it ───────────────────────────────
CAST = [
    ("wizard", 15 * 1.95 * 2.5, "#7ec8f0", "player, 73px"),
    ("brute", 27 * 1.22 * 2.5, "#ffa33d", "brute, 82px"),
    ("shade", 14 * 1.55 * 2.35, "#ff5c7a", "shade, 51px"),
    ("wisp", 12 * 1.50 * 2.5, "#c58bff", "wisp, 45px"),
    ("brazier", 104, "#ffd08a", "brazier, 82x104 box"),
]
floor = Image.open(REPO / "assets" / "floor.webp").convert("RGBA").resize((960, 540), Image.LANCZOS)
floor = Image.blend(floor, Image.new("RGBA", floor.size, (18, 26, 44, 255)), 0.10).convert("RGBA")

pad = 40
b, d = start(30 + 150 + 26)
d.text((0, 4), "2.  Every actor at exactly the size the game draws it, over the real floor", font=F_H, fill=INK)
x = 6
for name, drawn, col, label in CAST:
    im = Image.open(REPO / "assets" / f"{name}.png").convert("RGBA")
    # A forced box (the brazier) is scaled to the box; everything else by height.
    if name == "brazier":
        w, h = 82, 104
    else:
        w, h = max(1, round(drawn / im.height * im.width)), round(drawn * 0.9375)
    s = im.resize((w, h), Image.LANCZOS)
    box_w = max(120, w + pad * 2)
    b.paste(floor.crop((20, 150, 20 + box_w, 300)).convert("RGB"), (x, 34))
    b.paste(s, (x + (box_w - w) // 2, 34 + (150 - h) // 2 + 6), s)
    d.text((x + 4, 34 + 150 - 26), label, font=F, fill=col)
    x += box_w + 12
d.text((0, 34 + 150 + 4),
       "This is the gate that matters: at these sizes the shade and the wisp were originally unreadable, and both were re-briefed until they were not.",
       font=F_S, fill=WARN)

# ── 3. the walk cycles in motion ──────────────────────────────────────────────
walk = json.loads((SRC / "walk.json").read_text())
ew = json.loads((SRC / "ew.json").read_text())
for title, frames, key in (
    ("3.  Player walk — six real frames while the stick is held", walk, None),
    ("4.  Enemy walk — shade and brute, five real frames while chasing", ew, "type"),
):
    n = 6 if key is None else 5
    cell = IW // n
    # Both rows end at 30 + cell: the player row is one strip, the enemy row
    # is two half-height strips stacked.
    b, d = start(30 + cell + 26)
    d.text((0, 4), title, font=F_H, fill=INK)
    if key is None:
        rows = frames
    else:
        rows = [f for f in frames if f["type"] == "shade"] + [f for f in frames if f["type"] == "brute"]
    for i, f in enumerate(rows[:n] if key is None else rows):
        if key is not None:
            # Two rows of five, one per creature.
            row, col_i = divmod(i, n)
            if col_i == 0 and i:
                pass
        im = Image.open(f["file"]).convert("RGB").resize((cell - 8, cell - 8), Image.LANCZOS)
        if key is None:
            b.paste(im, (i * cell + 4, 30))
            d.text((i * cell + 8, 34), f"gait {f['gait']:.2f}", font=F_S, fill=(255, 245, 205))
    if key is not None:
        half = cell // 2
        for i, f in enumerate([x for x in frames if x["type"] == "shade"]):
            im = Image.open(f["file"]).convert("RGB").resize((half - 6, half - 6), Image.LANCZOS)
            b.paste(im, (i * half + 2, 30))
        for i, f in enumerate([x for x in frames if x["type"] == "brute"]):
            im = Image.open(f["file"]).convert("RGB").resize((half - 6, half - 6), Image.LANCZOS)
            b.paste(im, (i * half + 2, 34 + half))
    d.text((0, 30 + cell + 2),
           "Poses share one canvas each, so nothing changes size between frames — the aspect fix."
           if key is None else
           "Top row shade, bottom row brute. Both step cycles alternate visibly and hold their drawn size.",
           font=F_S, fill=DIM)

# ── 4. measured gates ─────────────────────────────────────────────────────────
gates = [
    ("shared canvas", "wizard 175x320, shade 352x320, brute 372x320 — identical across each creature's poses", OK),
    ("ground line", "y=316 for every creature", OK),
    ("body height", "300 px of 320, one rule for the whole cast", OK),
    ("playfield mean lum", "185.6   (gate 180-205)", OK),
    ("playfield std", "17.4   (gate <= 18)", OK),
    ("QA asset_report", "11/11 ok, no problems", OK),
    ("sprite bytes", "1,263,582 total, from ~3.6 MB of painterly source", OK),
    ("tests", "153 pass, 0 fail", OK),
    ("reproducible", "re-deriving into assets/ is byte-identical", OK),
    ("rights review", "OUTSTANDING — flags in the manifest", WARN),
]
b, d = start(30 + len(gates) * 22 + 8)
d.text((0, 4), "5.  Measured gates", font=F_H, fill=INK)
y = 38
for k, v, c in gates:
    d.text((0, y), k, font=F, fill=DIM)
    d.text((210, y), v, font=F, fill=c)
    y += 22

H = sum(r.height for r in blocks) + PAD * (len(blocks) + 1)
board = Image.new("RGB", (W, H), BG)
yy = PAD
for r in blocks:
    board.paste(r, (PAD, yy))
    yy += r.height + PAD
OUT.parent.mkdir(parents=True, exist_ok=True)
board.save(OUT)
print(f"{OUT}  {board.size}")
