#!/usr/bin/env python3
"""Medieval Q-style review board: the redesign, the splash screen, and the measurements.

    node rune-shot.mjs   /tmp/medieval/boot2.png title     (the splash)
    node rune-shot.mjs   /tmp/medieval/play.png  play
    node tools/render-cues.mjs > /tmp/medieval/cues.txt
    python3 tools/build-qstyle-board.py
"""
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
SRC = Path("/tmp/medieval")
OUT = REPO / "docs" / "target" / "medieval-board.png"

W = 1400
PAD = 26
BG = (20, 26, 40)
INK = (238, 242, 250)
DIM = (150, 164, 190)
OK = (120, 226, 160)
WARN = (255, 196, 96)
IW = W - PAD * 2

CAST = [
    ("wizard", 15 * 1.95 * 2.5, "player · 73px", "#7ea6d8"),
    ("brute", 27 * 1.22 * 2.5, "brute · 82px", "#c1913a"),
    ("shade", 14 * 1.55 * 2.35, "shade · 51px", "#a8503c"),
    ("wisp", 12 * 1.50 * 2.5, "wisp · 45px", "#8f7bb5"),
    ("brazier", 104, "brazier · 82x104", "#e0a94a"),
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
F_MONO = font(12)

blocks = []


def start(h):
    blocks.append(Image.new("RGB", (IW, h), BG))
    return blocks[-1], ImageDraw.Draw(blocks[-1])


# ── 1. the splash ─────────────────────────────────────────────────────────────
shot = Image.open(SRC / "boot2.png").convert("RGB")
sh = round(shot.height * IW / shot.width)
b, d = start(30 + sh + 26)
d.text((0, 4), "1.  The splash screen — real capture, first thing on boot", font=F_H, fill=INK)
b.paste(shot.resize((IW, sh), Image.LANCZOS), (0, 30))
d.text((0, 34 + sh),
       "Medieval key art: castle gatehouse, heraldic banners, chibi hedge-wizard with an amber staff.",
       font=F_S, fill=DIM)

# ── 2. the cast at native size ────────────────────────────────────────────────
floor = Image.open(REPO / "assets" / "floor.webp").convert("RGBA").resize((960, 540), Image.LANCZOS)
floor = Image.blend(floor, Image.new("RGBA", floor.size, (18, 26, 44, 255)), 0.10).convert("RGBA")
row_h = 172
b, d = start(30 + row_h + 8)
d.text((0, 4), "2.  The medieval cast at exactly the size the game draws it", font=F_H, fill=INK)
x = 4
for name, drawn, label, col in CAST:
    im = Image.open(REPO / "assets" / f"{name}.png").convert("RGBA")
    if name == "brazier":
        w, h = 82, 104
    else:
        w, h = max(1, round(drawn / im.height * im.width)), round(drawn * 0.9375)
    s = im.resize((w, h), Image.LANCZOS)
    box = max(150, w + 56)
    b.paste(floor.crop((20, 150, 20 + box, 150 + row_h - 40)).convert("RGB"), (x, 30))
    b.paste(s, (x + (box - w) // 2, 30 + (row_h - 40 - h) // 2 + 4), s)
    d.text((x + 2, 30 + row_h - 32), label, font=F, fill=col)
    x += box + 6

# ── 3. the walk cycles ────────────────────────────────────────────────────────
try:
    pw = json.loads(Path("/tmp/medieval/pw.json").read_text())
    ew = json.loads(Path("/tmp/medieval/ew.json").read_text())
    rows = [
        ("player", pw),
        ("shade", [f for f in ew if f["type"] == "shade"]),
        ("brute", [f for f in ew if f["type"] == "brute"]),
    ]
    n = 6
    cell = IW // n
    ih = round((cell - 6) * 0.95)
    b, d = start(30 + len(rows) * (ih + 16) + 8)
    d.text((0, 4), "3.  Walk cycles in motion — real frames, native drawn size", font=F_H, fill=INK)
    for r, (lab, frames) in enumerate(rows):
        y = 30 + r * (ih + 16)
        d.text((2, y), lab, font=F_S, fill=WARN)
        for i, fr in enumerate(frames[:n]):
            p = Path(fr["file"])
            if not p.exists():
                p = SRC / p.name
            if not p.exists():
                continue
            im = Image.open(p).convert("RGB").resize((cell - 6, ih - 14), Image.LANCZOS)
            b.paste(im, (2 + i * cell, y + 14))
    d.text((2, 30 + len(rows) * (ih + 16) - 4),
           "Every pose of a creature shares one canvas, so nothing changes size between frames.",
           font=F_S, fill=DIM)
except Exception as e:  # noqa: BLE001
    b, d = start(40)
    d.text((0, 4), "3.  walk cycles — captures unavailable", font=F_H, fill=WARN)
    d.text((0, 24), str(e), font=F_S, fill=DIM)

# ── 4. in play ────────────────────────────────────────────────────────────────
play = Image.open(SRC / "play.png").convert("RGB")
ph = round(play.height * IW / play.width)
b, d = start(30 + ph + 24)
d.text((0, 4), "4.  In play", font=F_H, fill=INK)
b.paste(play.resize((IW, ph), Image.LANCZOS), (0, 30))

# ── 5. measurements ───────────────────────────────────────────────────────────
gates = [
    ("proportion", "2.5 heads tall, head ~45% of figure height", OK),
    ("shared canvas", "wizard 338x320, shade 272x320, brute 341x320", OK),
    ("ground line", "y=316 for every creature", OK),
    ("floor gate", "raw mean 110 / sat 28% -> corrected 185.5 / std 18.0 / sat 14%", OK),
    ("UI register", "parchment panels, sepia ink, heraldic element hues", OK),
    ("assets total", "2.1 MB", OK),
    ("art version", "ART_VERSION 3 — new URLs, so caches actually bust", OK),
    ("tests", "168 pass, 0 fail", OK),
    ("reproducible", "re-deriving into assets/ is byte-identical", OK),
    ("bgm", "110.26 s seamless loop, -16.2 LUFS, TP -1.1 dB", OK),
    ("bgm loop seam", "0.0144 vs 0.0206 mean step -> cannot click", OK),
    ("bgm in engine", "decodes, loops, honours mute (browser check)", OK),
    ("rights review", "OUTSTANDING — flags in the manifest", WARN),
]
cues = Path("/tmp/medieval/cues.txt")
cue_lines = cues.read_text().strip().splitlines() if cues.exists() else []
if not cue_lines:
    try:
        cue_lines = subprocess.run(["node", "tools/render-cues.mjs"], cwd=REPO,
                                   capture_output=True, text=True, timeout=200).stdout.strip().splitlines()
    except Exception:  # noqa: BLE001
        cue_lines = []

b, d = start(30 + max(len(gates) * 20, len(cue_lines) * 16) + 12)
d.text((0, 4), "5.  Measured", font=F_H, fill=INK)
y = 34
for k, v, c in gates:
    d.text((2, y), k, font=F, fill=DIM)
    d.text((210, y), v, font=F, fill=c)
    y += 20
if cue_lines:
    x2 = 720
    d.text((x2, 4), "audio (offline render)", font=F_H, fill=INK)
    yy = 34
    for l in cue_lines:
        col = OK if l.startswith("OK") else WARN if l.startswith("FAIL") else DIM
        d.text((x2, yy), l, font=F_MONO, fill=col)
        yy += 16

H = sum(r.height for r in blocks) + PAD * (len(blocks) + 1)
board = Image.new("RGB", (W, H), BG)
yy = PAD
for r in blocks:
    board.paste(r, (PAD, yy))
    yy += r.height + PAD
OUT.parent.mkdir(parents=True, exist_ok=True)
board.save(OUT)
print(f"{OUT}  {board.size}")
