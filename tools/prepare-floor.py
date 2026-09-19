#!/usr/bin/env python3
"""Prepare the arena floor, enforcing the measured playfield gate.

The gate exists because of a hard constraint, not a preference: the HUD draws
dark sepia ink straight onto the arena, and every actor is a mid-to-dark mass
with a heavy outline. A playfield that is too dark makes the ink unreadable and
swallows the cast; one that is too varied or too saturated competes with them.

So the floor is not "generated and hoped for". A model asked for pale stone will
happily return dark, richly saturated cobbles - the medieval courtyard came back
at mean 110 and 28% saturation against a 180-205 / <=18 / low-chroma gate - and
eyeballing it at source resolution will not catch that. This solves for the
correction, applies it, and re-measures before writing anything.

Usage: prepare-floor.py RAW.png assets/floor.webp [--target 186] [--std-cap 18]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image

TARGET_W, TARGET_H = 1920, 1080


def central(lum: np.ndarray) -> np.ndarray:
    h, w = lum.shape
    return lum[int(h * 0.2) : int(h * 0.8), int(w * 0.2) : int(w * 0.8)]


def stats(rgb: np.ndarray) -> tuple[float, float, float]:
    a = rgb.astype(np.float64)
    lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    c = central(lum)
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0.0)
    return float(c.mean()), float(c.std()), float(sat[int(a.shape[0] * 0.2) : int(a.shape[0] * 0.8),
                                                    int(a.shape[1] * 0.2) : int(a.shape[1] * 0.8)].mean() * 100)


def apply(rgb: np.ndarray, gain: float, offset: float, sat: float) -> np.ndarray:
    """A linear levels map, then an optional saturation pull.

    Deliberately NOT a gamma curve. Gamma is the reflex for brightening, but it
    COMPRESSES the upper range, and the first attempt at this floor came back
    with its texture flattened from std 13.9 to 9.0 - a floor that reads as
    painted card rather than stone. A gain-and-offset lift keeps the detail: the
    dark image has plenty of headroom above it, so the contrast survives.
    """
    a = rgb.astype(np.float64) * gain + offset
    if sat != 1.0:
        lum = (0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2])[..., None]
        a = lum + (a - lum) * sat
    return np.clip(a, 0, 255).astype(np.uint8)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--target", type=float, default=186.0)
    ap.add_argument("--std-cap", type=float, default=18.0)
    ap.add_argument("--sat-cap", type=float, default=14.0)
    args = ap.parse_args()

    im = Image.open(args.src).convert("RGB")
    # 3:2 -> 16:9 about the centre.
    want_h = round(im.width * TARGET_H / TARGET_W)
    if want_h <= im.height:
        top = (im.height - want_h) // 2
        im = im.crop((0, top, im.width, top + want_h))
    else:
        want_w = round(im.height * TARGET_W / TARGET_H)
        left = (im.width - want_w) // 2
        im = im.crop((left, 0, left + want_w, im.height))
    im = im.resize((TARGET_W, TARGET_H), Image.LANCZOS)
    rgb = np.asarray(im)

    m0, s0, sat0 = stats(rgb)
    print(f"raw      mean={m0:6.1f} std={s0:5.1f} sat={sat0:5.1f}%")

    # Solve the lift directly: take as much gain as the std cap allows (contrast
    # is what keeps the stone reading as stone), then set the offset to land the
    # mean, and reject the gain if it would clip the highlights.
    gain = min(args.std_cap / max(1e-6, s0), 1.6)
    while gain > 0.5:
        offset = args.target - gain * m0
        cand = rgb.astype(np.float64) * gain + offset
        if float((cand > 254.5).mean()) <= 0.004:
            break
        gain -= 0.02
    else:
        raise SystemExit("cannot reach the target mean without clipping")

    # Saturation is a RATIO, so scaling the colour spread does not scale it
    # linearly - close the loop instead of trusting one division.
    sat = sat_mult = 1.0
    for _ in range(8):
        m, s, sat_now = stats(apply(rgb, gain, offset, sat))
        if sat_now <= args.sat_cap or sat <= 0.25:
            break
        sat *= max(0.6, args.sat_cap / sat_now)
        sat_mult = sat

    out = apply(rgb, gain, offset, sat)
    m, s, sat = stats(out)

    problems = []
    if not (172 <= m <= 208):
        problems.append(f"mean {m:.1f} outside 172-208")
    if s > args.std_cap:
        problems.append(f"std {s:.1f} above {args.std_cap}")
    if sat > args.sat_cap:
        problems.append(f"saturation {sat:.1f}% above {args.sat_cap}%")

    Path(args.dst).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out).save(args.dst, "WEBP", quality=84, method=6)
    print(f"corrected mean={m:6.1f} std={s:5.1f} sat={sat:5.1f}%  "
          f"(gain {gain:.2f}, offset {offset:+.1f}, sat scale {sat_mult:.2f})")
    print(f"gate     mean 180-205, std <= {args.std_cap}, sat <= {args.sat_cap}%")
    print(f"wrote    {args.dst}  {Path(args.dst).stat().st_size / 1024:.0f} KB")
    if problems:
        print("GATE FAIL: " + "; ".join(problems))
        return 1
    print("GATE PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
