# Commons — the next level

A second architecture review, written after `UPGRADE_PLAN.md` was finished end to end.
That plan was about *credibility*: make the demo work, make the security real, make the
tests deep. It did that. This one is about the two things it deliberately left alone —
**what the app can do**, and **what it feels like to use**.

Nothing here is written yet. Read it, strike out what you don't want, and the order in
§7 is what we follow.

---

## 1. Where the app actually stands

The honest summary, so the rest of this has a baseline:

**What's genuinely good, and rarer than you think.**

- The codebase has a *voice*. The comments explain decisions rather than restating
  code, and several of them name the thing that turned out to be wrong. That is the
  single most senior-reading thing in the repo and it should be protected in
  everything below.
- The frontend is a working argument. 3,000 lines of hand-written ES modules with a
  router, a store, view transitions, optimistic writes, a command palette, keyboard
  navigation, a type-checked build with no build step, and Lighthouse 96+/100/100.
  Most portfolio feeds are `create-react-app` with a Tailwind card. This isn't.
- The design system is disciplined. One accent, one serif, an 8px rhythm, tokens that
  carry their own contrast measurements in a comment. `--accent-text` exists because
  amber failed AA at 13px and somebody checked.
- The demo-mode decision was correct and is the reason there is anything to show.

**What the app *doesn't do* yet — and this is the gap this plan closes.**

- A post is read once and then it's over. Nothing remembers you were here.
- Votes are decoration. Nothing sorts by them, nothing is ranked, nothing surfaces.
- Comments are a flat list. You can't reply to a person, only to a post.
- The feed is a snapshot. It never changes while you're looking at it.
- There is a `manifest.webmanifest`, maskable icons and an `apple-touch-icon` — and
  no service worker. The app advertises itself as installable and has no offline
  story, which for an app whose production build is *already* client-only is the
  strangest gap in the repo.
- Nothing in the running app tells a visitor how it was built. All of that reasoning
  is in the README and the ADRs, i.e. behind a second click that most people who open
  the demo will never make.

---

## 2. The constraint that decides everything below

**Every feature that touches data has to be written twice** — once in FastAPI, once in
`js/demo/backend.js` (already 1,082 lines, the third-largest file in the project). The
published site has no server, so a feature that exists only in the backend is a feature
nobody who clicks your link will ever see.

Three consequences, and they shape the whole plan:

1. **Client-side features cost half.** A feature built entirely in the browser ships to
   the demo *and* to a local backend run with one implementation and one test pass.
   Conveniently, that is exactly the kind of feature you asked for.
2. **A data feature is never done until both halves land**, plus the Playwright suite
   green against both projects. Budget it as one-and-a-half times the backend estimate,
   not as the backend estimate.
3. **`docs/openapi.json` is the contract between them.** It's already committed and gated
   in CI. Anything new goes in there first, then into both implementations.

This is not a complaint about the architecture — it's the correct trade for "no paid
hosting". But it means the cheap, high-impact work is in the browser, and the plan is
weighted accordingly.

---

## 3. The review — five findings

Findings, not features. Two are outright gaps, two are decisions that a feature below
would invalidate, and one is housekeeping. Some are cheap enough that I'd do them
regardless of which tier you pick.

### 3.1 The live feed trips ADR 0005's own trigger, and the ADR is right

`docs/adr/0005-offset-pagination.md` already names this: offset pagination "skips and
repeats rows under writes", and the ADR says to move to keyset when "writes become
frequent enough that the skip-and-repeat behaviour is visible to readers — in practice,
several posts a minute." That reasoning is sound and I'm not reopening it.

What's new is that §5.3 changes the arithmetic. A reader who is *handed* new rows at
the top of the list and then keeps scrolling shifts every subsequent page by exactly
the number of rows inserted — so it isn't a probabilistic duplicate at several writes
a minute, it's a guaranteed duplicate per inserted post, at any write rate. The ADR
couldn't weigh that, because at the time nothing inserted into a feed that was on
screen.

