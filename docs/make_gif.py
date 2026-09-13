#!/usr/bin/env python3
"""Assemble docs/media/.frames/*.png into docs/media/tour.gif.

Needs Pillow (`pip install Pillow`) — a docs-time tool only, deliberately not
in backend/requirements*.txt, which is for things the API needs to run.

    node docs/capture.mjs && python docs/make_gif.py
"""

from __future__ import annotations

import pathlib
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is needed to build the GIF:  pip install Pillow")

HERE = pathlib.Path(__file__).resolve().parent
FRAMES = HERE / "media" / ".frames"
OUT = HERE / "media" / "tour.gif"

TARGET_WIDTH = 640
MS_PER_FRAME = 110


def main() -> int:
    files = sorted(FRAMES.glob("*.png"))
    if not files:
        sys.exit(f"no frames in {FRAMES} — run `node docs/capture.mjs` first")

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
        OUT,
        save_all=True,
        append_images=rest,
        duration=MS_PER_FRAME,
        loop=0,
        optimize=True,
        disposal=2,
    )
    size_mb = OUT.stat().st_size / 1_000_000
    print(f"wrote {OUT.relative_to(HERE.parent)}  "
          f"({len(frames)} frames, {first.width}px, {size_mb:.1f} MB)")
    if size_mb > 5:
        print("  warning: over 5 MB — trim frames or drop TARGET_WIDTH", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
