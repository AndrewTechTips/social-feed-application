# Commons — upgrade plan

An audit of `backend/`, `frontend/`, both test suites, the CI workflow and both READMEs,
plus a concrete plan to take this from "a good learning project" to "a repo that makes a
recruiter stop scrolling."

Written 2026-09-13, against `8fcdad3` (clean tree, 79 commits).

---

## 1. What's already good

Worth stating plainly, because the plan below is mostly criticism and the starting point
is genuinely above average for a portfolio repo:

- **The backend is modern, not dated.** SQLAlchemy 2.0 `Mapped`/`select()` throughout,
  Pydantic v2, PyJWT, `lifespan` instead of `@on_event`, `datetime.now(UTC)`. No
  `Query.filter_by` legacy style anywhere. This reads as 2026 code, not a 2021 course
  repo with the serial numbers filed off.
- **`get_owned_post` as a dependency** (`backend/app/routers/post.py:28`) is the single
  best design decision in the backend — the 404-then-403 ownership rule lives in one
  place and three routes share it. That's the thing most course projects copy-paste.
- **`filterwarnings = error`** in `pytest.ini` with one documented, justified exemption.
  Very few people do this.
- **The comments explain *why*, not *what*.** `limiter.py`'s circular-import note,
  `tokens.css`'s iOS 16px explanation, `components.css`'s note on why `backdrop-filter`
  is dropped below 640px. This is the strongest signal in the whole repo that a person
  was thinking, and it should be protected in every change below.
- **`mock_api.py`** — 501 stdlib-only lines implementing the full API contract so the
  E2E suite is hermetic. This is a senior instinct, and (see §3) it's also the thing that
  makes the demo-mode plan cheap.
- **The mobile pass is real engineering**, not a media query. Tap-highlight, the 16px
  iOS zoom threshold with *both* the width and pointer query and a written justification
  for each, `dvh` over `vh`, safe-area insets, and source-level guards in
  `mobile.spec.js:387` that fail the build if a bare `100vh` comes back.
- **Repo hygiene is clean.** `.env` was never committed (verified across all refs), no
  hardcoded credentials in tracked files, `.idea/` untracked.

Keep all of it. The plan below adds; it doesn't rewrite.

---

## 2. The first 60 seconds

How this actually lands on someone who clicks through from your GitHub profile:

| Second | What they see | Verdict |
| --- | --- | --- |
| 0–5 | Repo name `social-feed-application`. No description, no topics, no link. | Generic. Reads like coursework. |
| 5–15 | README H1: **"Social Feed API"**. First line: "built as a backend-engineering learning project." Second paragraph: "Started from the freeCodeCamp course." | **This is the biggest problem in the repo.** The first two things you tell a reviewer are that it's a learning project and that it started from a tutorial. Both true, both honest, both actively working against you. Worse: the polished UI you spent the most craft on isn't mentioned until line 57. |
| 15–30 | No screenshot. No GIF. No live link. No badges. | Nothing to look at. They are now deciding whether to read a stack table. |
| 30–60 | Stack table, a mermaid architecture diagram (good), layout tree, run instructions. | Good content, but it's reference documentation. They have to *choose* to read it. |
| If they click *Commits* | `feat: enhance mobile experience by improving tap feedback, adjusting form control sizes, and optimizing layout for narrow screens; add new sign-out icon and update styles for better accessibility` | Obviously machine-generated, and mixes unrelated concerns in one commit. |
| If they look for a license | There isn't one. | Technically all-rights-reserved. Reads as inattention. |

The engineering is a long way ahead of the presentation. Section 7's Tier 0 fixes almost
all of this in under a day.

---

## 3. The demo-story fix

> **Constraint:** GitHub Pages only. Static host. No paid server, no free-tier external
> hosting for the running app, ever. The FastAPI backend has nowhere to live in production.

### The two options, weighed honestly

**Option B — "read the code, run it yourself" case-study README.**

*For:* zero risk of misrepresenting the project. Cheap (a day of screenshots and writing).
Nothing can break. Keeps the backend front and centre, which is where most of the
engineering depth is.

*Against:* it asks the reviewer to do work. A recruiter, and most hiring engineers doing a
first pass, will not clone a repo, install Postgres, run Alembic and start two servers.
They will look at your GIFs — which prove the UI *existed on your machine* — and move on.
And the failure mode is brutal: if you publish a GitHub Pages link at all and it shows
"Can't reach the server. Is the backend running?" (the exact string in `api.js:49`), that
is materially worse than having no link.

