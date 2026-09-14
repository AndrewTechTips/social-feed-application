# 0004 — Demo mode is the answer to a static host

**Status:** accepted · 2026-09-13

## What was decided

On GitHub Pages, the app answers its own requests. `apiFetch()` in
[`js/config.js`](../../frontend/js/config.js) is either `window.fetch` against
the real API or [`js/demo/backend.js`](../../frontend/js/demo/backend.js) — the
same contract reimplemented in about 800 lines of browser JavaScript, with
state in `localStorage` and ~150 ms of simulated latency.

A persistent strip under the header says so, on every visit, and links to the
real backend.

## Why

The constraint is fixed: static host, no server, ever. That leaves two honest
options.

**Read the code and run it yourself.** Zero risk of misrepresenting anything,
and cheap. But it asks the reviewer to clone a repo, install Postgres, run
Alembic and start two servers — which almost nobody does on a first pass. The
failure mode is worse than the cost: publishing a Pages link that opens on
"Can't reach the server. Is the backend running?" is materially worse than
publishing no link.

**A labelled demo backed by fixture data.** The decisive argument is that it
was already written. `frontend/tests/mock_api.py` was a faithful
standard-library implementation of the whole contract, validated by the
end-to-end suite. Porting it to a browser module was a translation of code that
already existed and was already tested.

Three things made it cheap here specifically: every network call already
funnelled through one function; hash routing means Pages needs no
configuration; and pointing the Playwright suite at the adapter meant the same
specs covered both.

## What it cost

- **A third implementation of the same contract.** There are now three: the
  FastAPI app, `mock_api.py`, and `demo/backend.js`. Three copies of one rule
  is two too many, and it has already drifted twice — draft visibility, then
  usernames — each time caught only because the suite runs against all of them.
  Running both projects in CI is not a nicety here; it is the only thing
  holding the three together.
- **It risks reading as "this is just a frontend."** That is a presentation
  problem with a presentation fix: the strip names the constraint, says what
  was built, and points at `backend/`.
- Realistic latency in the adapter immediately exposed three bugs the instant
  mock had been hiding — specs matching loading skeletons, a vote control
  silently swallowing a second click, and a reset that left the app holding a
  dead session.

## When to change our minds

If a real backend ever gets somewhere to live — a free tier that doesn't cold
start into a 30-second wait, or a host worth paying for — point `API_BASE` at
it, delete `demo/`, and delete this decision. Nothing else in the app knows
which one it is talking to, which was the point.
