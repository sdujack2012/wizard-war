#!/usr/bin/env python3
"""Normalize generated character art into the game's sprite frame.

Why this exists
---------------
`drawPainted` in src/sprites.js sizes a bitmap by height and derives its width
from the image's own aspect ratio:

    const w = ((R * height) / img.height) * img.width * (2 - stretch);

So any set of poses that is not emitted on an identical canvas distorts: the
first shipped walk set was 154 / 234 / 245 px wide on a 320 px canvas, which
would have fattened the wizard by up to 60% mid-stride. This script is the
single deterministic gate that puts every pose of a creature on one canvas, at
one scale, on one ground line, so the renderer can only ever translate it.

Canvas height is a *resolution* choice, not a size: the game maps the whole
bitmap onto `R * ART.height` whatever its pixel dimensions. What decides the
on-screen size of the figure is the fraction of the canvas it fills, which
`--body-frac` fixes identically for every creature.

Anchors are measured, not assumed. Two modes:

  head  - for humanoids. The ground line is the lowest opaque row; body height
          runs from there up to the top of the *head*, found as the first row
          whose last opaque run is wide enough to be a head rather than a staff
          or a trailing shard; body centre is the mean x of that head run.
  mass  - for things with no head: wraiths, flames, props. Body height is the
          full content height, the ground line is the content bottom, and the
          centre is the area centroid, which an asymmetric tail cannot drag off.

Usage:
    normalize-sprites.py --seed RAW.png --out DIR
    normalize-sprites.py --seed RAW.png --strip RAW.png --out DIR
    normalize-sprites.py --seed RAW.png --anchor mass --out DIR
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# --- technical frame -------------------------------------------------------
# Canvas height, shared by the whole cast.
CANVAS_H = 320
# The figure occupies this fraction of the canvas, identically for every
# creature, so the relative on-screen sizes encoded in ART.height survive.
BODY_FRAC = 0.9375
# Transparent margin kept under the ground line, so a soft edge is never
# clipped by the canvas boundary.
FOOT_BLEED = 4
# Alpha above which a pixel counts as figure, for landmark finding only. Soft
# glow keeps its own alpha and is never masked out of the composite.
LANDMARK_ALPHA = 24
# A head run is at least this wide; the staff column is 16-70 px and the hood
# at its narrowest detection point is ~40 px, so this separates the two.
HEAD_RUN_MIN_W = 42
# Transparent margin kept around the content when cropping.
BLEED = 2


def _runs(mask_row) -> list[tuple[int, int]]:
    """Contiguous runs of True in one boolean row, as (start, end) inclusive."""
    out: list[tuple[int, int]] = []
    start = None
    for x, v in enumerate(mask_row):
        if v and start is None:
            start = x
        elif not v and start is not None:
            out.append((start, x - 1))
            start = None
    if start is not None:
        out.append((start, len(mask_row) - 1))
    return out


def measure(alpha, x0: int, x1: int, anchor: str = "head") -> dict:
    """Locate the anchor top, the ground line and the centre within [x0, x1]."""
    alpha = np.asarray(alpha)
    sub = alpha[:, x0 : x1 + 1] > LANDMARK_ALPHA
    rows = np.nonzero(sub.any(axis=1))[0]
    if len(rows) == 0:
        raise SystemExit(f"no opaque pixels in columns {x0}..{x1}")
    content_top, ground = int(rows.min()), int(rows.max())

    if anchor == "mass":
        ys, xs = np.nonzero(sub)
        top = content_top
        cx = float(xs.mean())
        detail = {"anchor": "mass"}
    else:
        # Head top: first row whose *last* run is wide enough to be the head.
        # Above it the only run is the staff crystal, which is narrow.
        top = None
        for y in range(content_top, ground + 1):
            rs = _runs(sub[y])
            if rs and (rs[-1][1] - rs[-1][0] + 1) >= HEAD_RUN_MIN_W:
                top = y
                break
        if top is None:
            raise SystemExit("could not find the head: no wide run below the crown")
        # Centre from the head run, sampled under the crown so the hood's
        # pointed top does not bias it.
        centres = []
        for y in range(top + 12, min(top + 52, ground + 1)):
            rs = _runs(sub[y])
            if rs:
                centres.append((rs[-1][0] + rs[-1][1]) / 2)
        if not centres:
            raise SystemExit("head band was empty")
        cx = sum(centres) / len(centres)
        detail = {"anchor": "head"}

    xs_all = np.nonzero(sub.any(axis=0))[0]
    return {
        "col0": x0,
        "col1": x1,
        # Absolute, like col0/col1: cx stays segment-relative because the head
        # band is read from the segment slice.
        "content_x0": int(xs_all.min()) + x0,
        "content_x1": int(xs_all.max()) + x0,
        "content_top": content_top,
        "top": top,
        "ground": ground,
        "body_h": (ground - top + 1) if anchor == "mass" else (ground - top),
        "cx": cx,
        **detail,
    }


def segment_columns(alpha) -> list[tuple[int, int]]:
    """Split a pose strip on its empty vertical gutters."""
    occ = (np.asarray(alpha) > LANDMARK_ALPHA).any(axis=0)
    segs: list[tuple[int, int]] = []
    start = None
    for x, v in enumerate(occ):
        if v and start is None:
            start = x
        elif not v and start is not None:
            segs.append((start, x - 1))
            start = None
    if start is not None:
        segs.append((start, len(occ) - 1))
    # Ignore slivers: a stray antialiased pixel is not a figure.
    return [s for s in segs if s[1] - s[0] + 1 >= 24]


def boot_offset(alpha_arr, seg, m) -> float:
    """Where the planted foot sits relative to the body centre."""
    band0 = m["ground"] - int(m["body_h"] * 0.06)
    xs = []
    for y in range(band0, min(m["ground"] + 1, alpha_arr.shape[0])):
        for a, b in _runs(alpha_arr[y, seg[0] : seg[1] + 1] > LANDMARK_ALPHA):
            xs.extend([a, b])
    return ((min(xs) + max(xs)) / 2 if xs else m["cx"]) - m["cx"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", required=True, help="single-pose raw PNG (idle)")
    ap.add_argument("--strip", help="3-pose raw PNG (walk)")
    ap.add_argument("--out", required=True, help="output directory")
    ap.add_argument("--names", default="wizard", help="base asset name")
    ap.add_argument("--anchor", default="head", choices=["head", "mass"],
                    help="how to find the top and centre of the figure")
    ap.add_argument("--pad", type=int, default=3, help="canvas side padding, px")
    ap.add_argument("--canvas-h", type=int, default=CANVAS_H)
    ap.add_argument("--body-frac", type=float, default=BODY_FRAC)
    ap.add_argument(
        "--box",
        metavar="WxH",
        help="the game draws this asset stretched into a fixed WxH box, so the "
             "canvas aspect must equal W/H. Pads with transparency to get there, "
             "never rescales, so the art is never squashed.",
    )
    ap.add_argument("--report", help="write measured geometry here as JSON")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    canvas_h = args.canvas_h
    body_h_target = round(canvas_h * args.body_frac)
    top_y = canvas_h - body_h_target - FOOT_BLEED
    ground_y = canvas_h - FOOT_BLEED

    seed_img = Image.open(args.seed).convert("RGBA")
    seed_a = np.asarray(seed_img.getchannel("A"))

    frames: list[tuple[str, Image.Image, dict]] = [
        (args.names, seed_img, measure(seed_a, 0, seed_img.width - 1, args.anchor))
    ]

    if args.strip:
        strip = Image.open(args.strip).convert("RGBA")
        strip_a = np.asarray(strip.getchannel("A"))
        segs = segment_columns(strip_a)
        if len(segs) != 3:
            print(f"expected 3 poses in the strip, found {len(segs)}: {segs}", file=sys.stderr)
            return 2
        measured = [(s, measure(strip_a, s[0], s[1], args.anchor)) for s in segs]
        offsets = [boot_offset(strip_a, s, m) for s, m in measured]
        print("boot offset from body centre, per pose:")
        for i, ((s, m), off) in enumerate(zip(measured, offsets)):
            print(f"  pose {i}: body_h={m['body_h']:4d} top={m['top']:4d} ground={m['ground']:4d} "
                  f"cx={m['cx'] + s[0]:7.1f} offset={off:+6.1f}")
        # A walk blend cross-fades two poses against each other, so the pair
        # chosen is the one whose planted feet differ most.
        ranked = sorted(range(1, 3), key=lambda i: abs(offsets[i]), reverse=True)
        for n, i in zip(("b", "c"), ranked):
            s, m = measured[i]
            print(f"  -> {args.names}-{n}.png from pose {i}")
            frames.append((f"{args.names}-{n}", strip, m))

    # One canvas for every frame. The transform is per-frame, so this only has
    # to be big enough, but it must be *shared*: drawPainted derives the drawn
    # width from the bitmap's aspect ratio, so a per-pose canvas distorts.
    # Extents come from the content, not the source rect, or a raw image with
    # generous transparent margin silently widens every frame.
    def bounds(m):
        s = body_h_target / m["body_h"]
        cx_abs = m["cx"] + m["col0"]
        x0 = max(m["col0"], m["content_x0"] - BLEED)
        x1 = min(m["col1"], m["content_x1"] + BLEED)
        return x0, x1, s, max((cx_abs - x0) * s, (x1 - cx_abs) * s)

    half = max(bounds(m)[3] for _n, _i, m in frames) + args.pad
    canvas_w = int(2 * half + 0.5)

    box_w = 0
    if args.box:
        bw, bh = (int(v) for v in args.box.lower().split("x"))
        box_w = int(round(canvas_h * bw / bh))
        if box_w < canvas_w:
            print(f"warning: {args.box} is narrower than the art needs "
                  f"({box_w} < {canvas_w}); the art would be squashed. "
                  f"Widening ART.brazier is the fix, not cropping.", file=sys.stderr)
            box_w = 0

    report = {
        "canvas": [box_w or canvas_w, canvas_h],
        "anchor": args.anchor,
        "body_h": body_h_target,
        "body_frac": round(body_h_target / canvas_h, 4),
        "top_y": top_y,
        "ground_y": ground_y,
        "frames": {},
    }

    for name, img, m in frames:
        s = body_h_target / m["body_h"]
        x0, x1, _s, _e = bounds(m)
        seg = img.crop((x0, 0, x1 + 1, img.height))
        w = max(1, int(seg.width * s + 0.5))
        h = max(1, int(seg.height * s + 0.5))
        seg = seg.resize((w, h), Image.LANCZOS)

        cx_rel = (m["cx"] + m["col0"] - x0) * s
        top = m["top"] * s
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        px = int(canvas_w / 2 - cx_rel + 0.5)
        py = int(top_y - top + 0.5)
        canvas.alpha_composite(seg, (px, py))

        # A forced-size draw scales the whole bitmap, so for those assets the
        # canvas aspect has to match the destination box exactly. Pad, never
        # rescale: transparent margins keep the figure's own proportions.
        if box_w:
            padded = Image.new("RGBA", (box_w, canvas_h), (0, 0, 0, 0))
            padded.alpha_composite(canvas, ((box_w - canvas_w) // 2, 0))
            canvas = padded

        # Verify where the figure actually landed, so a silent landmark failure
        # cannot ship. This is reported, not enforced: the anchor row is the
        # top of the *anchor*, which for a head anchor sits below the crown.
        mm = np.array(canvas)[..., 3] > LANDMARK_ALPHA
        rows = np.nonzero(mm.any(axis=1))[0]
        entry = {
            "source_columns": [m["col0"], m["col1"]],
            "source_content_x": [m["content_x0"], m["content_x1"]],
            "source_body_h": m["body_h"],
            "scale": round(s, 6),
            "placement": [px, py],
            "content_y": [int(rows.min()), int(rows.max())],
            "bytes": 0,
        }
        report["frames"][name] = entry

        path = out / f"{name}.png"
        canvas.save(path)
        entry["bytes"] = path.stat().st_size
        entry["canvas"] = [canvas.width, canvas.height]
        print(f"{path.name}: {canvas.width}x{canvas.height} scale={s:.4f} "
              f"content_y={entry['content_y']} ground_y={ground_y} {entry['bytes'] / 1024:.1f} KB")

    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