**Option A — clearly-labelled demo mode backed by seeded fixture data.**

*For, and this is the decisive argument:* **you have already written it.**
`frontend/tests/mock_api.py` is a faithful, complete implementation of the API contract —
users, tokens, posts, votes, pagination, search, 401/403/404/409/422 — and it is already
validated by 660 lines of Playwright specs. Porting it to a browser module is a mechanical
translation of code that already exists and is already tested. The risk normally attached
to "build a fake backend for the demo" has been retired in advance.

Three more things make it cheap here specifically:

1. **The seam already exists.** Every network call in the app funnels through one function,
   `request()` in `frontend/js/api.js:28`, and the origin is a single constant in
   `config.js`. The demo adapter drops in at exactly one place.
2. **The tests come along for free.** Point `playwright.config.js` at the demo adapter and
   the same suite covers demo mode. A tested demo mode is itself an engineering signal.
3. **Hash routing means GitHub Pages needs no configuration.** All paths are `#/...`, all
   asset references are relative (`./styles/…`, `./assets/…`), so serving from
   `https://<you>.github.io/<repo>/` works with no base-href rewriting.

*Against, stated fairly:* a demo with no server risks reading as "this is just a frontend."
That's a presentation problem, and it has a presentation fix — see the framing below.

### Recommendation: **Option A, with Option B's writing as a required companion**

These were never really alternatives. Build the demo mode *and* write the case-study README
— the README work in Tier 0 is needed regardless, and the demo mode is what gets anyone to
read it.

**The framing that makes demo mode a strength rather than an apology.** Don't hide it and
don't over-apologise. One persistent, quiet strip under the header:

> Demo mode — this runs entirely in your browser. The real FastAPI backend is in
> [`backend/`](…); here's [the API contract](…) it implements. Nothing you post is saved
> anywhere. [Reset the demo]

That sentence does four jobs at once: it's honest, it names the constraint, it shows you
engineered around it deliberately, and it routes the curious reader straight at the backend.
A reviewer who reads "I re-implemented my own API contract in 300 lines of browser JS so the
demo would work on a static host, and ran the same E2E suite against both" thinks *engineer*.
That's a better outcome than a working server would have bought you.

### What it takes to build

| Piece | Detail | Effort |
| --- | --- | --- |
| `js/demo/backend.js` | Port `mock_api.py` to an ES module: same state model (`users`, `tokens`, `posts`, `votes`), same response shapes, same status codes. Drop the HTTP layer, keep the logic. Add a realistic ~150ms latency so skeletons and pending states actually show. | 4–6 h |
| `js/demo/seed.json` | 12–15 posts with real, well-written content and staggered timestamps, across 4–5 authors. **This is not filler work** — it's the first paragraph of English anyone reads, and bad lorem ipsum undoes the visual craft instantly. Include one long post (to show the serif reading column doing its job), one draft, and a spread of vote counts. | 2 h |
| `js/config.js` | Resolve the adapter, not a constant: demo when `location.hostname.endsWith('github.io')` or `?demo=1`, real API otherwise. Keep it to a handful of lines and comment the choice. | 1 h |
| Persistence | Seed → memory on boot; writes mirror to `localStorage` under a versioned key (`commons.demo.v1`) so a refresh doesn't silently eat the post you just wrote. "Reset the demo" clears it. Pure in-memory is simpler but *feels broken*. | 2 h |
| The label | Header strip + a line in the empty state. Dismissible per session, never permanently — it must be true for every visitor. | 1–2 h |
| Playwright | A second project in `playwright.config.js` running the existing specs against demo mode with no `webServer`. Proves the adapter matches the contract. | 2 h |
| Pages workflow | `.github/workflows/pages.yml` publishing `frontend/` via `actions/deploy-pages`. Nothing to build. | 1 h |

**Total: 1.5–2 days.** The highest-leverage two days in this entire document.

---

## 4. Backend findings

### Security

Ordered by what a technical reviewer would flag first. Every item was verified in the source.

