#!/usr/bin/env python3
"""Write docs/openapi.json from the running app's schema.

Why commit a generated file at all: the demo says "here's the contract it
implements" and links somewhere. `/docs` is not somewhere — it only exists
while a process is running on somebody's laptop, and this API has no public
deployment. A committed spec is a URL that works, a diff that shows the day the
contract changed, and something `openapi-generator` or a Postman import can be
pointed at without cloning anything.

Usage (from the repo root):
    python backend/scripts/export_openapi.py            # write it
    python backend/scripts/export_openapi.py --check    # fail if it's stale

CI runs --check, the same way it does for the coverage badge, so a route added
without re-exporting turns the build red instead of leaving a spec that quietly
describes last week's API.

Importing the app needs the settings to load, which needs database credentials
in the environment or in .env — the app is never started and nothing connects,
but Settings is strict about what it requires and this script doesn't get to
opt out of that.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.app.main import app  # noqa: E402  (needs sys.path set first)

SPEC = ROOT / "docs" / "openapi.json"


def render() -> str:
    # sort_keys so the file is stable: dict ordering follows the order routes
    # happen to be registered in, and a reshuffle that changes nothing about
    # the API shouldn't produce a diff that looks like it did.
    return json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if the committed spec is out of date",
    )
    args = parser.parse_args()

    fresh = render()

    if args.check:
        if not SPEC.exists():
            print(f"{SPEC.relative_to(ROOT)} is missing — run this without --check.")
            return 1
        if SPEC.read_text(encoding="utf-8") != fresh:
            print(
                f"{SPEC.relative_to(ROOT)} is out of date.\n"
                "Run:  python backend/scripts/export_openapi.py"
            )
            return 1
        print(f"{SPEC.relative_to(ROOT)} is current.")
        return 0

    SPEC.parent.mkdir(parents=True, exist_ok=True)
    SPEC.write_text(fresh, encoding="utf-8")
    print(f"Wrote {SPEC.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
