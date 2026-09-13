#!/usr/bin/env python3
"""Render docs/media/coverage.svg from backend/coverage.xml.

Why a script and not a service: shields.io or Codecov would do this in one
line, but both mean the badge on the README depends on a third party staying
up and on this repo staying registered with it. The number comes from a file
this repo already produces, so it may as well come from here.

Usage (from the repo root, after a test run):
    python backend/scripts/coverage_badge.py            # write the badge
    python backend/scripts/coverage_badge.py --check    # fail if it's stale

CI runs --check, so a coverage move that nobody re-rendered turns the build
red instead of leaving a badge that quietly lies.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[2]
COVERAGE_XML = ROOT / "backend" / "coverage.xml"
BADGE_SVG = ROOT / "docs" / "media" / "coverage.svg"

# Rounded to whole percent on purpose: a badge that churns on every ±0.1%
# turns --check into noise nobody reads.
COLOURS = [
    (95, "#1f8a3b"),  # green
    (90, "#4c9f2f"),
    (80, "#97ac0f"),
    (70, "#c8a000"),
    (0, "#c04b2f"),  # red
]


def read_percent(path: pathlib.Path) -> int:
    if not path.exists():
        sys.exit(f"{path} not found — run the test suite first (cd backend && pytest)")
    line_rate = float(ET.parse(path).getroot().get("line-rate", 0))
    return round(line_rate * 100)


def colour_for(percent: int) -> str:
    return next(colour for threshold, colour in COLOURS if percent >= threshold)


def render(percent: int) -> str:
    label, value = "coverage", f"{percent}%"
    # 6.5px per character is a decent approximation of the 11px DejaVu Sans
    # that every badge in the wild uses; padded by 10px each side.
    label_w = int(len(label) * 6.5) + 10
    value_w = int(len(value) * 6.5) + 10
    total_w = label_w + value_w
    colour = colour_for(percent)

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w}" height="20" '
        f'role="img" aria-label="{label}: {value}">'
        f"<title>{label}: {value}</title>"
        f'<linearGradient id="s" x2="0" y2="100%">'
        f'<stop offset="0" stop-color="#bbb" stop-opacity=".1"/>'
        f'<stop offset="1" stop-opacity=".1"/></linearGradient>'
        f'<clipPath id="r"><rect width="{total_w}" height="20" rx="3" fill="#fff"/></clipPath>'
        f'<g clip-path="url(#r)">'
        f'<rect width="{label_w}" height="20" fill="#555"/>'
        f'<rect x="{label_w}" width="{value_w}" height="20" fill="{colour}"/>'
        f'<rect width="{total_w}" height="20" fill="url(#s)"/></g>'
        f'<g fill="#fff" text-anchor="middle" '
        f'font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">'
        f'<text x="{label_w / 2}" y="15" fill="#010101" fill-opacity=".3">{label}</text>'
        f'<text x="{label_w / 2}" y="14">{label}</text>'
        f'<text x="{label_w + value_w / 2}" y="15" fill="#010101" fill-opacity=".3">{value}</text>'
        f'<text x="{label_w + value_w / 2}" y="14">{value}</text>'
        f"</g></svg>\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if the committed badge doesn't match coverage.xml",
    )
    args = parser.parse_args()

    percent = read_percent(COVERAGE_XML)
    svg = render(percent)

    if args.check:
        current = BADGE_SVG.read_text() if BADGE_SVG.exists() else ""
        if current != svg:
            print(
                f"coverage badge is out of date (coverage is now {percent}%).\n"
                f"Re-render it with:  python backend/scripts/coverage_badge.py",
                file=sys.stderr,
            )
            return 1
        print(f"coverage badge is current ({percent}%)")
        return 0

    BADGE_SVG.parent.mkdir(parents=True, exist_ok=True)
    BADGE_SVG.write_text(svg)
    print(f"wrote {BADGE_SVG.relative_to(ROOT)} ({percent}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