| # | Finding | Where | Severity | Notes |
| --- | --- | --- | --- | --- |
| S1 | **Drafts are world-readable.** `GET /posts/` filters on title only — `published` is never referenced — and `GET /posts/{id}` doesn't check it either. An anonymous visitor sees every user's unpublished drafts, and the UI even renders a "Draft" tag on them. | `routers/post.py:57`, `:106` | **High** | This is a broken-access-control bug (OWASP A01), and it's the kind a reviewer finds in 30 seconds because the UI advertises the feature. The product promises "Save as a draft"; the API doesn't keep the promise. Fix: filter to `published == True OR user_id == current_user.id`, which needs an *optional* auth dependency on the feed. |
| S2 | **Login is a timing oracle.** Unknown email returns before any bcrypt work; known email costs a full bcrypt verify (~100 ms). The response time tells an attacker whether an address is registered, straight past the 5/min limit. | `routers/auth.py:22` | Medium | Fix: always run `verify_password` against a fixed dummy hash on the miss path. Four lines, and a great thing to have a test for. |
| S3 | **`GET /users/{id}` is unauthenticated and returns email addresses.** Walk `id=1..n` and harvest every user's email. | `routers/user.py:36` | Medium | Ties into the profiles item in §7 — introduce a `username`, make that the public identity, and stop returning emails to strangers at all. |
| S4 | **Signup confirms which emails are registered** (409 "An account with this email already exists"). | `routers/user.py:27` | Low | Genuine tradeoff, not a clear bug — the alternative (always 201, send a "you already have an account" email) needs mail you can't host. **The right move is to document the choice in a comment**, which is a better signal than silently fixing it. |
| S5 | **Vote has a check-then-insert race.** Two concurrent `dir:1` requests both find no existing vote, both insert, and the composite PK raises `IntegrityError` → unhandled → 500. | `routers/vote.py:30` | Low | Catch `IntegrityError` and return the 409 you already return, exactly as `create_user` already does. |
| S6 | **No security headers.** No HSTS, `X-Content-Type-Options`, `Referrer-Policy` or frame protection. | `main.py` | Low | ~15 lines of middleware. Cheap, and visible to anyone who runs `curl -I`. |
| S7 | **Rate limiting is per-process and keyed on the socket address.** Behind any proxy every client shares one bucket; across replicas the limits multiply by the replica count; a restart clears them. | `limiter.py:13` | Low | Won't bite you in practice here. Worth a comment naming the limitation and a note that the fix is Redis storage + `ProxyHeadersMiddleware`. Naming a limitation you chose to live with reads better than pretending it isn't there. |
| S8 | **No rate limit on writes.** `/posts/` and `/vote/` are unlimited for an authenticated user; `GET /posts/` is unlimited for everyone and accepts `page_size=100` at unbounded offset. | `routers/post.py`, `routers/vote.py` | Low | |
| S9 | **`search` is unbounded and its wildcards aren't escaped.** `.contains(search)` without `autoescape=True` means `%` and `_` are live LIKE wildcards, and there's no `max_length`. | `routers/post.py:55` | Low | Not injection (properly parameterised), but a correctness bug. Superseded by the full-text-search item in §7. |
| S10 | **`allow_credentials=True` with a Bearer-token API.** Nothing uses cookies; this just widens the CORS posture for no benefit. | `main.py:40` | Info | One-line deletion. A sharp reviewer notices it. |

**Clean:** no SQL injection (parameterised throughout), no secrets in git history (verified
across all refs), bcrypt with per-password salt, correct 401-vs-403 separation, generic
500s that don't leak internals, non-root Docker user, `exp` verified on every token.

### Architecture & correctness

- **Zero indexes in the entire schema.** Verified: no `create_index`, no `index=True`
  anywhere. The feed's hot query does `ORDER BY posts.created_at DESC` (no index → sort of
  the whole table) joined to `votes` counting by `post_id` — and `votes`' only index is the
  composite PK leading with `user_id`, so counting by `post_id` can't use it. Add
  `posts(created_at DESC)`, `votes(post_id)`, and `posts(user_id)` for the FK. One migration,
  and the single most defensible "I know what my database is doing" item available here.
- **Offset pagination will degrade**, as all offset pagination does. Not worth replacing at
  this size — but worth one honest sentence in an ADR saying you know, and that keyset
  pagination is the fix if the feed ever grows.
- **The DB URL isn't safely composed.** `f"postgresql://{user}:{password}@…"` breaks on any
  password containing `@`, `:` or `/`. Use `sqlalchemy.URL.create()`. Three files:
  `database.py:7`, `alembic/env.py:14`, `tests/conftest.py:12`.
- **`post.votes = …` sets an unmapped attribute** on an ORM instance so Pydantic's
  `from_attributes` can read it (`post.py:14`). It works, but it's a trick. A hybrid
  property or an explicit assembly step would be cleaner — low priority, worth a comment
  either way.
- **Schema drift between models and migrations is unguarded.** Tests build the schema from
  `Base.metadata.create_all`; CI runs Alembic against a *different* database. Nothing
  checks they agree. `alembic check` in CI closes it in three lines and is a genuinely
  senior detail.
