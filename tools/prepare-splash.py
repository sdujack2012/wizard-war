#!/usr/bin/env python3
"""Prepare the splash key art for shipping.

Crops the 3:2 source to the arena's 16:9, resizes to 1920x1080, and bakes a soft
scrim into the top and bottom so the logo and the prompt sit on the art without
the runtime building a gradient every frame. The arena's own rule is that the
frame loop allocates no gradients; a splash that quietly broke it would be a
poor trade for text that could simply be seated in the artwork instead.

Usage: prepare-splash.py RAW.png assets/splash.webp
"""
import sys
from pathlib import Path

from PIL import Image

TARGET_W, TARGET_H = 1920, 1080
# Fraction of the height the scrims cover, and how dark they get at the edge.
TOP_H, TOP_A = 0.26, 0.46
BOT_H, BOT_A = 0.24, 0.50


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    im = Image.open(src).convert("RGBA")
    # 3:2 -> 16:9, cropped about the centre so the hero stays centred.
    want_h = round(im.width * TARGET_H / TARGET_W)
    if want_h <= im.height:
        top = (im.height - want_h) // 2
        im = im.crop((0, top, im.width, top + want_h))
    else:
        want_w = round(im.height * TARGET_W / TARGET_H)
        left = (im.width - want_w) // 2
        im = im.crop((left, 0, left + want_w, im.height))
    im = im.resize((TARGET_W, TARGET_H), Image.LANCZOS).convert("RGB")

    # Bake the scrims in. A linear ramp in pure PIL, so the shipped file needs no
    # runtime gradient and the text has something to sit on.
    px = im.load()
    top_rows = round(TARGET_H * TOP_H)
    bot_rows = round(TARGET_H * BOT_H)
    for y in range(top_rows):
        a = TOP_A * (1 - y / top_rows) ** 1.6
        for x in range(TARGET_W):
            r, g, b = px[x, y]
            px[x, y] = (
                round(r * (1 - a)),
                round(g * (1 - a)),
                round(b * (1 - a) * 1.02),
            )
    for i in range(bot_rows):
        y = TARGET_H - 1 - i
        a = BOT_A * (1 - i / bot_rows) ** 1.6
        for x in range(TARGET_W):
            r, g, b = px[x, y]
            px[x, y] = (round(r * (1 - a)), round(g * (1 - a)), round(b * (1 - a)))

    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "WEBP", quality=84, method=6)
    print(f"{dst}  {im.width}x{im.height}  {Path(dst).stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
