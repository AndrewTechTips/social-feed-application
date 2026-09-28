#!/usr/bin/env python3
"""Compile backend/requirements*.in into backend/requirements*.txt.

The two `.in` files are hand-written and hold direct dependencies only. The two
`.txt` files beside them are generated: the whole graph, transitive packages
included, pinned to an exact version and hashed. **The `.txt` files are what
gets installed** — by CI, by the Dockerfile, and by anybody following the
README. Nothing installs a `.in`.

Usage (from the repo root):
    python backend/scripts/lock.py             # relock
    python backend/scripts/lock.py --check     # fail if the lock is stale
    python backend/scripts/lock.py --upgrade   # and take new upstream releases

Why a lockfile at all
─────────────────────
Transitive dependencies used to be left unpinned, and on 2026-09-28 that cost a
red build nobody had caused: Starlette 1.7 changed `CORSMiddleware` to append
`Vary: Origin` unconditionally, and a push that touched only frontend files
failed on tests/test_etag.py. Pinning the graph means a new upstream release
arrives when somebody runs this with --upgrade, which is a commit, a diff and a
test run — not on whatever afternoon it happens to be published.

Why `uv` rather than `pip-compile`
──────────────────────────────────
`--universal`. pip-tools resolves for the machine it runs on, so a lock
compiled on a laptop encodes that laptop: this project is developed on macOS
and tested on ubuntu-latest, and the graph carries platform-conditional
packages (`uvloop`, and the wheels behind `psycopg2-binary`). uv resolves for
every platform at once and writes environment markers, so one file is correct
in both places and the lock does not depend on who ran it.

What `--check` does and does not catch
──────────────────────────────────────
It recompiles and compares. Without `--upgrade`, uv *prefers the versions
already pinned in the output file*, so a recompile is idempotent — which is the
property that makes this a usable gate rather than a tripwire. It goes red when
a `.in` was edited and the lock was not regenerated. It does **not** go red
because something new was published upstream; that is the whole point.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent

# Matches the version CI runs on (actions/setup-python, `python-version: 3.14`).
# Pinned here rather than taken from the interpreter running this script: the
# lock is a statement about the environment the app is deployed into, and it
# should not change because somebody relocked on a different laptop.
PYTHON_VERSION = "3.14"

# (input, output) — dev second, because it reads `-r requirements.in`.
PAIRS = [
    ("requirements.in", "requirements.txt"),
    ("requirements-dev.in", "requirements-dev.txt"),
]


def uv() -> str:
    """The resolver. It is in requirements-dev.in, so a dev environment has it."""
    found = shutil.which("uv")
    if found:
        return found
    sys.exit(
        "uv is not on PATH.\n"
        "It is a dev dependency, so the usual fix is to install them:\n"
        "    pip install -r backend/requirements-dev.txt\n"
        "or, on its own:  pip install uv"
    )


def compile_one(src: str, out: Path, *, upgrade: bool) -> None:
    cmd = [
        uv(),
        "pip",
        "compile",
        src,
        "--universal",
        "--generate-hashes",
        "--python-version",
        PYTHON_VERSION,
        "--output-file",
        str(out),
        "--quiet",
        # So the header in the generated file names something runnable, rather
        # than the long uv invocation this script happens to build.
        "--custom-compile-command",
        "python backend/scripts/lock.py",
    ]
    if upgrade:
        cmd.append("--upgrade")
    subprocess.run(cmd, cwd=BACKEND, check=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--check",
        action="store_true",
        help="fail if the lockfiles are not what the .in files compile to",
    )
    ap.add_argument(
        "--upgrade",
        action="store_true",
        help="take the newest releases allowed by the .in files",
    )
    args = ap.parse_args()

    if args.check and args.upgrade:
        ap.error("--check and --upgrade ask for opposite things")

    if not args.check:
        for src, name in PAIRS:
            compile_one(src, BACKEND / name, upgrade=args.upgrade)
        what = "relocked" if args.upgrade else "locked"
        print(f"{what}: " + ", ".join(f"backend/{name}" for _, name in PAIRS))
        return 0

    # --check: compile to a scratch path and compare, leaving the real files
    # alone. Writing them and putting them back would be a worse failure if
    # this were interrupted half way.
    stale = []
    for src, name in PAIRS:
        real = BACKEND / name
        scratch = BACKEND / f".{name}.check"
        try:
            # The existing lock is what uv prefers its pins from, so the
            # comparison is "does this still compile to the same thing", not
            # "has anything been released since".
            shutil.copyfile(real, scratch)
            compile_one(src, scratch, upgrade=False)
            if scratch.read_text() != real.read_text():
                stale.append(name)
        finally:
            scratch.unlink(missing_ok=True)

    if stale:
        print(
            "these lockfiles are out of step with the .in files beside them:\n"
            + "".join(f"  backend/{name}\n" for name in stale)
            + "\nRun `python backend/scripts/lock.py` and commit the result.",
            file=sys.stderr,
        )
        return 1

    print("lockfiles are up to date (" + ", ".join(n for _, n in PAIRS) + ")")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