- **`models.User.password` holds a hash, not a password.** Rename to `password_hash` — one
  migration, and it removes a real chance of misreading the code later.

### Test depth

24 backend tests. Good coverage of the happy paths and ownership rules. The gaps:

- **Nothing tests auth failure modes**: expired token, malformed token, token signed with a
  different key, `Bearer` with no token, a token for a deleted user. These are five short
  tests and they're exactly what a reviewer greps for.
- **Nothing tests rate limiting** — and `conftest.py:40` contains a comment asserting *"It
  has its own dedicated test above/below."* There is no such test. A stale comment that
  claims coverage that doesn't exist is worse than no comment; fix it by writing the test.
- No test for `page_size=101` → 422, for `search`, for `/healthz`, for the global 500
  handler, for `updated_at` actually moving on PATCH, or that a rejected PUT/PATCH leaves
  the row untouched.
- No coverage measurement at all.

### CI

The workflow is well-shaped — branch/PR triggers, concurrency cancellation, a Postgres
service, migrations verified against an empty database, publish gated on `main`, layer
caching. What's missing:

- **The Playwright suite never runs.** 660 lines of frontend tests, written and working,
  that CI has never executed once. This is the biggest single gap in the pipeline and it's
  about 15 lines of YAML.
- No coverage, no `mypy`, no `ruff`, no `pip-audit`, no image scan, no Dependabot.
- `black --check` covers `backend` only; the frontend has no formatter.

---

## 5. Frontend findings

### Code organisation

Genuinely good for hand-written vanilla. `api` / `store` / `router` / `ui` / `views` is the
right decomposition, the dependency graph is acyclic, `h()` is 20 lines and does exactly one
job, and `feed.js`'s teardown handling (single active instance, `AbortController`,
`isStale()` generation counter) is careful work that most people get wrong.

Three real issues:

1. **`ui.js` is a junk drawer** — hyperscript, toasts, time formatting, avatars, skeletons,
   view mounting *and* the vote control, which is a stateful component that makes network
   calls. Split: `dom.js` (h, icon, clear), `toast.js`, `format.js` (time, initials),
   `components/vote.js`.
2. **`api.js` imports `toast` and writes to `location.hash`** (`api.js:69`). The transport
   layer navigates and shows UI. It works, but it's the one place where the layering is
   inverted; an event or a callback passed in from `main.js` would keep the seam clean —
   and that seam is exactly where the demo adapter plugs in.
3. **No error boundary.** `router.js:54` catches handler errors and calls `console.error`.
   A throw inside a view leaves the previous screen mounted with no explanation.

### Visual & motion design

The direction is strong and the writing about it (`frontend/README.md` "Design") is better
than most design systems' actual documentation. The serif-for-content / system-sans-for-
chrome split is a real identity, one accent used only for live things is disciplined, and
making `--focus` deliberately *not* the accent is a detail almost nobody gets right.

Three things currently read as default rather than chosen:

- **The staggered fade-up on every card.** Per-item entrance animations are the single most
  common tell of generated UI. It also fires on pagination and on cache restore, where
  nothing has conceptually "arrived." Restrict it to the first paint of a cold feed, or cut
  it entirely (see the View Transitions item below, which replaces it with something better).
- **The aurora blooms.** Two drifting blurred gradient washes are decoration that doesn't
  encode anything. They're well-executed and cheap on desktop — but they're the same
  ambient-gradient move every AI-generated dark app makes. Keep them only if you can say
  what they're *for*; the honest alternative is one static, much fainter warm bloom anchored
  behind the masthead, so the warmth reads as a light source rather than a screensaver.
- **Meta strings joined by middle dots** (`.dot` in `card__meta`) — a template tell. Space
  and colour already separate those items; the dots can go.

What's *missing* is a signature. Right now Commons is "a very well-executed feed." See
§7 High-impact for the three items that would make it memorable.

### Performance & accessibility

Already strong: `content-visibility` with a reserved `contain-intrinsic-size`, preloaded
subset font, `DocumentFragment` appends, debounced search with in-flight cancellation,
`transform`/`opacity`-only animation, glass dropped below 640px with a written justification,
comprehensive `prefers-reduced-motion`. Claimed Lighthouse 96–98 / 100 / 100.

Remaining, all small:

- The 120 KB font is the largest asset by an order of magnitude. Check whether the variable
  axis range (340–660) is actually exercised; a static two-weight subset could halve it.
- `.card:hover` adds `backdrop-filter`, which promotes a layer on every hover. Fine, but
  it's the most expensive hover in the app for the least benefit.
