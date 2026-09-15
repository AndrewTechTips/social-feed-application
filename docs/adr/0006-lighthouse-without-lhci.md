# 0006 — Lighthouse runs from a script, not from `@lhci/cli`

**Status:** accepted · 2026-09-15

## What was decided

Drop `@lhci/cli` and `lighthouserc.json`. Run Lighthouse from
[`frontend/tests/lighthouse.mjs`](../../frontend/tests/lighthouse.mjs): a small
static server with gzip, three runs against `?demo=1` through the Chromium the
Playwright suite already pins, Lighthouse's own `computeMedianRun`, and four
category floors. `npm run lighthouse` still means the same thing and CI still
runs it at the same point.

Also pinned: `frontend/.nvmrc` says `22`, `package.json` says
`engines.node >= 22.12.0`, and the workflow reads the Node version from the
file rather than repeating it inline.

## Why

Two failures with one cause, both found on the way to the first public release.

**Every `npm audit` finding came from this one dependency.** Ten of them, seven
high: `puppeteer-core` → `extract-zip`, `inquirer` → `external-editor` → `tmp`,
and `uuid`. None of it ships — the app has zero runtime dependencies and this is
a CI-only tool — but "all of our vulnerabilities are in the thing that checks
our quality" is not a sentence worth keeping. The fix was not available: the
last `@lhci/cli` release is 0.15.1, from June 2025, and it pins its own copy of
Lighthouse 12, which is inside the vulnerable range. `npm audit fix --force`
offers to "solve" it by installing `@lhci/cli@0.1.0`, which is not a fix.

**And it broke `npm ci` on CI while working locally.** `@lhci/cli` pins
`proxy-agent@6`. The current `@puppeteer/browsers` — reached through
`lighthouse@13`, the version this repo actually declares — asks for
`proxy-agent >=8` as a peer dependency. Both cannot be satisfied in one hoisted
tree. npm 11 (Node 24, what this machine runs) resolved that by installing a
second, newer `proxy-agent` for the peer and **not recording it in the
lockfile**; npm 10 (Node 22, what CI runs) rebuilt the tree from the lockfile,
found eleven packages it needed and had no entries for, and refused:

```
npm error Missing: http-proxy-agent@9.1.0 from lock file
npm error Missing: proxy-agent-negotiate@1.1.0 from lock file
...
```

Which is npm 10 being right. The lockfile was incomplete. Two things had to
change for that to stop being possible: the conflict had to go, and the npm that
writes the lockfile had to be the npm that installs from it.

Removing `@lhci/cli` took the dependency count from **444 packages to 113** and
the audit from **ten findings to none**.

## What it cost

About sixty lines of script, and they are lines that have to be maintained.
What they do that `lhci autorun` did for free:

- **Three runs and the median.** `computeMedianRun` is exported by Lighthouse
  itself, so this is the same median, not a reimplementation of one.
- **A static server.** With gzip on text and a long cache on assets, because
  without the first of those "Enable text compression" fails and the
  performance score measures the harness rather than the site. GitHub Pages
  compresses; so does this.
- **The floors**, as four numbers in one object rather than four entries in a
  config file.

What was lost is what this repo never used: LHCI's server upload targets, its
assertion presets, and its GitHub status-check integration. The reports still
land in `tests/.lighthouse` and CI still uploads them as an artifact.

One real gain beyond the audit: Lighthouse now drives the **Chromium the
lockfile pins**, the same binary the Playwright suite uses, rather than whatever
Chrome `chrome-launcher` finds on the machine. A score that moves now means the
site moved.

## When to change our minds

If `@lhci/cli` starts shipping again and catches up to Lighthouse 13, going back
is a small change — the floors are the only thing that would need re-expressing.
The thing that would actually make it worth going back is wanting LHCI's server:
score history over time, and a comment on the pull request. Neither means much
on a repo with one contributor and no pull requests.

If this script grows past roughly its current size — a second URL, mobile *and*
desktop presets, per-audit assertions — that is the signal that it has become a
worse version of a tool that already exists.