Two ways out, and **I'd take the second**:

1. **Keyset, as the ADR describes it.** `(created_at, id)`, `?after=`, `next_cursor`.
   Correct, and the ADR has already done the design work. Cost: `total` goes, which is
   what draws "3 posts" on a profile and what tells the infinite scroll it's done.
2. **A snapshot anchor.** The feed records the timestamp of its first page and sends
   `?as_of=<ts>` on every page after it. The server adds one `WHERE created_at <= :as_of`
   and the window stops moving: offsets stay meaningful, `total` survives, profiles and
   comments are untouched, and the pill's prepended rows sit outside the paginated set
   where they belong. One parameter, one clause, and it's honest — it says "these pages
   are the feed as it was when you opened it", which is what an infinite scroll means
   anyway.

Option 2 is half a day and doesn't spend ADR 0005's migration budget on a problem the
ADR was right to defer. ADR 0005 gets an amendment naming the third trigger it didn't
have: *a feed that receives rows while it's being read*. Keyset still waits for 50,000
posts.

### 3.2 The vote state is a guess

`store.js` is candid about it: *"The API has no 'did I vote on this' flag, so we keep a
local best-effort set."* So your votes are invisible on a second device, invisible in a
private window, and wrong after clearing storage — the caret goes hollow on posts you
upvoted last week.

`PostOut` should carry `voted: bool`, computed for the authenticated viewer only
(a `LEFT JOIN votes ON votes.post_id = posts.id AND votes.user_id = :me`, one extra
join on a query that already aggregates votes — no N+1, no second round trip). Then
`commons.votes` in `localStorage` gets deleted the same way `commons.session` was:
actively removed on boot, not merely ignored.

This is a small change with an outsized payoff, because it turns a documented
compromise into a closed one — and the repo already has a track record of doing
exactly that (ADR 0003).

### 3.3 Votes don't do anything

The only ranking in the app is chronological. A vote moves a number and, at three,
draws a hairline. It doesn't move the post. That makes the whole voting mechanic
ornamental, which is a strange thing for the app's one live quantity to be.

§5.2 proposes a sort, and — more interestingly — a written-down ranking function.

### 3.4 There is no offline story for an app that is already offline

The demo runs entirely in the browser and holds its data in `localStorage`. Add a
service worker that precaches the shell (five CSS/JS files, one font, one sprite) and
it becomes a genuinely installable app that works on a plane. That's not a trick —
it's the truest possible expression of what this build already is.

Non-obvious cost: a service worker is a cache with a lifecycle, and getting the update
path wrong means shipping a fix nobody receives. Budget for the update flow (a quiet
"a new version is ready — reload" toast), not just the install.

### 3.5 Two files are outgrowing themselves

`views/post.js` (557 lines) is the post, the owner actions, the comment list, one
comment, and the comment composer. `styles/components.css` (1,218 lines) is everything.
Neither is urgent, but every feature below lands in one of them. Split `post.js` into
`views/post.js` + `components/comments.js` *before* threading arrives, not after.

---

## 4. The design thesis

You asked for upgrades that are dopamine-driven and eye-catching. I want to be precise
about what that means here, because the obvious reading of it would wreck the app.

The dopamine playbook — streaks, badges, confetti, counters that count up, a toast for
every action — is a *casino* vocabulary. Commons is a lamplit reading room with one
amber accent and a serif face chosen for long-form reading. Bolt a confetti burst onto
an upvote and it doesn't become more fun, it becomes incoherent: the restraint is the
thing people notice, and restraint is only legible if it's *consistent*.

So the version of delight this app can have, and which is genuinely more satisfying:

1. **The app remembers you.** The strongest return-trigger in any feed is not a badge —
   it's "there are four things here you haven't read." That's §5.1.
2. **The app responds instantly and physically.** Optimistic writes (done), the title
   that morphs into the next screen (done), and one earned moment where something
   *ignites* (§6.3).
3. **The app gives you control over your own experience.** Reading size, measure, focus
   mode, saved posts. Fiddling with a well-made control is a real pleasure and it costs
   the brand nothing.
