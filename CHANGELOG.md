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

Everything since `v0.2.0`: the pass described in [`UPGRADE_PLAN.md`](UPGRADE_PLAN.md),
and — from *The feed remembers you* down to *A shelf* — the first group of
[`UPGRADE_PLAN_V2.md`](UPGRADE_PLAN_V2.md), which is about what the app remembers
about the reader.

### Added

- **The reading room has a light switch.** A panel on the post screen with
  three text sizes and focus mode in it. The size is a preference and is kept —
  it moves `--fs-read` and nothing else, because this is a setting about a
  paragraph rather than a zoom control the browser already has a better version
  of — and it is applied by the same pre-paint inline script that sets the
  theme, so a post never arrives at one size and resets to another. Focus mode
  is not kept: it takes the back link, the toolbar, the owner's actions, the
  conversation, what to read next and the demo band off the page, narrows the
  measure to 58ch, and lasts exactly as long as the post is on screen. `f`
  toggles it, Escape leaves it, and the header holds the only other way out.
- **Select a passage and take it with you.** On a mouse, a selection inside a
  post offers to copy itself with the title and the address attached, in curly
  quotes and behind an em dash. Not on a touch screen: the operating system
  already puts Copy, Look Up and Share over a selection, with a handle at each
  end, and ours would be competing for the same forty pixels and doing less.
- **A printed post is a page from a book.** `styles/print.css`, linked with
  `media="print"` so it costs nothing to anyone who isn't printing. It works by
  redefining eleven colour tokens rather than by hunting down every rule that
  draws dark text — which is the argument for a token system, made concretely —
  and then taking the chrome off and setting the body at 11pt. The dark theme
  used to print `#e7edec` on white, which is to say print nothing at all.
- **A shelf.** Save a post from its own screen and it goes on `#/shelf` —
  the feed's column and cards with your saves in it, newest save first. A way
  in appears in the header with the first save and goes with the last, so the
  chrome only exists while there is somewhere for it to lead. What's stored is
  ids, not copies: a snapshot would render instantly and then be wrong in every
  way a post can change, so the screen asks for each one and a post that has
  been deleted drops off the shelf instead of pointing at nothing.
- **Read on.** A post ends with two links into the list you arrived from — the
  feed, a set of results, somebody's page or your shelf — named after that list
  rather than assuming the feed. `j` and `k` follow them, which is the same
  thing those keys already meant one screen out. Two steps in a row keep
  working, because it reads the list the store holds rather than the screen
  behind it.
- **It works offline, and it installs.** A network-first service worker
  precaches the shell and answers from it when there's no network; on the
  published build that is the entire app, since the data was already in
  `localStorage` and the API is a module. Network-first on purpose — see
  [ADR 0007](docs/adr/0007-a-network-first-service-worker.md) — because a
  project with no build step has no content-hashed filenames, and cache-first
  would leave a version constant standing between a reader and every change
  after it.
- **The feed remembers you.** Three things that are one idea, and none of
  them touches the server. A post you have opened draws its title dimmed, so
  what you haven't read is what stands forward — the same channel the warmth
  hairline deliberately doesn't use, so a card can wear both. A returning
  reader gets a count of what arrived while they were away, and a rule through
  the list saying where they left off; the count is exact once the far edge of
  the new run is on screen and given as a floor before that, because the only
  other options were a wrong number or none. And every card says how long it
  is. `commons.read` and `commons.visit` are two keys in `localStorage`, read
  once at boot by `frontend/js/reading.js`, sent nowhere — which is a decision
  about a reading record rather than an omission, and is written down as one.
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
- **`frontend/.nvmrc`**, read by CI, so the Node that writes the lockfile and
  the Node that installs from it can't drift apart.
- **A guard in the Playwright config** that refuses to run when something other
  than `mock_api.py` is answering on the API port — usually a real backend left
  running, which otherwise produces failures that point everywhere but at the
  cause.
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

- **The reading panel switched off the shortcuts that advertise it.** The
  guard that stops a keystroke being stolen from someone typing asked only
  whether the target was an `<input>`, which was true of every input the app had
  until the panel arrived with a radio group in it. Touching the text size meant
  `f`, `j`, `k`, `n`, `t` and `g` all stopped working until focus moved
  somewhere else. A radio, a checkbox or a button has no letter to steal, so
  they no longer count as typing.
