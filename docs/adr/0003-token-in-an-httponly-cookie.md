# 0003 — The refresh token lives in an `httpOnly` cookie

**Status:** accepted · 2026-09-14
**Supersedes:** "The token lives in `localStorage`" (accepted with reservations,
2026-09-13). That record said the thing to do next was refresh tokens, and that
the moment they landed was the moment to move to cookies. They have, so it did.
The original is below, under *What this replaced*, because a decision record
that quietly rewrites its own history is not one.

## What was decided

Two tokens.

- A **access token**, 15 minutes, returned in the response body and held in a
  JavaScript variable. It goes out as `Authorization: Bearer …` on every
  content route, exactly as before. It is never written to storage, so a reload
  loses it.
- A **refresh token**, 14 days, returned in a cookie marked `HttpOnly`,
  `SameSite=Lax`, `Path=/auth` (and `Secure` wherever there is TLS). No script
  on the page can read it. `POST /auth/refresh` trades it for a new access
  token and rotates it; `POST /auth/logout` revokes it.

`localStorage` still holds two things, and neither is a credential: `{id,
username}` so the header can paint before the first request comes back, and a
CSRF nonce (below). Both are public; neither gets anybody in.

## Why

The previous decision's stated cost was that any XSS on this origin could read
the token and walk away with the session. That is the difference this closes:
an XSS bug can still *act as* the user for as long as the page is open, and it
can no longer *take the session with it*. Everything else here exists to make
that split workable.

**The refresh token is opaque, not a JWT.** `"<family id>.<secret>"`. Nothing
in it needs to be readable by anyone, a database lookup has to happen anyway to
rotate it, and an opaque string cannot be confused with an access token by
either side.

**Sessions are a table, and that is most of the point.** A self-contained
refresh JWT would have needed no schema and could not be taken back: signing
out would clear a cookie on one machine and leave the token valid everywhere
else for a fortnight. Revocation is the reason for splitting the tokens at all,
and revocation needs somewhere to write "not any more". Only a SHA-256 of the
secret is stored — not bcrypt, because there is nothing to guess in 256 bits
from `secrets`, and the row is found by exact hash lookup rather than by
comparing candidates, so there is no timing signal either.

**Rotation, with a grace window.** Every refresh mints a new secret into the
same family row. A copied cookie is then detectable: the copy eventually
presents a secret that has already been rotated away, and since there is no way
to tell which holder is the thief, the family is revoked and both sign in
again. Taken literally this also breaks two tabs — they share a cookie jar, so
reloading both at once has the second request presenting what the jar held a
moment ago — so the previous secret stays acceptable for 15 seconds. That is a
real narrowing of the detection, and the alternative is a feature that signs
you out for opening a second tab.

**CSRF is a synchronizer token, not a double-submit.** A cookie is attached by
the browser whether or not the page meant to send it, so `/auth/refresh` and
`/auth/logout` require an `X-CSRF-Token` header matching a value bound to the
session. The usual double-submit trick — put the token in a readable cookie and
echo it back — does not work here: the frontend and the API are different
origins, so the page cannot read the API's cookies. So the token comes back in
the response body and the client keeps it.

It is kept in `localStorage`, and that is not a retreat. It is not a
credential: presented without the cookie it opens nothing, and its only job is
to prove that whoever sent the request could read one of our responses, which a
cross-site page cannot do and cannot read `localStorage` to fake. It needs to
survive a reload because the cookie does and memory doesn't — a client with
nowhere to keep it would hold a live session it could never refresh. It does
not rotate, because two tabs each hold their own copy and rotating would let
the one whose response landed second store a value the server had already
replaced.

**Three layers, not one.** `SameSite=Lax` means a cross-site POST carries no
cookie at all. `Path=/auth` means no content route ever sees it, so the data
plane is still a pure bearer-header API and a forged request to `POST /posts/`
carries nothing the browser will attach. The CSRF token is what holds if either
of those is wrong.