4. **The app is alive.** A feed that changes while you watch it is the oldest dopamine
   in social software, and it's honest here as long as the demo says what it's doing.

The governing rule for everything new, so it stays one design rather than five:

> **The amber is spent on three things: a vote, warmth, and where you are.** Anything
> new that wants attention has to earn it with *structure* — weight, space, position,
> a hairline — not with a second colour. If a new element can't be made legible without
> a new hue, it's the wrong element.

---

## 5. Tier A — the four signature moves

These are the ones I'd actually build. Each is specific to this product, each is
demonstrable on the published site, and three of the four are frontend-only.

### 5.1 "The room remembers you" — read state, new-since, and reading time

**Frontend only. ~2 days. The highest-value item in this document.**

Three things that are really one idea: the feed should know what you've already seen.

- `commons.read` in storage: a set of post ids you've opened, and the timestamp of
  your last visit. Never leaves the browser, said out loud in the colophon and the
  README — which makes it a *privacy* feature as well as a convenience one, and that's
  worth a sentence somewhere prominent.
- **Read posts recede.** A card you've opened draws its title in `--text-dim` instead
  of `--text`. No badge, no dot, no new colour — the same trick the warmth hairline
  used. Books you've finished go back on the shelf.
- **"Four new since Tuesday."** One line at the top of the feed, in the reading face,
  that scrolls you to the first one. It replaces nothing and it's gone when there's
  nothing new to say.
- **Reading time on the card.** `Math.ceil(words / 220)` — "2 min" in the card meta,
  next to the timestamp. It costs nothing, it's genuinely useful, and it is *exactly*
  the metric a reading room should show. It also finally gives the reading-progress
  hairline on the post screen something to be the other half of.

Why it's this app's feature and not a generic one: the whole visual argument is
lamplight and reading. "What's still unlit" is the metaphor doing work.

**Risks.** Two, both real:
- It must not fight the warmth hairline. Warmth is an *edge*; read state is *type
  weight*. Different channels, so they can co-occur on one card without competing.
- Marking a post read the instant it's opened is wrong for a bounce. Mark it after the
  post has been on screen for ~2s, or after any scroll on it — whichever comes first.

**Done when:** read state survives a reload, never leaks between accounts on one
browser, the "new since" line is correct across a sign-in, reduced motion is a no-op
(nothing here animates anyway), and axe is clean on the dimmed titles — check the
`--text-dim` contrast on `--card-bg` in both themes before committing to it.

### 5.2 The reading room gets a light switch — focus mode, reading controls, print

**Frontend only. ~2 days. The most "you" item on the list.**

The post screen is the app's best surface and it currently has one setting: the theme.

- **Focus mode** (`f`, and in the palette). The header retreats, the aurora narrows to
  a single warm bloom behind the column, the measure tightens from 66ch to ~58ch, and
  everything that isn't the post fades to `--text-faint`. Escape brings the room back.
  One orchestrated motion, triggered by the reader, which is the only kind of motion
  this design allows.
- **Reading controls**: type size (three steps, applied to `--fs-read`) and measure
  (two steps, `--measure`). A small panel, persisted to `commons.reading`. Both are
  already tokens — this is exposing the design system to the reader rather than adding
  to it, which is why it's two days and not five.
- **Print.** One stylesheet. `Ctrl+P` on a post produces a page from a book: the serif
  at 11pt, black on white, the byline as a footer, the chrome gone, the URL printed
  after each link. Nobody does this, it takes half a day, and it is a *lovely* detail
  to have someone discover.
- **Select-to-quote.** Select a passage and a small control offers to copy it with a
  link back. Medium's move, and it fits a reading app better than it fits Medium.

**Risk.** This is the item most likely to sprawl. Three type sizes, not a slider; two
measures, not four; no paper/sepia theme — the light theme is a *deliberately cool*
off-white and is written down as such in `tokens.css`, so a warm cream reading mode
would contradict a decision you already made on purpose.

