#!/usr/bin/env python3
"""Turn a rendered track into a seamless game loop.

A generated song is linear: played on repeat, the join is a hard cut, and on an
energetic track that is a click you hear every lap. The previous shipped track
had exactly that problem. This fixes it by construction rather than by hoping the
model ends cleanly.

The trick: instead of looping `S[0:L]`, overlap the track's tail with its head so
that the wrap is continuous by definition.

    out = crossfade(S[L : L+X], S[0 : X])  ++  S[X : L]

`out` is L long. At the wrap, out[L-e] is S[L-e] and out[0] is S[L] (the tail
crossfade starts fully on the tail), so the seam is the same step the track
already takes at that point - it cannot click. The head then morphs into S[0:X]
over the first X seconds.

Usage: make-bgm-loop.py IN.mp3 OUT.mp3 [--crossfade 2.5] [--target-lufs -16]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

SR = 44100


def run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"ffmpeg failed:\n{' '.join(cmd)}\n{p.stderr[-1200:]}")
    return p.stdout + p.stderr


def decode(src: str, dst: str) -> None:
    run(["ffmpeg", "-y", "-v", "error", "-i", src, "-ac", "2", "-ar", str(SR),
         "-c:a", "pcm_s16le", dst])


def read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as w:
        n = w.getnframes()
        data = np.frombuffer(w.readframes(n), dtype=np.int16)
        return data.reshape(-1, w.getnchannels()).astype(np.float64) / 32768.0


def write_wav(path: str, x: np.ndarray) -> None:
    y = np.clip(x, -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(x.shape[1])
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767.0).astype(np.int16).tobytes())


def trim_silence(x: np.ndarray, thresh: float = 0.004, pad: int = 1103) -> np.ndarray:
    """Drop near-silent head and tail, keeping a little pad. Returns the slice."""
    env = np.abs(x).max(axis=1)
    loud = np.nonzero(env > thresh)[0]
    if len(loud) == 0:
        return x
    a = max(0, loud[0] - pad)
    b = min(len(x), loud[-1] + pad)
    return x[a:b]


def seam_metric(x: np.ndarray) -> tuple[float, float]:
    """Jump at the loop point vs the typical step inside the track."""
    seam = float(np.abs(x[0] - x[-1]).max())
    step = float(np.abs(np.diff(x, axis=0)).max(axis=1).mean())
    return seam, step


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--crossfade", type=float, default=2.5)
    ap.add_argument("--target-lufs", type=float, default=-16.0)
    ap.add_argument("--max-loop", type=float, default=0.0,
                    help="cap the loop length in seconds (0 = use what is there)")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        raw = str(Path(tmp) / "in.wav")
        cut = str(Path(tmp) / "loop.wav")
        decode(args.src, raw)
        x = read_wav(raw)
        x = trim_silence(x)
        total = len(x) / SR

        X = int(args.crossfade * SR)
        L = len(x) - X
        if args.max_loop > 0:
            L = min(L, int(args.max_loop * SR))
        if L <= X:
            raise SystemExit(f"track is only {total:.1f}s; too short to loop with a {args.crossfade}s crossfade")

        # Equal-power crossfade: the two halves must sum to constant power, or
        # the seam dips audibly even though it is continuous.
        t = np.linspace(0, 1, X, endpoint=False)[:, None]
        fade_in = np.sin(t * np.pi / 2)
        fade_out = np.cos(t * np.pi / 2)
        head = x[L : L + X] * fade_out + x[0:X] * fade_in
        out = np.concatenate([head, x[X:L]], axis=0)
        write_wav(cut, out)

        seam, step = seam_metric(out)
        print(f"source {total:.2f}s  ->  loop {len(out) / SR:.2f}s  "
              f"(crossfade {args.crossfade}s)")
        print(f"loop seam {seam:.5f} vs mean step {step:.5f}  "
              f"-> {'SEAMLESS' if seam <= step * 3 else 'AUDIBLE CLICK'}")

        # Two-pass loudnorm: the single-pass form undershoots the target badly.
        first = run(["ffmpeg", "-y", "-v", "info", "-i", cut,
                     "-af", f"loudnorm=I={args.target_lufs}:TP=-1.5:LRA=11:print_format=json",
                     "-f", "null", "-"])
        start = first.rfind("{")
        end = first.rfind("}")
        if start < 0 or end < 0:
            raise SystemExit("could not read loudnorm measurements")
        m = json.loads(first[start : end + 1])

        run(["ffmpeg", "-y", "-v", "error", "-i", cut,
             "-af", (
                 f"loudnorm=I={args.target_lufs}:TP=-1.5:LRA=11:linear=true"
                 f":measured_I={m['input_i']}:measured_TP={m['input_tp']}"
                 f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
                 f":offset={m['target_offset']}"
             ),
             "-c:a", "libmp3lame", "-b:a", "192k", "-ar", str(SR), args.dst])

    Path(args.dst).with_suffix(".loop.json").write_text(json.dumps({
        "source_seconds": round(total, 2),
        "loop_seconds": round(len(out) / SR, 3),
        "crossfade_seconds": args.crossfade,
        "seam_jump": round(seam, 6),
        "mean_step": round(step, 6),
        "target_lufs": args.target_lufs,
    }, indent=2) + "\n")
    print(f"wrote {args.dst} ({Path(args.dst).stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
