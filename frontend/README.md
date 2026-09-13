# Commons — web UI

The frontend for the Social Feed API. A small public common: anyone can read the
feed, you need an account to post or upvote.

Plain HTML, CSS, and vanilla JavaScript (ES modules). No framework, no bundler,
no build step — open `index.html` through any static server and it runs. One web
font, no runtime dependencies.

## Running it

You need two things running: the API on `http://localhost:8000` and this app on
`http://localhost:5173` (the origin the API allows via CORS).

### 1. The backend

From the repo root (see the root `README.md` for details):

```bash
cp backend/.env.example .env          # then fill in Postgres + SECRET_KEY
alembic -c backend/alembic.ini upgrade head
uvicorn backend.app.main:app --reload
```

or `docker compose up --build`.

### 2. The frontend

```bash
cd frontend
python3 -m http.server 5173
```

Open <http://localhost:5173>. That's it.

`API_BASE` lives in `js/config.js` — one constant. If you serve the app on a
different port, add that exact origin to the `origins` list in
`backend/app/main.py`.

## What's where

```
frontend/
  index.html            shell: header, <main> mount point, aria-live toast region,
                         skeleton <template>, the pre-paint theme bootstrap
  styles/
    tokens.css           the whole design system as CSS custom properties
    base.css             reset, @font-face, page shell, aurora, reduced-motion
    components.css        header, buttons, card, vote control, fields, toasts,
                         inline confirm, skeletons
    views.css            per-screen layout + the narrow-screen header collapse
  js/
    config.js            API_BASE
    api.js               fetch wrapper — auth header, JSON, error normalisation,
                         401/403/429 handling, AbortController
    store.js             tiny reactive store: session (+subscribe), feed cache,
                         local vote mirror
    router.js            hash router with :params and a ?query
    ui.js                h() builder, toasts, relative time, initials avatar,
                         skeletons, mountView, the shared vote control
    views/
      feed.js  post.js  auth.js  compose.js
    main.js              boot: header, theme toggle, search wiring, routes
  assets/
    fonts/newsreader.woff2   one variable font (subset, ~120 KB), preloaded
    icons.svg                <use> sprite for the handful of UI icons
  tests/                 Playwright specs + a stdlib mock backend (see below)
```

## Screens

Hash routes, one page:

| Route | Screen |
| --- | --- |
| `#/` | Feed (public). Debounced title search drives `?search=`; infinite scroll with a visible end state; skeletons while loading. |
| `#/posts/:id` | Post detail (public). Full text, timestamps ("edited" when changed), vote control, Edit/Delete if it's yours with an inline delete confirm. |
| `#/login`, `#/register` | Inline field errors, one friendly line on failure, submit disabled while pending. Register creates the account then signs in, so you land on the feed ready to post. |
| `#/compose`, `#/posts/:id/edit` | Title + body, publish toggle, character count. `POST` for new; `PATCH` with only the changed fields for edits. Optimistic voting; pessimistic create/edit/delete. |

Session is `{ email, token, id? }` in `localStorage` under `commons.session`.
"Can I edit this post" is `post.user.email === session.email`. The token is in
`localStorage` — an XSS bug would leak it; that's the accepted tradeoff here
since there's no refresh-token flow yet (noted in `store.js`).

## Design

Calm, crafted, dark-first. Reference points: Linear, the Vercel dashboard, Arc.
The idea: **a quiet, lamplit reading room, not a dashboard.** Content is set in a
literary serif; the tool itself (nav, buttons, meta) is an invisible system sans.

### Tokens (`styles/tokens.css`)