- No `aria-live` announcement when feed pages append — a screen-reader user gets new cards
  silently. Easy: announce "10 more posts" into the existing status region.
- The delete confirm uses `role="alertdialog"` without a focus trap. It's inline rather than
  modal, so this is arguably correct — but it's worth a comment saying so deliberately.
- No SEO/social metadata at all: no canonical, no Open Graph, no Twitter card, no
  `robots.txt`, no sitemap. The Pages link will preview as a bare URL in every Slack, DM
  and LinkedIn post it's ever pasted into.

### Test depth

The Playwright suite is the best-engineered part of the frontend. `mobile.spec.js` driving
real tap gestures via `Input.synthesizeTapGesture` instead of synthetic `touchstart`, and
the source-level guards against `100vh` regressions, are both things experienced people do
after getting burned.

Gaps: no accessibility assertions (`@axe-core/playwright` is one import and covers every
screen), no keyboard-only journey, no visual regression snapshots — and, above all, **none
of it runs in CI**.

---

## 6. Tech-stack verdict: does vanilla JS still serve this?

~1,400 lines of JS across 10 ES modules, zero runtime dependencies, no build step.

**The honest case for adding TypeScript.** The API response shape is consumed in six files
and typed nowhere. `post.user.email` is assumed non-null at five call sites. The store's
state shape is implicit and documented only in a comment (`store.js:33`). The two features
most worth building next — comments and profiles — both widen that shape, which is exactly
when untyped object-passing starts costing you.

**The honest case against.** "No framework, no bundler, no build step — open `index.html`
and it runs" is the repo's actual differentiator. There are ten thousand React portfolio
feeds; there are very few hand-written ones this polished. Adding a bundler deletes that
claim, puts a `dist/` between the source and the Pages deploy, and makes the thing a
reviewer reads no longer the thing that runs. TypeScript's value scales with team size and
codebase lifetime; this is one author and 1,400 lines with full E2E coverage.

**Verdict — keep vanilla, and add type checking without a build step.** Confidence: high.

Add `// @ts-check` to each module, describe the API shapes once in a `js/types.js` with
JSDoc `@typedef`, add a `tsconfig.json` with `checkJs: true` / `noEmit: true`, and run
`tsc --noEmit` in CI. You get real type errors, editor autocomplete, and a CI gate — and
ship byte-for-byte the same files. Zero runtime change, zero build step, the no-build claim
survives intact.

This is also the more impressive answer. "I used TypeScript" is a default. "I wanted the
type checking but not the build step, so I used JSDoc types with `checkJs` and gated it in
CI" is a decision, and it's the kind of thing worth an ADR.

*Reconsider if* the frontend passes roughly 3,000 lines, or a second person starts
contributing. Write that trigger down in the ADR so it's a plan and not a rationalisation.

---

## 7. The plan

Effort estimates are focused working hours, not calendar time.

### Tier 0 — Quick wins (one day, do these first)

These are disproportionately valuable because they fix presentation, and presentation is
what's furthest behind the engineering.

> **All 13 done (2026-09-13).** Verified: `pytest -q` 76 passed / 94% coverage ·
> `black --check backend` clean · `alembic upgrade head` + `alembic check` clean ·
> `npm test` 42 passed. Two things grew beyond their line below, both noted in the
> rows: 0.5 also had to fix the mock backend and a feed-cache leak that hid the same
> drafts bug in the UI, and 0.1 folded `frontend/README.md` into the root README and
> deleted it.