### 5.3 "The common is awake" — the feed changes while you're looking at it

**Both halves. ~2 days.**

A quiet pill slides under the header: *3 new posts*. Press it and the new cards unfold
into the top of the list — no scroll jump, no reload. This is the single most
dopamine-shaped interaction in feed software and it has never once been accused of
being tasteful decoration.

**How, and why not WebSockets.** Poll `GET /posts/?limit=1` (or a cheap
`GET /posts/latest`) every 45 seconds, **only while the tab is visible** (Page
Visibility API) and **only when the feed is on screen**, backing off on failure. That
is the correct engineering call for a feed that changes a few times an hour, and
saying so — in an ADR, with the arithmetic — reads as better judgement than reaching
for a socket because sockets are impressive. The previous plan reached the same
conclusion from the hosting side; this reaches it from the load side, which is the
stronger argument.

**In demo mode it's honest.** There's no server, so "new" can only mean *you posted in
another tab*. `BroadcastChannel` carries it between tabs, the pill appears in the other
one, and the demo band says what it is. Two tabs side by side is also the best GIF in
your README.

**Depends on §3.1.** Inserting at the top of an offset-paginated infinite scroll
duplicates a card for every row inserted. Ship the snapshot anchor first — it's half a
day and it's the difference between this feature being a delight and being a bug report.

### 5.4 The colophon — `#/colophon`

**Frontend only. ~1 day. The highest return per hour for the portfolio goal.**

A typeset page inside the app that says how it was made. Not a README link — a screen,
set in Newsreader, that someone who opened your demo out of curiosity will actually
read. A colophon is a printing-house artifact: the page at the back of a book naming
the type, the paper and the press. For this app it's the most on-brand possible way to
show your work.

What goes on it:

- **The stack**, in one paragraph of prose, not a badge wall.
- **The numbers**, generated by CI into `docs/stats.json` and fetched at runtime — test
  count, coverage, lines of hand-written JS, zero dependencies at runtime, Lighthouse
  scores. Same arrangement the coverage badge already has, so they can't go stale
  silently.
- **Three or four decisions**, each one sentence with a link to its ADR. The refresh
  token in an httpOnly cookie. Why there's no framework. Why the demo has no server.
- **"What's honest about this demo"** — the section that makes the whole thing land.
  It runs in your browser, there is no backend, here's the real API's contract
  (`docs/openapi.json`), here's what differs and why. Volunteering the limitation is
  worth more than hiding it.
- **The keyboard shortcuts**, since this is where someone curious will look.

Linked from the masthead and the palette, never pushed at anyone.

---

## 6. Tier B — utility that compounds

Smaller, each individually justifiable, each making the app more of a real product.

### 6.1 The shelf — save a post for later
**Frontend first (~1 day), backend later (~1 day).** A reading room has a shelf. Save
from the card or the post; `#/shelf` is a feed with your saves in it. Client-side in
`commons.shelf` to start, which means it ships to the demo immediately; a `saves` table
and two endpoints later, which is when it starts surviving a device change. Pairs
naturally with §6.6 (offline): your shelf is exactly the set of posts worth precaching.

### 6.2 Sort — and a ranking function worth writing down
**Both halves. ~1.5 days.** A quiet segmented control on the feed: **Newest ·
Warmest · Discussed**. The interesting half isn't the control, it's that "warmest"
forces you to define a ranking. A raw vote count ranks a two-year-old post above
everything; the classic answer is a score with time decay:

```
score = (votes) / pow(hours_since + 2, 1.5)
```

Computed in SQL, ordered in the database, index-backed, and **documented in an ADR with
the reason for the exponent**. That's a genuinely interesting artifact — most portfolio
feeds have no ranking at all, and the ones that do never explain the constant.

Fixes §3.3: votes start mattering.