**And the failure modes are boring on purpose.** Every way of being wrong —
missing, malformed, expired, revoked, replayed, or a good cookie with a bad
header — is the same 401 with the same body, because saying *which* way tells a
caller whether they hold half of a real session. The one thing that differs is
invisible from the outside: a cookie that can only fail again is expired on the
way out, and a good cookie refused on CSRF is left alone — clearing it there
would turn a forged request into a forced sign-out.

## What it cost

**A day, a table, a migration, and three implementations.** `refresh_sessions`
is the first table here that exists for the mechanics of the application rather
than for its subject matter. `tests/mock_api.py` and `js/demo/backend.js` both
had to grow the same flow, because the end-to-end suite runs against all three
and a mock that disagrees with the API is how a suite certifies a bug.

**Credentialed CORS.** `allow_credentials=True` makes the origin list
load-bearing rather than a courtesy, and makes `allow_origins=["*"]` illegal
rather than merely unwise. `tests/test_cors.py` exists to say so out loud.

**A trap worth writing down.** In development the frontend is on
`localhost:5173` and the API on `localhost:8000` — different origins, *same
site*, because cookies ignore the port. That is why `SameSite=Lax` works.
Serving the frontend from `127.0.0.1` instead makes it cross-site and the
cookie silently vanishes.

**The demo can't have any of it.** See below.

## The demo is honest about not doing this

The published site answers its own API calls from `js/demo/backend.js`, in the
page, because a static host has nowhere to run FastAPI. There is no server and
no origin boundary, so there is no `Set-Cookie` to send and nothing an
`httpOnly` flag could hide a value *from* — the "backend" is JavaScript in the
same window as the app.

So the demo implements the same **contract** — the same endpoints, the same
rotation, the same grace window, the same reuse detection, the same flat 401 —
and keeps the refresh token in its own state, which is the `localStorage` blob
everything else in the demo lives in. The frontend cannot tell the difference,
because in neither case does it ever see the value; that is what makes it worth
running the same end-to-end suite against both.

What it does *not* do is claim the security property. In demo mode the refresh
token is in `localStorage`, exactly what this decision moved away from. Faking
a cookie there would be theatre, and the sort that implies something untrue
about the published site. The end-to-end suite's mock — a real HTTP server on a
real origin — is where the cookie and its flags are actually exercised.

## When to change our minds

The grace window and the rotation policy are the two dials here. If this ever
holds anything a person would mind losing, the window comes down and reuse
detection should page somebody rather than just revoking quietly. And if the
frontend ever ends up served from the same origin as the API, the CSRF token
should move to a readable cookie and out of `localStorage` — the only reason it
is there is that it can't be read from another origin.

## What this replaced

The original decision, kept verbatim because the argument it makes is the one
this record answers:

> **Status:** accepted, with reservations · 2026-09-13
>
> After login the JWT is stored under `commons.session` in `localStorage`,
> alongside the signed-in user's id and username. Every request attaches it as
> `Authorization: Bearer …`.
>
> The alternative — an `httpOnly`, `SameSite` cookie — is genuinely more secure
> against the attack that matters here, and it isn't a frontend decision. It
> needs the backend to set and clear the cookie, CSRF protection on every
> state-changing route (because a cookie is sent automatically and a bearer
> header is not), `allow_credentials` on CORS, and a refresh-token flow to make
> short cookie lifetimes bearable. That is a real piece of backend work.
>
> **Any XSS on this origin can read the token.** [...] An `httpOnly` cookie is
> not, so an XSS bug would let an attacker *act as* the user but not *walk away
> with* their session. That difference is real and this decision gives it up.
>
> **When to change our minds:** the moment this stops being a portfolio app
> with fixture data [...] Concretely: when refresh tokens land — they need the
> same server-side session plumbing, so the two are one piece of work, not two.

One line of it turned out to be wrong, and it is worth naming: CSRF protection
was not needed "on every state-changing route". Scoping the cookie to `/auth`
means the content routes never see it and stay exactly as they were. The rest
held up.
