# 0003 — The token lives in `localStorage`

**Status:** accepted, with reservations · 2026-09-13

## What was decided

After login the JWT is stored under `commons.session` in `localStorage`,
alongside the signed-in user's id and username. Every request attaches it as
`Authorization: Bearer …`.

## Why

The alternative — an `httpOnly`, `SameSite` cookie — is genuinely more secure
against the attack that matters here, and it isn't a frontend decision. It
needs the backend to set and clear the cookie, CSRF protection on every
state-changing route (because a cookie is sent automatically and a bearer
header is not), `allow_credentials` on CORS, and a refresh-token flow to make
short cookie lifetimes bearable. That is a real piece of backend work.

The API is also a bearer-token API by design: it is meant to be usable from
`curl` and from `/docs` as much as from this frontend, and cookie auth makes
both of those worse.

## What it cost

Stated plainly, because this is the tradeoff people look for:

**Any XSS on this origin can read the token.** `localStorage` is readable by
any script that runs on the page. An `httpOnly` cookie is not, so an XSS bug
would let an attacker *act as* the user but not *walk away with* their session.
That difference is real and this decision gives it up.

What it is *not* is a CSRF exposure — a bearer header is never attached
automatically by the browser, which is why `allow_credentials` is deliberately
off in the CORS config.

What compensates, partially:

- No `innerHTML` anywhere in the app. Every element is built through `h()`,
  which sets `textContent`, so user-supplied text is never parsed as markup.
- Tokens expire in 60 minutes and there is no refresh, so a stolen one has a
  short life.
- `X-Content-Type-Options`, `X-Frame-Options: DENY` and a `Referrer-Policy` of
  `no-referrer` on every response.

## When to change our minds

The moment this stops being a portfolio app with fixture data and holds
anything a person would mind losing. Concretely: when refresh tokens land —
they need the same server-side session plumbing, so the two are one piece of
work, not two. That is the point to move to `httpOnly` cookies and add CSRF
tokens, not before.