### 6.3 The warmth ignites
**Frontend only. ~2 hours. The one piece of pure delight I'd keep.** When *your* vote
is the one that carries a post over `WARM_AT`, the hairline doesn't appear — it draws
in from the top, once, over ~400ms. The vote control already toggles the class in
`paint()`, so this is one `@keyframes` and a class that removes itself. It is earned
(it marks a real threshold crossing), it is rare (you have to be the third voter), it
is the existing accent, and it respects `prefers-reduced-motion` by simply appearing.

That's the whole dopamine budget, spent in one place, on the app's own metaphor.

### 6.4 Threaded replies, exactly one level deep
**Both halves. ~2 days.** Reply to a person, not just to a post. One level, not
infinite — and *that* is the decision worth writing down: unbounded nesting is a
rendering problem, a mobile indentation problem and a moderation problem, and on a feed
with fourteen posts it buys nothing. `parent_id` nullable, self-referencing FK, a
partial index, replies loaded with their parent, and a frontend that indents once and
then stops.

Do §3.5 (split `post.js`) first.

### 6.5 Your account, and "sign out everywhere"
**Both halves. ~1 day.** A `#/settings` screen: change your username, sign out of every
session, delete your account. The middle one is nearly free — you already have a
`refresh_sessions` table with a `user_id` index and a `revoked_at` column, built for
exactly this, and never yet used for it. The last one is a `DELETE /users/me` behind a
typed confirmation, and every cascade it needs is already declared at the database.

Small feature; unusually strong signal, because it's the part everyone skips.

### 6.6 Offline, properly
**Frontend only. ~1.5 days.** A service worker that precaches the shell and serves it
cache-first, plus a runtime cache for the seed and any post you've opened. Then the
published demo is genuinely installable and genuinely works offline — which, for a
build that has no server anyway, is simply the truth about it made usable.

Includes the update path: a new version detected, a quiet toast, reload on the reader's
say-so. Don't skip that half; it's where service workers go wrong.

### 6.7 Search that shows you the match
**Both halves. ~1 day.** You already have a weighted `tsvector` and `websearch_to_tsquery`.
Postgres will also hand back the matching sentence with the term marked —
`ts_headline()` — so results can show *why* they matched instead of the first 280
characters of the post. Demo mode does the same with a regex over the seed and the same
`<mark>` element. Uses the good thing you built to its full extent rather than adding
a new one.

### 6.8 Continue reading — next and previous post
**Frontend only. ~half a day.** The post screen knows which list you arrived from
(`previousScreen()` already exists for the back link). Offer the next post at the end
of the one you just finished, and wire `j`/`k` on the post screen to move through the
same list. It turns a feed of one-offs into something you can actually sit and read.

---

## 7. Tier C — the backend half

Secondary by your own framing, but this is where two of the §3 findings live.

| # | Item | Why | Cost |
| --- | --- | --- | --- |
| C1 | **The snapshot anchor** `?as_of=` (§3.1) | Stops the live pill duplicating cards; amends ADR 0005 rather than replacing it | 0.5 day, both halves |
| C2 | **`voted` on `PostOut`** (§3.2) | Deletes a documented compromise | 0.5 day, both halves |
| C3 | **Notifications** — someone replied to you | The one remaining "real social app" gap. A `notifications` table, a badge on the header lamp, polled on the same timer as §5.3 | 2 days, both halves |
| C4 | **`/api/v1` prefix** | The last item of the original Faza 5; cheap now, expensive after anyone depends on the paths | 0.5 day |
| C5 | **ETag / `If-None-Match` on the feed** | A 304 on an unchanged feed makes the §5.3 poll almost free. Pairs with C1 | 0.5 day |

C3 is the largest thing in this document and I'd do it last, or not at all — it's only
worth it if §6.4 (replies) lands first, because a notification needs something to
notify you *about*.

---

## 8. Tier D — craft, half a day or less each

The accumulation of these is what makes software feel expensive.

- **Theme change as a view transition.** Wrap `toggleTheme()` in
  `document.startViewTransition` and the whole room cross-fades from lamplight to
  daylight instead of snapping. Thirty minutes. Disproportionate payoff. Skip it under
  reduced motion.
