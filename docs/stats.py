#!/usr/bin/env python3
"""Measure this repo, into frontend/stats.json, for the colophon at ``#/colophon``.

The colophon is a page inside the app that says how the app was made. Numbers
on a page like that are the first thing to rot: nobody edits a sentence because
a test was added, so within a month it is quietly describing last month's
project. The fix is the arrangement ``docs/openapi.json`` and the coverage badge
already have — generate it from the thing it describes, commit the result, and
gate it in CI so a change that moves a number turns the build red instead of
leaving the page lying.

Usage, from the repo root::

    python docs/stats.py            # write docs/stats.json
    python docs/stats.py --check    # fail if it is out of date

── why one script and two CI jobs ──────────────────────────────────────────
Two of the numbers need a toolchain: the backend test count needs pytest, and
the end-to-end count needs a Playwright install. Those live in different jobs
and neither runner has both. So every measurement here is allowed to be
*unavailable*: writing keeps whatever was committed for a number it cannot take,
and ``--check`` verifies the ones it could take and says which those were. The
backend job covers pytest, the frontend job covers Playwright, and between them
every field is checked by somebody.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
# Inside frontend/, because that is the directory the Pages workflow uploads —
# a file under docs/ would be measured, committed, and then unreachable from
# the page that wants to read it. docs/make_icons.mjs generates into
# frontend/ for the same reason.
OUT = ROOT / "frontend" / "stats.json"
BADGE = ROOT / "docs" / "media" / "coverage.svg"

# A value the current environment could not measure. Distinct from 0, which is
# a real answer for at least one of these fields.
UNAVAILABLE = object()


def lines_in(paths) -> int:
    return sum(len(p.read_text(encoding="utf-8").splitlines()) for p in paths)


def js_files() -> list[pathlib.Path]:
    front = ROOT / "frontend"
    return sorted([*(front / "js").rglob("*.js"), front / "sw.js"])


def css_files() -> list[pathlib.Path]:
    return sorted((ROOT / "frontend" / "styles").glob("*.css"))


def runtime_dependencies() -> int:
    """Not devDependencies. The published site loads no third-party code at all;
    everything in package.json is there to test the thing, not to run it."""
    pkg = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    return len(pkg.get("dependencies", {}))


def coverage() -> object:
    """Read back off the committed badge rather than out of ``coverage.xml``.

    The badge is the number this repo already publishes, it is already gated by
    ``coverage_badge.py --check``, and it is in git — so the colophon and the
    README cannot disagree, and a machine with no database can still take this
    measurement.
    """
    if not BADGE.exists():
        return UNAVAILABLE
    found = re.search(r">(\d+)%<", BADGE.read_text(encoding="utf-8"))
    return int(found.group(1)) if found else UNAVAILABLE


def run(cmd: list[str], cwd: pathlib.Path) -> str | None:
    try:
        done = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=600, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return (done.stdout or "") + (done.returncode and (done.stderr or "") or "")


def backend_tests() -> object:
    # Asked for rather than attempted: the frontend CI job has a Python but no
    # pytest, and a subprocess that fails is slower and noisier than a question.
    if importlib.util.find_spec("pytest") is None:
        return UNAVAILABLE
    # --no-cov because collecting with coverage on rewrites backend/coverage.xml
    # from a run in which nothing executed, and the badge is read from a file
    # that is supposed to describe a real one.
    out = run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "--no-cov"],
        ROOT / "backend",
    )
    found = re.search(r"(\d+) tests? collected", out or "")
    return int(found.group(1)) if found else UNAVAILABLE


def e2e_tests() -> object:
    # Two guards, both about the backend CI job, which has a Node but no
    # node_modules: check for the package first, and pass --no-install so that
    # npx refuses to go and fetch Playwright rather than quietly downloading a
    # browser toolchain in a job that has no use for one.
    if not (ROOT / "frontend" / "node_modules" / "@playwright" / "test").exists():
        return UNAVAILABLE
    out = run(
        ["npx", "--no-install", "playwright", "test",
         "-c", "tests/playwright.config.js", "--list"],
        ROOT / "frontend",
    )
    found = re.search(r"Total: (\d+) tests?", out or "")
    return int(found.group(1)) if found else UNAVAILABLE


def measure() -> dict[str, object]:
    """Key order is the order the colophon reads them in, and it is stable —
    --check is a string comparison and a dict that reordered itself would fail
    for no reason anybody could act on."""
    return {
        "js_lines": lines_in(js_files()),
        "css_lines": lines_in(css_files()),
        "modules": len(js_files()),
        "runtime_dependencies": runtime_dependencies(),
        "backend_tests": backend_tests(),
        "e2e_tests": e2e_tests(),
        "coverage": coverage(),
        "decision_records": len(
            [p for p in (ROOT / "docs" / "adr").glob("*.md") if p.name[0].isdigit()]
        ),
    }


def committed() -> dict:
    if not OUT.exists():
        return {}
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def render(values: dict[str, object]) -> str:
    return json.dumps(values, indent=2) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if the committed file disagrees with what can be measured here",
    )
    args = ap.parse_args()

    taken = measure()
    old = committed()
    measurable = {k: v for k, v in taken.items() if v is not UNAVAILABLE}
    skipped = [k for k, v in taken.items() if v is UNAVAILABLE]

    if args.check:
        wrong = {
            k: (old.get(k), v) for k, v in measurable.items() if old.get(k) != v
        }
        checked = ", ".join(sorted(measurable))
        if skipped:
            print(f"not measurable here, so not checked: {', '.join(sorted(skipped))}")
        if wrong:
            for key, (was, now) in sorted(wrong.items()):
                print(f"  {key}: frontend/stats.json says {was!r}, the repo says {now!r}")
            print("\nRun `python docs/stats.py` and commit the result.")
            return 1
        print(f"frontend/stats.json is up to date ({checked})")
        return 0

    # Anything this machine could not measure keeps the number that was
    # committed, so running this without a database or without Playwright
    # installed narrows the file rather than corrupting it.
    values = {k: (measurable[k] if k in measurable else old.get(k)) for k in taken}
    values = {k: v for k, v in values.items() if v is not None}
    OUT.write_text(render(values), encoding="utf-8")
    if skipped:
        print(f"kept the committed value for: {', '.join(sorted(skipped))}")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