| Group | Values |
| --- | --- |
| **Type** | `--font-serif` Newsreader (variable, opsz 6–72) for brand, titles, post body, headings, empty states. `--font-ui` system sans for everything interactive. Scale: `--fs-brand` 1.15rem · `--fs-h1` clamp(1.7→2.4rem) · `--fs-title` 1.3rem · `--fs-read` 1.125rem (post body) · `--fs-ui` .875rem · `--fs-meta` .8125rem. Reading measure `--measure: 66ch`. Form controls use `--fs-field`, which is `--fs-ui` on the desktop and exactly 16px on anything touch-shaped. |
| **Colour (dark)** | `--bg #0c1315` deep teal-ink · `--card-bg` translucent `#131d20` · `--text #e7edec` / `--text-dim #93a3a1` / `--text-faint #7c8b87` · one accent, `--accent #f0a63c` honey amber, used only for live things (your identity, an active upvote, links) · `--danger #e8705d` coral · `--focus #7fd6c4` teal — deliberately not the accent, so focus always reads. |
| **Colour (light)** | Cool off-white `--bg #eef1f1` (not warm cream), `--accent #e2952f`, `--link #9a5f12`, `--focus #1f8a76`. Toggle persists to `commons.theme`; defaults to `prefers-color-scheme` via a pre-paint inline script. |
| **Space** | 8px rhythm: `--s-1`…`--s-9` = 4, 8, 12, 16, 24, 32, 48, 64, 96. |
| **Radius** | Varies by role on purpose: cards `--r-lg` 18px, inputs/buttons `--r-sm` 10px, pills 999px. |
| **Glass** | `--blur` 14px / `--blur-strong` 20px, `--saturate` 1.6. Applied to four surfaces only: the header, the compose panel, the delete confirm, and a card on hover. Hairline gradient top border + soft large-radius shadow. `@supports not (backdrop-filter)` → solid translucent fallback, and **below 640px the blur is dropped entirely** in favour of those same opaque fallbacks (see *Mobile*). |
| **Motion** | `--t-fast/mid/slow` 120/200/320ms, `--ease` `cubic-bezier(.2,.7,.2,1)`. Staggered fade-up for cards (~40ms, capped at 8), hover lift, button press scale, a spring pop on the vote toggle, route cross-fade, skeleton shimmer. `transform`/`opacity` only. `prefers-reduced-motion` cuts all of it. |
| **Background** | Two slow, very faint amber/teal aurora blooms behind everything; they never compete with text and stop entirely under reduced motion. |

### Decisions worth knowing

- **One font, split by job.** Newsreader (a subsetted ~120 KB variable woff2,
  preloaded, `font-display: swap`) carries every piece of *content*. The UI chrome
  uses a system sans stack. That split is the identity.
- **The vote is the only thing that pops.** One spring, one colour shift, a shape
  change (outline caret → filled) so it never relies on colour alone. Everything
  else stays still.
- **No "did I vote" flag in the API**, so the vote control keeps a local mirror
  in `localStorage` (`commons.votes`). If it disagrees with the server, the vote
  call returns 409/404 and the control just settles into the real state.
- **Feed cache.** Leaving the feed snapshots its items + scroll position for 60s,
  so coming back from a post is instant. Creating/editing/deleting a post drops
  the cache.
- **Optimistic voting; pessimistic writes.** Votes update the UI immediately and
  roll back on a real error. Create/edit/delete wait for the server.
- **Icons are an SVG `<use>` sprite** (`assets/icons.svg`), not a font — inline
  SVG per the constraints, one cached request.
- **Accessibility.** Semantic landmarks, labelled inputs, `aria-live` toasts,
  focus moves to the new screen on route change (but not away from the search
  field while you're typing), Escape closes the delete confirm and returns focus
  to the trigger, visible restyled focus rings, AA contrast, Lighthouse a11y 100.
- **Size.** ~41 KB of hand-written JS across 10 ES modules (~12 KB gzipped),
  ~35 KB CSS. Slightly above the 30 KB JS target — the comments stay and there's
  no minify step, so gzipped/delivered size is the number that matters.

### Voice

Understated and warm. Short sentences, contractions, no hype. "Nothing here yet.
Be the first to say something." / "That's everything for now." / "Delete this
post? There's no undo."

## Mobile

The layout was responsive from the start, but a handful of things only show up
on an actual phone. This is what was wrong and what changed.

**The blue tap flash.** Nothing overrode `-webkit-tap-highlight-color`, so every
tap on a link, a button or a card flashed the browser default —
`rgba(51, 181, 229, .4)` — over it. It's now `transparent` on `html` (the
property inherits, so that covers everything), alongside
`touch-action: manipulation` to drop the 300ms click delay.

Turning it off means the press feedback has to come from somewhere, and most of
the `:hover` rules were ungated: on a touch screen a tapped element keeps its
hover skin until you tap somewhere else. So every hover-only state now sits
inside `@media (hover: hover)` — the card's lift already did — and each tappable
thing grew a matching `:active` rule. Worth knowing if you ever test this by
hand: `:active` is driven by the browser's *tap gesture*, not by raw touch
events, which is why `mobile.spec.js` drives it with `Input.synthesizeTapGesture`
rather than a synthetic `touchstart`.

**iOS zoom-on-focus.** `.input`, `.textarea` and `.search__input` were 14px.
Below 16px, mobile Safari zooms the whole page in when a field takes focus and
never zooms back out — tap the search box, lose the layout. Form controls now
use `--fs-field`, which lifts to exactly 16px under
`@media (max-width: 640px), (pointer: coarse)`. Both halves earn their keep: the
width query covers narrow windows and device mode, and the pointer query covers
a phone in landscape, which is 900px+ wide on a modern handset and would sail
straight past a width-only rule. The desktop keeps its 14px controls.