| # | Item | Why a reviewer notices | Effort | Touches |
| --- | --- | --- | --- | --- |
| 0.1 ✅ | **Rewrite the top of the root README.** H1 → **Commons**. One sentence on what it is. Then: live demo link, a screenshot (dark theme, feed, desktop), CI badge, license badge, stack line. Move "learning project / freeCodeCamp" down into a *"How this project grew"* section near the bottom — keep it, it's honest and the trajectory is impressive, but don't lead with it. | This is the single highest-value hour in the document. Right now the first two facts you volunteer are "learning project" and "from a tutorial." | 2 h | `README.md` |
| 0.2 ✅ | **Screenshots + one GIF.** Feed (dark), post detail (shows the serif reading column), compose, and light theme. One 10-second GIF: open → scroll → upvote → write a post. Commit them to `docs/media/`. | Nobody reads a stack table before they've seen the thing. | 2 h | `docs/media/` |
| 0.3 ✅ | **Add `LICENSE`** (MIT). | Its absence means all-rights-reserved and reads as inattention. 60 seconds. | 5 min | `LICENSE` |
| 0.4 ✅ | **Repo metadata**: description, topics (`fastapi`, `postgresql`, `sqlalchemy`, `vanilla-js`, `playwright`), and the Pages URL in the About box. | Free, and it's what shows up in search and on your profile. | 10 min | GitHub settings |
| 0.5 ✅ | **Fix the draft leak (S1).** | It's a real access-control bug with a two-line fix, and it's in the feature the UI advertises. | 1.5 h | `routers/post.py`, `oauth2.py` (optional-auth dep), `tests/test_post.py` |
| 0.6 ✅ | **Add the missing indexes.** | One migration; the most defensible database-competence signal available. | 1 h | new Alembic revision, `models.py` |
| 0.7 ✅ | **Run Playwright in CI.** A second job: install Chromium, `npm ci`, `npm test`, upload the report as an artifact. | 660 lines of tests that have never run in CI is the one thing in the pipeline that undercuts everything else in it. | 1.5 h | `.github/workflows/build-deploy.yml` |
| 0.8 ✅ | **Coverage + badge.** `pytest-cov`, fail under 80%, generate the badge SVG in CI and commit it (no external service needed). | A coverage number is the fastest proxy a reviewer has for whether tests are real. | 1.5 h | workflow, `requirements-dev.txt`, `pytest.ini` |
| 0.9 ✅ | **Fix the login timing oracle (S2)** and the **vote race (S5)**, with a test for each. | Two small, sharp fixes that show you think about the paths that aren't in the happy flow. | 1.5 h | `routers/auth.py`, `routers/vote.py`, tests |
| 0.10 ✅ | **Delete the stale "it has its own dedicated test" comment** in `conftest.py:40` — by writing the rate-limit test it claims. | A comment claiming coverage that doesn't exist is the kind of thing a careful reviewer finds and remembers. | 45 min | `tests/conftest.py`, new `tests/test_limits.py` |
| 0.11 ✅ | **Security headers (S6)** + drop `allow_credentials` (S10). | Visible to anyone who runs `curl -I`, and a one-line deletion that shows you understand what CORS flags actually do. | 45 min | `main.py` |
| 0.12 ✅ | **`alembic check` in CI.** | Catches model/migration drift. Three lines; almost nobody does it. | 20 min | workflow |
| 0.13 ✅ | **Dependabot** for pip, npm and Actions. | A trust signal that costs one YAML file. | 15 min | `.github/dependabot.yml` |

### Tier 1 — High-impact

**1.1 — Demo mode + GitHub Pages deploy — 1.5–2 days — §3 for the full breakdown.**
Everything else in this document is worth less if the link at the top of the README doesn't
work. Do this immediately after Tier 0.
*Touches:* `frontend/js/demo/*`, `js/config.js`, `js/api.js`, `.github/workflows/pages.yml`,
`playwright.config.js`, both READMEs.

**1.2 — Command palette (⌘K / Ctrl-K) — 6–8 h.**
*Borrowed from:* Raycast and Linear. Specifically two things, and not a third —
Raycast's discipline of showing **one flat result list** rather than pre-categorising, and
Linear's habit of putting the **keyboard shortcut on every row** so the palette teaches the
app while you use it. Not borrowed: the fuzzy-match-everything scope creep; this one should
do five things well.
*What it does:* filter posts by title from the already-loaded feed (instant, no network),
plus the actions — new post, toggle theme, go to feed, sign in/out, copy link to this post.
*Why it lands:* a command palette is the one interaction pattern that hiring engineers use
personally every day. Finding one in a hand-written vanilla app, with no library, is a
genuine "wait, how big is this thing?" moment. The pieces are all present already: a search
input, a hash router, `h()`, and a focus-management pattern from the delete confirm.
*Touches:* new `js/components/palette.js`, `main.js`, `components.css`, new spec.

**1.3 — View Transitions on feed → post — 3–4 h. This is the signature detail.**
*Borrowed from:* the push transition in Things 3 and iOS navigation generally — the sense
that the title you tapped *became* the title on the next screen, so you always know where
you came from. Arc does the same thing with tab morphs.
*What it does:* `document.startViewTransition()` in `mountView`, with `view-transition-name`
on the tapped card's title and the detail title. The title physically travels between
screens. Feature-detected; browsers without it fall through to the existing cross-fade.
*Why it lands:* it's about 25 lines for the most "how did they do that" moment in the app,
it's motion that *answers an action* rather than ambient decoration, and it lets you **delete
the generic per-card stagger** — replacing a template tell with a considered detail. Restraint
is the point: this should be the only orchestrated motion in the app besides the vote pop.
*Touches:* `ui.js` (`mountView`), `views/feed.js`, `views/post.js`, `views.css`, `base.css`.

