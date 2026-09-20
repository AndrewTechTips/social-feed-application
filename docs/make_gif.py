#!/usr/bin/env python3
"""Assemble a directory of numbered PNGs into an animated GIF.

Needs Pillow (`pip install Pillow`) — a docs-time tool only, deliberately not
in backend/requirements*.txt, which is for things the API needs to run.

Two sequences use it, and the defaults are the first one's:

    node docs/capture.mjs      && python docs/make_gif.py
    node docs/capture-pwa.mjs  && python docs/make_gif.py --frames .frames-pwa --out pwa.gif

Both paths are taken relative to docs/media/, because that is the only place
either of them has ever pointed.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is needed to build the GIF:  pip install Pillow")

HERE = pathlib.Path(__file__).resolve().parent
MEDIA = HERE / "media"

TARGET_WIDTH = 640
MS_PER_FRAME = 110


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--frames",
        default=".frames",
        help="directory of numbered PNGs, relative to docs/media/",
    )
    parser.add_argument(
        "--out", default="tour.gif", help="the GIF to write, relative to docs/media/"
    )
    args = parser.parse_args()

    frames_dir = MEDIA / args.frames
    out = MEDIA / args.out

    files = sorted(frames_dir.glob("*.png"))
    if not files:
        sys.exit(f"no frames in {frames_dir} — run the matching capture script first")

    frames = []
    for f in files:
        im = Image.open(f).convert("RGB")
        if im.width != TARGET_WIDTH:
            h = round(im.height * TARGET_WIDTH / im.width)
            im = im.resize((TARGET_WIDTH, h), Image.LANCZOS)
        # A dark UI with soft gradients quantises badly on the default
        # web-safe palette; an adaptive one keeps the ambers from banding.
        frames.append(im.quantize(colors=64, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG))

    first, rest = frames[0], frames[1:]
    first.save(
        out,
        save_all=True,
        append_images=rest,
        duration=MS_PER_FRAME,
        loop=0,
        optimize=True,
        disposal=2,
    )
    size_mb = out.stat().st_size / 1_000_000
    print(f"wrote {out.relative_to(HERE.parent)}  "
          f"({len(frames)} frames, {first.width}px, {size_mb:.1f} MB)")
    if size_mb > 5:
        print("  warning: over 5 MB — trim frames or drop TARGET_WIDTH", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