**The signed-in header overflowed.** At 320px the labelled *Write* and
*Sign out* buttons pushed the theme toggle clean off the right edge, where it
could not be tapped at all, and took 49px of horizontal scroll with it. Below
640px both actions shed their words and become 44px icon buttons — the
accessible name comes from `aria-label`, so nothing is lost — and there's a new
`i-sign-out` glyph in the sprite. The same row broke again between about 640 and
900px, where the search and the cluster stop fitting: the header grid's middle
track is now `minmax(0, 1fr)` so the search yields instead of the row
overflowing, and the account email (the only part of the cluster that isn't an
action) hides below 900px rather than 640px.

**Compose read as a squeezed desktop dialog.** On a phone it now drops the
backdrop blur and the 64px modal shadow, tightens its padding, and gives the
body box `max(9rem, 28dvh)` so there's somewhere to actually write. Its buttons
split the row at full width, and still stack at 380px as before.

**Glass was costing more than it was worth.** A `backdrop-filter` makes the
browser snapshot and blur everything behind the element on every frame it
scrolls over; on a weaker GPU that's what turns a sticky header into a smear.
Below 640px the header, the compose panel and the toasts use the opaque
fallbacks that already existed for `@supports not (backdrop-filter)`. The aurora
got the same treatment — it was two 70vmax layers under a 60px blur, drifting;
on a phone it's one smaller static bloom.

**Viewport and insets.** `viewport-fit=cover` was already set, which means the
page paints under the status bar and the home indicator, but nothing inset for
them: the sticky header now pads by `env(safe-area-inset-top)` and `#view` by
`env(safe-area-inset-bottom)`. The header's left/right insets were also
transposed (`inset-left` sat in the right slot) and are now the right way round.
Heights that mean "the visible viewport" use `dvh`, so nothing jumps as the URL
bar slides in and out — `mobile.spec.js` fails the build if a bare `vh` comes
back.

**Tap targets.** The brand, the *Back to the feed* link, the password reveal and
the quiet buttons were all between 26 and 40px tall. They're 44px on a phone.

## Performance

Lighthouse (mobile, throttled, against the mock backend):

| Performance | Accessibility | Best Practices |
| --- | --- | --- |
| 96–98 | 100 | 100 |

No layout shift (skeletons match final sizes, `content-visibility` on off-screen
cards with a reserved `contain-intrinsic-size`). One preloaded font file, no
polling, no console output. Search debounced ~250ms with in-flight requests
cancelled via `AbortController`. Feed pages appended with a `DocumentFragment`,
never rebuilt.

## Tests

End-to-end with Playwright, in `tests/`. They run against `mock_api.py` — a
standard-library stand-in for the backend that implements the frozen contract
faithfully — so the suite is hermetic and needs no Postgres.

```bash
cd frontend
npm install                    # dev-only: @playwright/test
npx playwright install chromium
npm test                       # or: npx playwright test -c tests/playwright.config.js
```

`npm test` starts both the mock API (port 8000) and a static server (port 5173),
runs the specs, and shuts them down. The HTML report lands in `tests/.report`
(`npm run test:report` to open it).

| Spec | Covers |
| --- | --- |
| `e2e.spec.js` | The full journey: register → sign in → feed → create → upvote + un-upvote → edit own → delete (with the inline confirm + Escape-to-cancel) → sign out. Plus pagination-on-scroll with the end state, and search. |
| `errors.spec.js` | Wrong password, duplicate email, editing someone else's post, empty fields, backend unreachable. |
| `responsive.spec.js` | No horizontal overflow at 320 / 360 / 390 / 414 / 768 / 1280, the header collapsing to two rows, ≥44px tap targets, the reading column staying narrow on a wide desktop. |
| `mobile.spec.js` | The phone-only regressions (see *Mobile*): transparent tap highlight, ≥16px form controls at every phone width **and** in landscape, `:active` press feedback under a real tap gesture, hover states staying behind `(hover: hover)`, no overflow at 320–414 **while signed in**, every header action reachable at 320px, compose and the delete confirm usable at 320px, and source guards against bare `100vh` returning. |

**If port 8000 is busy** (e.g. the real backend is running): point the app at a
free port by editing `js/config.js`, then `API_PORT=8010 npm test` to match.

## Manual check against the real backend

The mock is for the automated suite. Before shipping, run the real backend
(uvicorn + Postgres) and walk the flow once by hand: register → sign in → feed
loads → scroll paginates → open a post → create → upvote and remove it → edit
your own → delete → sign out → feed still readable. Then each error path (wrong
password, duplicate email, editing someone else's post, empty fields, backend
down), the five widths above, reduced-motion, and the theme toggle. On a real
phone, also check the four things the emulator can't fully prove: that no tap
flashes blue, that focusing the search box doesn't zoom the page, that the
header clears the notch, and that nothing jumps as the URL bar hides.