**1.4 — The masthead: a landing moment that also carries the demo label — 4 h.**
*Borrowed from:* Linear's changelog pages and Things 3's empty states — typographic, quiet,
one accent, no hero image, no gradient headline. Explicitly *not* a marketing hero.
*What it is:* above the feed, for anonymous visitors only, a serif line naming what Commons
is, one line of context, and the demo-mode strip. Collapses to nothing once you've signed in
or scrolled past it.
*Why it lands:* the app currently opens on skeletons with no explanation of what you're
looking at, and the demo needs a label anyway. Solving both with one restrained typographic
moment is better than bolting a banner onto a feed.
*Touches:* `index.html`, `views/feed.js`, `views.css`.

**1.5 — Comments — 1.5–2 days.**
The most conspicuous missing feature of a social feed, and the one that adds the most
backend surface worth reviewing: a nested resource, cascade deletes, per-resource pagination,
its own ownership rules, and a second place `get_owned_*` earns its keep. On the frontend it
needs an inline composer, optimistic append, and an empty state — all things the existing
patterns cover.
*Do this before follows, profiles or real-time.*
*Touches:* `models.py`, `schemas.py`, new `routers/comment.py`, migration, backend tests,
`views/post.js`, `mock_api.py` + the demo adapter, new spec.

**1.6 — Usernames and profiles — 1 day.**
Fixes three things at once: S3 (the API stops handing strangers email addresses), the fact
that the UI currently derives display names by splitting emails at `@` (`feed.js:17` — which
means **the demo would show every seeded author's email local-part**), and the absence of any
"see everything by this person" view. Add `username` (unique, validated), make it the public
identity, drop `email` from `UserOut`, add `GET /users/{username}/posts`.
*Touches:* `models.py`, `schemas.py`, `routers/user.py`, migration, `store.js` (`isMine`
currently compares emails), `views/*`, seed data, tests.

**1.7 — Full-text search — 4–6 h.**
Replace `LIKE '%…%'` over titles with a Postgres `tsvector` column over title **and** body,
a GIN index, and `ts_rank` ordering. Also fixes S9.
*Why it lands:* "I used my database's full-text search instead of a LIKE scan" is a small
sentence that says a lot about how you think, and it's one migration plus one query change.
*Touches:* migration, `models.py`, `routers/post.py`, tests, `mock_api.py`.

**1.8 — Types without a build step — 4–6 h — see §6.**
*Touches:* every `js/` file (one comment line each), new `js/types.js`, `tsconfig.json`,
`package.json`, workflow.

**1.9 — Trust-signal pass — 4–6 h.**
- `docs/adr/` with five short ADRs on decisions you actually made: vanilla JS + JSDoc types
  over TypeScript; hash routing over History API (and why it makes Pages trivial); the token
  in `localStorage` and what that costs; demo mode as the answer to a static host; offset
  pagination and when you'd switch to keyset. **Write them in the voice the code comments
  already use** — that voice is the repo's best asset.
- A *"Decisions I made"* section in the README linking to them.
- `mypy --strict` on `backend/app` in CI; `ruff` alongside `black`; `pip-audit`.
- Tag the existing milestones (`v0.1.0` backend, `v0.2.0` frontend) and start a
  `CHANGELOG.md`. You can't honestly rewrite 79 commit messages, but tags and a changelog
  give the history a readable spine — and from here on, one concern per commit, written by
  you.
- PWA: `manifest.webmanifest`, maskable icons, `apple-touch-icon`, a real favicon set
  (currently a data-URI SVG with no fallbacks).
- Open Graph + Twitter card + a committed `og.png`, so the link previews properly everywhere
  it gets pasted.
- `404.html` that redirects into the hash router, so deep links survive a Pages 404.
- Lighthouse CI in the workflow, with the real numbers (and their date) in the README.

**1.10 — Close the auth test gaps — 3 h.**
Expired token, malformed token, token signed with the wrong key, missing bearer, token for a
deleted user, `page_size` out of range, `updated_at` moving on PATCH, a rejected write
leaving the row untouched, `/healthz`. Plus `@axe-core/playwright` across all five screens,
and a keyboard-only journey. ~15 tests total.

### Tier 2 — Stretch

**2.1 — Feed keyboard navigation (`j`/`k`/`Enter`/`u`) — 3 h.**
*Borrowed from:* Hacker News, Reddit and Superhuman — the convention for feeds, so it needs
no teaching. Pairs naturally with the palette (which can advertise the shortcuts). Genuinely
appropriate rather than decorative, because a linear list of items is exactly the shape this
pattern was invented for.

**2.2 — "Warmth" on the card — 2 h. The one idea specific to *this* product.**
Commons is a hearth metaphor — the brand mark is a lamp, the accent is honey amber, the
stated design goal is "a quiet, lamplit reading room." The app's only live quantity is votes.
So: a post above a vote threshold gets a single warm hairline along its leading edge, using
the `--accent` and `--hairline` tokens that already exist. No badge, no chip, no new colour —
one rule that *encodes information as structure* rather than decorating. Restraint is what
makes it read as taste: you get one signature detail, and this is it, so nothing else in the
card may compete with it.

**2.3 — Reading progress on the post detail — 1 h.**
Pure CSS via `animation-timeline: scroll()` — a 2px amber hairline under the header that
tracks your position through the post. Six lines, no JS, degrades to nothing. Earns its place
specifically because long serif posts are the reading experience the whole type system was
built for.

**2.4 — Refresh tokens — 1 day.**
Short-lived access token in memory + a refresh token in an `httpOnly` cookie. This directly
closes the tradeoff you've already documented twice (`store.js:8`, `frontend/README.md`).
*Closing a limitation you wrote down yourself is a strong signal* — it shows the comments are
a working engineering log, not decoration. Caveat: cookies mean CSRF protection and a more
careful CORS story, so it's a genuine day, not an afternoon.

**2.5 — OpenAPI polish — 3 h.**
Response examples on every endpoint, documented error responses, tags with descriptions, a
`servers` block, and the generated `openapi.json` committed so it can be linked from the
demo's "here's the contract it implements" line. Directly reinforces §3's framing.

**2.6 — WebSocket live feed — 1.5 days. Recommended *last*, with eyes open.**
Technically interesting, and "real-time updates over WebSocket" is a good line. But be
honest about the economics: **there is no server in production, so this can only ever be
demonstrated on your own machine.** The effort lands somewhere no recruiter will see it, and
it pushes async concerns into an otherwise-synchronous SQLAlchemy codebase.
If you want the *feeling* of live updates on the Pages demo, `BroadcastChannel` across two
tabs gets you there in two hours — but say plainly in the README that it's a demo-mode
simulation, not the backend. Don't let it imply something untrue.

### Explicitly not doing

| Item | Why not |
| --- | --- |
| **Image uploads** | Needs object storage, which the no-hosting constraint rules out. You'd build an upload path that can't run in the only environment anyone will see. |
| **Follows / followers** | A social graph needs a populated social graph to mean anything. With 12 seeded demo posts it's dead weight — a schema and three endpoints demonstrating nothing. Revisit only if the demo grows a real seeded community. |
| **Sentry** | Needs a hosted account, adds a runtime dependency, and produces a dashboard nobody clicking your repo will ever see. Structured logging already covers the local story. |
| **Rewriting to React / Next.js** | See §6. It would delete the repo's actual differentiator and make it the ten-thousandth React feed. |
| **Rewriting the 79 commit messages** | Not honest, and a force-push over your whole history is a bad trade for a cosmetic gain. Tags, a changelog, and better messages from here. |
| **Microservices, Kubernetes, Terraform** | Scope theatre. A reviewer reads unjustified infrastructure as a sense-of-proportion problem, not as ambition. |

---

## 8. Suggested order

1. **Tier 0** (one day) — presentation, the draft leak, indexes, Playwright in CI, coverage.
   Everything else is worth more once the README opens well and the badges are green.
2. **1.1 Demo mode + Pages** (two days) — the link has to work before you show anyone.
3. **1.3 View Transitions + 1.4 masthead + 1.2 palette** (two days) — the wow pass, while
   the frontend is fresh in your head. Cut the stagger and the middle dots in the same pass.
4. **1.6 usernames + 1.5 comments** (three days) — in that order; comments need an identity
   worth showing, and profiles fix the demo's email-in-the-byline problem first.
5. **1.7 search, 1.8 types, 1.9 trust signals, 1.10 tests** (three days) — the depth pass.
6. **Tier 2**, as appetite allows. 2.2 ("warmth") is two hours and the most *yours* thing on
   the list.

Roughly eleven focused days to the end of Tier 1. Tier 0 plus 1.1 — three days — gets you
most of the recruiter-facing return on its own.