- **`js/demo/backend.js` was a binary file.** The key a vote is stored under
  puts a NUL between the voter and the post, and the separator had been written
  as the character rather than as the escape. The module ran correctly and
  always had; what it broke was every tool that reads text — `file` reported
  "data", `grep` matched nothing in 1,082 lines, and `git diff` refused to show
  it. `\u0000` is the same value and the same behaviour, with a note saying why
  it is spelled out.
- **A screen change showed a third screen in between.** Three unrelated faults
  reading as one:
  - The chrome — the search row, the demo band, the document title — was
    rebuilt on `hashchange`, which fires when the link is followed rather than
    when the screen it belongs to arrives. On a phone that left the feed
    wearing the post's one-row header, forty pixels out of place, for as long
    as the post took to load. It now changes inside the swap, so it moves with
    the page and is captured by the same transition.
  - The page cross-fade was the browser's default, which is symmetric and
    composited in `plus-lighter`: both screens at half strength, added
    together, for the full duration. On a dark palette that is not a dissolve,
    it is a glowing double exposure. The blend is now `normal`, the outgoing
    screen holds still underneath rather than fading (so the background is
    never uncovered), and the incoming one is opaque inside seventy
    milliseconds.
  - The glass header needed the opposite treatment for the opposite reason —
    a 55%-alpha snapshot hides nothing painted over it — so both of its ends
    move.
- **The scrollbar jumped about on every navigation.** Nothing reserved the
  track, so a post shorter than the window took the scrollbar away with it and
  every line on the page re-wrapped, twice per visit. `html` now keeps the
  gutter (`overflow-y: scroll`, and `overflow-x` moved up from `body`, which is
  what the sticky header needs), and the thumb is styled to belong to the page
  rather than to the operating system. It is also hidden for the length of a
  view transition: the page is two still images at that point and a scrollbar
  teleporting to the top is the only thing still moving.
- **Comments looked slow on posts that had three of them.** The list asked for
  them only after the post had been drawn — a second round trip that could not
  start until the first finished — and put up grey bars the moment it did. The
  request now leaves with the post's, and the placeholder waits 250ms it
  almost never needs, so the conversation arrives with the post instead of
  flinching in after it.
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
- **`npm ci` failed on CI while working locally.** `@lhci/cli` pins
  `proxy-agent@6`; the `@puppeteer/browsers` reached through Lighthouse 13 wants
  `proxy-agent >=8` as a peer. npm 11 resolved that by installing a second copy
  and not recording it in the lockfile; npm 10 — what Node 22 ships, and what CI
  runs — rebuilt the tree from the lockfile, found eleven packages missing from
  it, and refused. Dropping `@lhci/cli` removed the conflict, and
  `frontend/.nvmrc` stops the two npms drifting apart again.
  [ADR 0006](docs/adr/0006-lighthouse-without-lhci.md).
- **Registering could leave you stranded.** It is two requests, and the account
  is real after the first; if the sign-in behind it failed, the screen still
  said "Make an account" while reporting a failure, and a second attempt
  answered "that username is taken". It now says the account is ready, carries
  the address to the sign-in screen and puts the cursor on the password.
- **`mock_api.py` corrupted its own connection** when `/__fail_next` matched a
  request with a body. It answered before anything read the body, and HTTP/1.1
  keep-alive meant the next request on that connection started mid-form — which
  the browser reports as a CORS error, several steps from the cause.

### Security

- Fixed broken access control on drafts (OWASP A01): the feed and
  `GET /posts/{id}` never checked `published`.
- Closed a login timing oracle that revealed which emails had accounts.
- Security headers on every response. CORS is credentialed now that the
  refresh cookie exists, against an explicit origin list and never a wildcard —
  see `backend/tests/test_cors.py`, which exists to keep it that way.
- `httpx2` pinned to 2.12 — six advisories against the 2.7 line.
- **All ten `npm audit` findings**, seven of them high, every one a transitive
  dependency of `@lhci/cli` — dev tooling, never shipped, but still ten
  advisories in the thing that checks the build. Lighthouse now runs from
  `frontend/tests/lighthouse.mjs`: same three runs, same median, same floors,
  113 packages instead of 444.
- **Signing out left the upvote mirror behind**, so the next person to sign in
  on a shared browser saw filled carets on posts they had never touched — and a
  piece of somebody else's history shown to a stranger.
- **The refresh cookie's `Secure` flag follows `ENVIRONMENT`** rather than
  defaulting to off. Neither fixed default is safe on its own: on breaks every
  development machine silently, off keeps a security property in a deployment
  checklist. `COOKIE_SECURE` still overrides it.

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
