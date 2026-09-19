# 0009 — A version in the path, and paying for it now

**Status:** accepted · 2026-09-19

## What was decided

Every route the API serves moved under `/api/v1`. The prefix is a constant in
`backend/app/config.py`, attached once by a parent `APIRouter` in `main.py`.

Two routes stayed where they were: `/` and `/healthz`. Neither is asked for by
a client of the API — they are asked for by whatever is running the container —
and a liveness probe that moves when the API version moves is a probe that
breaks a deployment on the day it is least welcome.

No aliases, no redirects from the old paths. This is a clean move.

## Why now, when nothing depends on it

That is the reason, not an objection to it.

A version in the path buys exactly one thing: the ability to change the
contract without breaking whoever is already using it. That option has to be
bought *before* it is needed, because the moment it is needed is the moment it
has stopped being available. Today the API has one client, in this repository,
and moving every path costs an afternoon. After a single person writes a script
against `/posts/`, the same change costs a deprecation window, two sets of
routes to keep in step, and a conversation.

The honest version of the argument is that this is cheap insurance and the
premium only ever goes up.

## What it actually cost

Worth writing down, because it is the part that is invisible until it happens.

**The refresh cookie's Path moved with it.** `REFRESH_COOKIE_PATH` is derived
from the prefix, so it went from `/auth` to `/api/v1/auth`. A browser only
sends a cookie to the path it was issued for, so every session that existed
before the change stopped being sent and every reader had to sign in again
once. Nothing was lost and nothing was insecure; the old cookie simply became
unreachable and expired on its own fourteen days later.

That is survivable here and would not be survivable on an app with users
asleep in another timezone. The cookie path is scoped deliberately — see
[ADR 0003](0003-token-in-an-httponly-cookie.md) — so it was never going to
stay put, and the choice was between paying this on an afternoon in September
or paying it later with an audience.

**`tokenUrl` on the OAuth2 scheme.** It is relative, resolved against the docs
page, so it is `api/v1/login` with no leading slash. Get this wrong and
everything works except the "Authorize" button in `/docs`, which is the kind of
breakage nobody notices for a month.

**Three hundred test call sites, avoided.** The test client is based at
`http://testserver/api/v1`, so a test still writes `/posts/` — the path it is
testing — rather than repeating the version. `test_app.py` asks for
`http://testserver/healthz` absolutely, which is the one file that has to know
the prefix exists, and it says why.

## What was deliberately not done

**Header or query-parameter versioning.** `Accept: application/vnd.commons.v1`
is more correct in the sense that a URL should name a resource rather than a
representation of it, and it is worse in every practical way that matters here:
it cannot be pasted into a browser, it cannot be linked in a README, and it
makes `curl` examples in documentation twice as long. The path is the version
that people can see.

**Serving the old paths alongside the new ones.** A compatibility shim is the
right answer when somebody depends on the old paths. Nobody does. Writing one
now would double the surface the tests have to cover in order to protect a
client that does not exist.

**Versioning the frontend's own paths.** `#/posts/1` is a hash route in a
single-page app, not an API path. It has no contract with anyone.

## When to change our minds

- **When `v2` is actually needed**, the answer is not to edit this constant.
  It is to mount a second parent router beside the first and let `v1` go on
  answering until it is measurably unused.
- **If the API ever gets a client outside this repository**, the clean-move
  policy above expires with it. From that point a path change needs a
  deprecation window, and this document should be amended to say so rather
  than quietly ignored.
