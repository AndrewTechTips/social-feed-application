# Changelog

Notable changes, newest first. Loosely [Keep a Changelog][kac]; versions follow
[semver][semver], with the caveat that nothing here is published as a package,
so the numbers mark milestones rather than promises about an API.

The first eighty-odd commits were written before this file existed and their
messages are, frankly, machine-generated noise. Rewriting them would be
dishonest; the two tags below give that history a readable spine instead. From
here on: one concern per commit, written by hand.

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html

---

## Unreleased

Everything since `v0.2.0` — the pass described in [`UPGRADE_PLAN.md`](UPGRADE_PLAN.md).

### Added

- **Comments.** A nested resource under a post: create, paginated list (oldest
  first), and delete by whoever wrote it. Both foreign keys cascade at the
  database, so deleting a post or an account takes the conversation with it.
  The frontend appends optimistically and rolls back with a toast.
- **Usernames and profiles.** `username` is now the public identity; `UserOut`
  no longer carries an email at all. New `GET /users/me`, `GET /users/{username}`
  and `GET /users/{username}/posts`.
- **Full-text search.** A generated `tsvector` over title (weight A) and body
  (weight B) with a GIN index, `websearch_to_tsquery`, and `ts_rank` ordering —
  replacing `title LIKE '%…%'`. Search now covers the body, understands word
  stems, and treats punctuation as text.
- **Demo mode.** On a static host the app answers its own API calls from
  `js/demo/backend.js`, with a persistent notice saying so. The end-to-end
  suite runs against both that and `mock_api.py`.
- **Command palette** (⌘K / Ctrl-K), with every advertised shortcut working
  outside it too.
- **View transitions** on feed → post: the title you tapped becomes the title
  of the screen you land on.
- **A masthead** for anonymous visitors, which also carries the demo notice.
- **Type checking without a build step.** `// @ts-check` on every module,
  `js/types.js`, `tsc --noEmit` in CI. Same files ship.
- **Refresh tokens.** A 15-minute access token in memory and a 14-day refresh
  token in an `httpOnly`, `SameSite=Lax` cookie scoped to `/auth`, with
  rotation, reuse detection and server-side revocation in a new
  `refresh_sessions` table. `POST /auth/refresh` and `POST /auth/logout`.
  The frontend refreshes transparently — single-flight, because every refresh
  rotates the cookie — so an expired token is invisible and a reload keeps you
  signed in. CSRF is a session-bound `X-CSRF-Token` header; CORS is now
  credentialed against an explicit origin list.
- **The committed OpenAPI spec**, [`docs/openapi.json`](docs/openapi.json),
  with worked examples, documented error responses, tag descriptions and a
  `servers` block. `backend/scripts/export_openapi.py --check` gates it in CI.
- **Decision records** in [`docs/adr/`](docs/adr/), and this changelog.
- **PWA and link-preview assets**: `manifest.webmanifest`, maskable icons, an
  `apple-touch-icon`, a real favicon set and a committed `og.png` — all
  generated from the brand mark by `docs/make_icons.mjs`.
- **`404.html`** that bounces a real path into the hash router, so a
  hand-typed deep link survives a Pages 404.
- **CI gates**: `mypy --strict`, `pip-audit`, `tsc --noEmit`, Lighthouse CI,
  Playwright, `alembic check`, a coverage floor, and a committed coverage badge.
- **Tests**: full-text search, comments, the API's edges (pagination bounds,
  `updated_at`, rejected writes leaving rows untouched, tokens that are signed
  but useless), axe on every screen, and a keyboard-only journey.

### Changed

- Drafts are private to their author, in the feed, by direct URL, through
  search, on a profile, and for voting and commenting.
- Login spends the same time on an unknown email as on a wrong password.
- Indexes added for the feed, the vote count and both foreign keys on comments.
- `Post.votes` is a declared `query_expression()` rather than an attribute
  assigned onto the instance from outside.
- `--accent-text`: the amber accent is a fill colour and could not carry 13px
  text on the light theme (1.84:1). Accented words use the new token.
- `--text-faint` darkened in the light theme; it measured 4.29:1 against the
  page background, under AA.
- **The access token is no longer in `localStorage`.** Storage holds `{id,
  username}` and a CSRF nonce — public, and neither a credential. The old
  `commons.session` key is removed on boot rather than merely unused. ADR 0003
  is rewritten as
  [*The refresh token lives in an `httpOnly` cookie*](docs/adr/0003-token-in-an-httponly-cookie.md),
  superseding the record that said to revisit exactly when this landed.
- Demo mode implements the same auth contract but keeps its refresh token in
  `localStorage`, because a static host has no server to set a cookie from.
  Said plainly in the README and the ADR rather than papered over.

### Fixed

- The composer and the sign-in form never actually autofocused their first
  field: a view transition defers the DOM swap, and focusing a detached
  element is a silent no-op.
- Escape on the delete confirm focused a button that had already been
  replaced, dropping the cursor to the body.
- A vote could be lost when a second click landed while the first was in
  flight; the control now says it's busy.
- A concurrent duplicate vote returns 409 rather than 500.
- The router could render a screen twice, and could leave a signed-in view on
  screen after signing out.
- Search wildcards (`%`, `_`) were live `LIKE` metacharacters.

### Security

- Fixed broken access control on drafts (OWASP A01): the feed and
  `GET /posts/{id}` never checked `published`.
- Closed a login timing oracle that revealed which emails had accounts.
- Security headers on every response; `allow_credentials` dropped from CORS,
  since nothing here uses cookies.
- `httpx2` pinned to 2.12 — six advisories against the 2.7 line.

---

## [0.2.0] — 2026-09-13

The frontend. Plain HTML, CSS and ES modules; no framework, no bundler, no
build step.

### Added

- A hash-routed single page: feed with debounced search and infinite scroll,
  post detail, sign in and register, compose and edit.
- A design system in CSS custom properties — one accent, an 8px rhythm, a
  dark default with a cool light theme, and a pre-paint theme bootstrap.
- Optimistic voting, skeleton loading states, inline delete confirmation,
  `aria-live` toasts, and a focus move on every route change.
- `frontend/tests/mock_api.py`: a standard-library stand-in for the whole API,
  so the Playwright suite runs anywhere without Postgres.
- A mobile pass driven by real-device bugs — tap highlight, the iOS 16px zoom
  threshold, `dvh` over `vh`, safe-area insets, and source guards so a bare
  `100vh` can't come back.

---

## [0.1.0] — 2026-09-07

The API. FastAPI, SQLAlchemy 2.0, Postgres, Alembic, JWT.

### Added

- Posts: create, read, update (PUT and PATCH), delete, with ownership checks
  in one shared dependency.
- Users and JWT authentication; bcrypt with a per-password salt.
- Voting, with the composite primary key as the uniqueness rule.
- A paginated feed with a page envelope, and search over titles.
- Alembic migrations, environment-driven settings, structured logging, rate
  limiting, and a Docker image running as a non-root user.
- A pytest suite against a real Postgres database, and CI that runs it.

[0.2.0]: https://github.com/AndrewTechTips/social-feed-application/releases/tag/v0.2.0
[0.1.0]: https://github.com/AndrewTechTips/social-feed-application/releases/tag/v0.1.0