- **Optimistic post creation.** Your new post appears at the top of the feed before the
  server has answered, with a rollback path — the pattern votes and comments already
  use, applied to the one write that still makes you wait.
- **Draft autosave.** `commons.draft`, written on a debounce, restored with "Picked up
  where you left off" and a way to discard it. Losing a half-written post to a
  mistyped hash URL is the app's worst remaining papercut.
- **Live word count and reading time in the composer**, mirroring what the card will
  say. Writers like watching it climb; that's dopamine that costs nothing.
- **An empty-state pass.** Empty feed, empty search, empty profile, empty shelf. Four
  sentences, each an invitation to act rather than a shrug.
- **Scroll restoration on the profile view**, which the feed has and the profile doesn't.
- **Number the first five palette results** so `⌘K` then `3` works. Muscle memory is
  its own reward.
- **`aria-live` on the "new posts" pill**, so §5.3 is announced and not just drawn.

---

## 9. Explicitly not doing

| Item | Why not |
| --- | --- |
| **Streaks, badges, levels, confetti** | The casino vocabulary. It would contradict the one thing the design is actually saying. §4. |
| **Sound effects** | Same, and worse on a phone. |
| **An AI feature** ("summarize this thread") | There is no server in production to hold a key, and a key in a static bundle is a key you've published. A bolted-on LLM call is also the most templated thing a 2026 portfolio project can have. |
| **Image uploads** | Unchanged from the last plan: needs object storage, which the hosting constraint rules out. |
| **Follows / a social graph** | Unchanged: fourteen seeded posts can't populate a graph. §6.4 (replies) gives you the social depth at a tenth of the cost. |
| **Infinite comment nesting** | §6.4 explains the judgement. One level, deliberately. |
| **WebSockets** | §5.3 explains the arithmetic. Revisit only if the feed ever changes more than a few times a minute, which it won't. |
| **A framework rewrite** | §6 of the previous plan still holds, and every item above is cheaper in this codebase than the migration would be. |

---

## 10. The order

Sequenced so that each step makes the next one cheaper, and so that the first week
already changes what a visitor sees.

**Week 1 — the room remembers you.**
1. §3.5 split `post.js` and `components.css` (half a day, unblocks everything else)
2. §5.1 read state, new-since, reading time
3. §6.3 the warmth ignites (two hours, do it while you're in `ui.js`)
4. §8 theme transition + empty-state pass

**Week 2 — the reading room.**
5. §5.2 focus mode, reading controls, print, select-to-quote
6. §5.4 the colophon (and the CI `stats.json` it reads)
7. §6.8 next/previous post

**Week 3 — make the data mean something.**
8. §3.1 / C1 the snapshot anchor, and §3.2 / C2 the `voted` flag
9. §6.2 sort + the ranking ADR
10. §6.7 search highlighting

**Week 4 — alive, and yours.**
11. §5.3 the "new posts" pill (needs C1)
12. §6.1 the shelf, §6.6 offline (they belong together)
13. §6.5 settings + sign out everywhere

**Later, if the appetite is still there.** §6.4 threaded replies, then C3 notifications.
Those two are a project of their own and the app is complete without them.

If you only do one week, do week one: it's entirely client-side, it ships to the
published demo the day it's written, and it's the week that changes how the app *feels*.

---

## 11. Definition of done — unchanged from how you already work

Every item above is finished when:

- Playwright passes against **both** projects (`mock_api.py` and demo mode).
- `axe` is clean on any screen it touches, and the keyboard journey still works.
- Reduced motion is respected, and the feature degrades to "nothing happens" rather
  than to "broken".
- Lighthouse hasn't moved. (A service worker should *raise* it.)
- If it's a data feature: `docs/openapi.json` re-exported, both halves implemented,
  `mypy --strict` and `tsc --noEmit` clean.
- If a decision in it was load-bearing, it has an ADR — and if the ADR supersedes an
  earlier one, the earlier one says so.
- One entry in `CHANGELOG.md`, in the project's own voice: what changed, and what was
  wrong before.
