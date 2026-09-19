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

- **Notifications.** Somebody replies to your comment, or comments on your post,
  and a count appears on a lamp in the header. `#/notifications` lists them —
  who, the first words of what they said, and which post — with the whole line
  as the link. Opening the screen marks everything read, all of it rather than
  what you happened to scroll past, because a count that depends on how far
  somebody scrolled is a count nobody can predict.

  **A vote makes no notification.** That is a decision, not an omission: a vote
  is a number moving, and "three people upvoted you" is precisely the mechanic
  the design thesis in `UPGRADE_PLAN_V2.md` §4 spends a page arguing against.
  Everything here is a person having said something, so every line has
  somewhere to take you and something to answer.

  **One comment, at most one notification.** A reply addresses the person it
  answers; a top-level comment addresses the post's author. The two rules do not
  overlap, so a reply on your own post tells whoever was replied to and not you
  as well — everybody with a stake in a thread hearing about everything in it is
  how a notification list becomes something people turn off. Talking to yourself
  produces nothing.

  Three foreign keys, all cascading: delete the comment, the recipient or the
  actor and the notification goes, because a line saying "bea replied to you"
  that points at nothing is worse than silence. Each cascade has a test named
  for it, and each was checked by removing that one `ondelete` and watching
  that test — and only that test — fail.

  The count and the list are **one endpoint**: `?unread=true&page_size=1`, and
  the answer is the envelope's `total`. Polled every forty-five seconds, only
  while the tab is visible, on the same interval as the feed's poll so the two
  don't drift into talking to the server twice and then not at all.


- **Conditional requests on the feed and on a post.** Both carry a weak `ETag`;
  hand it back as `If-None-Match` and an unchanged answer is a `304` with no
  body. The client keeps the last two dozen responses in memory, keyed by full
  path, and clears them whenever the session changes — they can contain the
  reader's own drafts.

  **What it saves is bytes, not database work**, and the plan's claim that it
  would make the "new posts" poll almost free was wrong. The fingerprint is
  taken from the rendered response, so by the time a `304` can be decided on,
  the query has run and the JSON has been built. The poll asks for
  `page_size=1` and its body was already tiny. It is applied to the feed
  because the feed is where the kilobytes are, and `app/etag.py` says so in
  those words rather than repeating the claim.

  Two details that would each have made it fail silently — every request
  unconditional, everything still working, nobody any the wiser. `ETag` is not
  a CORS-safelisted response header, so without `expose_headers` the browser
  keeps the validator for its own cache and `res.headers.get("ETag")` is null;
  and `If-None-Match` has to be in `allow_headers` or the preflight refuses the
  request before it is made. There is a test that fails when either is removed.


- **The lights come up.** Changing the theme cross-fades the whole page instead
  of snapping. Every colour is a custom property, so the flip is one attribute
  and the repaint is instantaneous — which is exactly why it read as a glitch.
  It gets its own recipe rather than the page-change one: both ends fade and
  neither travels, because a theme change is one picture of the room dissolving
  into another rather than a journey to a different room. The header gives up
  its own snapshot for the duration, so the chrome changes colour with
  everything else instead of holding its old palette while the rest crosses
  over. Skipped entirely under `prefers-reduced-motion`, which the View
  Transitions API does not consult on its own.

- **⌥1 to ⌥5 run the first five rows of the palette.** Alt rather than a bare
  digit: the palette is a text field, and taking `3` away from it would mean no
  post whose title starts with a number could ever be searched for. ⌘1–⌘8
  belongs to the browser's tab bar and a page cannot reliably take it back.
  Matched on `event.code`, because on a Mac Alt+1 arrives as `¡`.

- **A profile comes back where you left it**, which the feed has done for a
  while and the profile did not. That meant the store had to hold more than one
  list: with a single slot, visiting a profile on the way back to the feed
  would have evicted the feed. It holds four now — enough for the feed under
  two orderings, a profile, and the search you came from.

- **The composer says what you have written, not how close you are to a wall.**
  `1,234 / 5,000` became `312 words, about 2 min`, from the same
  `readingMinutes` the card and the post screen use — so the figure a writer
  watches is the figure a reader will be shown. The character count is not
  gone; it appears within four hundred characters of the limit, which is far
  enough ahead to cut a paragraph rather than a sentence.

- **A half-written post survives the tab.** The composer keeps what you type in
  `commons.draft`, debounced at half a second, flushed on `pagehide` and
  `visibilitychange` because a phone reclaiming a tab never fires unload. Come
  back and the form is as you left it, above one line — *Picked up where you
  left off* — and a way to start fresh. It is cleared once the server has the
  post and **not** before: the write that fails is the one moment the words
  exist nowhere else, so that path flushes them to disk instead. Stamped with
  who typed it, for the reason the feed cache is. New posts only; editing an
  existing post already has somewhere to keep its words.

- **The empty states ask for something.** A search that found nothing says that
  it looks at titles and bodies and to try one word rather than several. An
  empty feed invites a signed-in reader to be the first and tells a signed-out
  one to sign in, rather than offering a door that is locked. A stranger's
  empty profile names them — *bea hasn't posted anything yet* — because
  "Nothing here yet" on somebody's profile reads like a page that failed to
  load.


- **Your account.** A screen at `#/settings` with the three things you can do to
  one, in the order that runs from the reversible to the permanent: change the
  name everybody sees, sign out everywhere, delete the account.

  **Renaming is safe because identity was never the name.** Posts, comments and
  votes join on `users.id`; a rename touches one column and nothing else moves.
  `PATCH /users/me` takes the username and only the username — a 409 with a
  sentence if it is taken, caught from the database rather than checked first,
  because two people asking for the same free name in the same moment both pass
  a lookup and one of them still has to lose. Asking for the name you already
  have is not a collision, which is the commonest thing done to a settings form
  and the one a naive version answers with *that username is taken*, by you,
  from you.

  **Not the email, and not the password.** Both are the credential half of an
  account and changing either is a flow with a confirmation link in it. Commons
  has no way to send mail, so neither is offered — and the screen says that out
  loud rather than showing a box that half-works.

  **Sign out everywhere is why the sessions are a table.** A stateless refresh
  token cannot be taken back, so `POST /auth/logout-all` would otherwise have
  been a button that cleared one cookie and lied about the rest. It revokes
  every live family for the account, and it authenticates with the *access*
  token rather than the refresh cookie: holding a cookie is enough to end the
  session that cookie belongs to, and ending every other one should take more
  than having once been handed one.

  **Deleting takes everything, and the database is what makes that true.**
  `DELETE /users/me` issues one `DELETE` and the six `ON DELETE CASCADE`s do
  the rest — posts, the comments under them, the comments left under other
  people's posts, the replies to those, votes, and sessions. Nothing is
  enumerated in the handler, so it cannot drift from what the schema says. Each
  cascade has a test named for it, and each was verified by removing that one
  `ondelete` and watching that test, and only that test, fail. The confirmation
  is typing your own username: the one check a reflex cannot clear.


- **The feed tells you when something arrives.** A pill at the top of the list
  — *Three new posts* — offering them rather than moving the page under you.
  Press it and they go in above what you were reading, and the page goes to the
  top because that is what you pressed it for.

  **Polling, not a WebSocket, and the arithmetic is the argument.** This feed
  receives a few posts a day. A socket would hold a connection open per reader
  for hours to deliver a handful of messages, push async concerns into an
  otherwise synchronous SQLAlchemy codebase, and — the part that settles it —
  could only ever be demonstrated on somebody's own machine, because the
  published build has no server at all. Every forty-five seconds, only while
  the tab is visible and the feed is on screen, one request that answers with
  one number: `GET /posts/?page_size=1&since=…`, whose envelope's `total` is
  exactly how many have arrived.

  `since` is the other end of the window `as_of` opened — one closes the feed at
  the top so a scroll holds still, the other opens it at the bottom so the pill
  can count. New rows are prepended *above* the paginated set rather than into
  it, so taking them doesn't renumber a single page below; that is what
  [ADR 0005's third trigger](docs/adr/0005-offset-pagination.md) was for.

  Not offered on a ranking or a search: neither is in time order, so there is
  no anchor to ask "since" of and nowhere sensible to put what came back.

- **The demo is coherent across two tabs.** `js/demo/backend.js` now listens for
  the `storage` event and re-reads its state when another tab writes — which is
  the only way the pill above can be shown on a site with no server, and the
  best two-tab demonstration this project has. Safe by construction: the event
  fires only in the *other* tabs, and every mutation in that file already saves.
- **Replies, exactly one level deep.** You can answer a comment rather than
  only the post. The depth is declared in the API's own schema — `ReplyOut` has
  no replies of its own, so the shape of the response cannot express a third
  level — and enforced in one check that answers 400 for a reply to a reply and
  404 for a parent that isn't a comment on this post. Unbounded nesting is a
  rendering problem, an indentation problem on a phone and a moderation
  problem, and on a feed this size it buys nothing.

  The page is over **conversations**, and replies arrive with their parent:
  paging the two together would eventually put a page boundary through the
  middle of an exchange, which is the one place a boundary must not fall. So
  `total` counts conversations — it is what `pages` is computed from — and a
  new `total_replies` says how many messages hang off them, which is what the
  heading adds up. On screen a reply is indented under what it answers behind a
  hairline, with no Reply control of its own; the cascade on `parent_id` is at
  the database, so a comment that goes takes the replies to it whoever issued
  the DELETE.
- **A search result shows the sentence it matched on**, with the matching
  words marked — stemmed, so searching "kettles" marks "kettle". `ts_headline`
  does it, which is the rest of the reason for having a `tsvector` rather than
  a `LIKE`: a result that shows *why* it is a result is worth more than the
  first 280 characters of it. Computed only when somebody searched, and only
  for the rows actually being returned, because it re-parses each document.

  **The marks are two control characters, not HTML.** `ts_headline` is not a
  sanitiser and never claimed to be: what it does with markup falls out of how
  the text-search parser classifies tokens, so a `<script>` disappears while
  `<img src=x onerror=…>` leaves `onerror=…>` behind, closing bracket and all.
  Marked up as `<b>…</b>` and handed to `innerHTML`, this would be stored XSS
  with a search box in front of it. The client splits on the markers and
  appends text nodes and real `<mark>` elements instead, and there is a test
  that fails with an `<img>` on the page the moment anybody reaches for
  `innerHTML`.
- **Three ways to order the feed** — newest, warmest, discussed — and with them
  the first thing in this app that makes a vote *do* something rather than
  decorate a card. Both rankings decay, so neither becomes a museum of whatever
  was liked first, and they decay at **different rates**: votes at gravity 0.5,
  a half-life of about six hours; comments at 0.25, about thirty. A vote is a
  reaction and it stales; a conversation is a thing you can still join. Both
  constants were chosen by measuring them against the seeded feed rather than
  by copying Hacker News — at its 1.8, "warmest" here returns exactly
  chronological order among the posts that have votes, which is a sort
  reproducing another sort. The measurements are in
  [ADR 0008](docs/adr/0008-a-ranking-with-two-gravities.md).

  Two things the feed does had to learn that a ranking is not in time order:
  the "new since" count and the rule under it are only drawn on the newest
  feed, and the `as_of` window is only sent for it — an anchor taken from the
  top of a ranking is not the newest post, so it would cut posts out of the
  window rather than hold it still.
- **`GET /posts/?as_of=`** — a window on the feed. Offset pagination counts
  from the top, so a post written between one page and the next pushes every
  later page down by one and hands the reader a card they have already read.
  The feed asks for page one unanchored — page one *is* the window — and sends
  back the `created_at` of the newest post it got on every page after it. The
  anchor is a server timestamp rather than the browser's clock, so there is no
  skew to get wrong; it isn't sent while searching, where results are ordered
  by relevance and the first one isn't the newest; and the parameter doesn't
  exist on a profile, because nothing inserts into a profile while it is being
  read. [ADR 0005 is amended](docs/adr/0005-offset-pagination.md) with the
  trigger its original two didn't cover, and with why this isn't yet the moment
  for keyset.
- **`PostOut.voted`** — whether the person asking has upvoted this post. It is a
  property of the pair rather than of the post, so the same row answers
  differently for two readers; `votes` is still the room's count. Free on the
  feed, where the query already outer-joins every vote in order to count them,
  so the flag is a second aggregate (`bool_or`, coalesced — a post with no
  votes comes back from the outer join as one NULL row) over rows that were
  read anyway. A single post gets a second small lookup instead.
- **A colophon**, at `#/colophon`. The page at the back of a book names the
  type, the paper and the press; this one names what Commons is made of, and
  what it is honest to say about the copy you are looking at — including the one
  place demo mode had to compromise, volunteered rather than left to be found.
  The figures are measured by `docs/stats.py` into `frontend/stats.json` and
  re-checked in CI from both jobs, so a number that moved turns the build red
  instead of leaving the page describing last month. It is set as a
  specification table rather than a grid of stat cards, which is the default
  treatment for numbers and would have made the one page about craft look like
  a dashboard. There is no list of keyboard shortcuts on it on purpose: a second
  copy is a copy that goes wrong, so it has a button that opens the palette.
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

- **The API moved to `/api/v1`.** Every route the app serves is under it; `/`
  and `/healthz` deliberately are not, because a liveness probe is asked for by
  whatever is running the container and has to keep answering across a version
  bump. The prefix is a constant in `backend/app/config.py`, attached once by a
  parent router, and mirrored in `js/config.js`, `tests/mock_api.py` and
  `js/demo/backend.js` — every path in all four is still written without it.

  **Done now precisely because nothing depends on it yet.** A version in the
  path buys the ability to change the contract without breaking whoever is
  already using it, and that option has to be bought before it is needed. Today
  it cost an afternoon; after one person writes a script against `/posts/` it
  costs a deprecation window.

  What it actually cost is in [ADR 0009](docs/adr/0009-a-version-in-the-path.md),
  including the part that is invisible until it happens: the refresh cookie's
  `Path` moved with the prefix, so every session issued beforehand stopped being
  sent and everybody signed in once more. Nothing was lost and nothing was
  insecure — the old cookie simply became unreachable — but on an app with an
  audience that is a very different afternoon.


- **The vote control stopped guessing.** It used to read the filled caret out
  of a set of post ids in `localStorage`, because the API had no way of saying
  — so your own votes were invisible on a second device, invisible in a private
  window, and wrong after clearing site data. It reads `voted` off the post
  now. The old `commons.votes` key is *removed* on boot rather than merely left
  alone: a guess about somebody's voting is still a record of it.

  What the mirror did do correctly is now done properly. The feed fetches one
  copy of a post and the post screen fetches another, so voting on the second
  left the first disagreeing when the cache put it back on screen; a vote is
  written onto every copy this session holds, which patches real data instead
  of keeping a parallel record of it.
- **`views/post.js` is two files.** It had grown into the post, the owner's
  actions, the comment list, one comment and the composer for writing one —
  seven hundred lines in which the screen everybody actually reads was the
  shortest section. The conversation moved to `js/components/comments.js`, which
  is where the next thing done to it belongs. Nothing changed in the move, on
  purpose: a refactor that also fixes things is a refactor nobody can review.
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

- **Any list could be torn down by an event that changed nothing, and the
  profile usually was.** `hashchange` fires once per *event*, not once per
  screen, and two navigations in quick succession queue two events that both
  read the same final hash. The router already dedupes the second one — it
  builds no new screen — but every list view had hung its own teardown on a
  plain `hashchange` listener, which ran anyway and disconnected the observer
  and aborted the in-flight fetch of the screen that was still on the page.

  Signing out navigates home, so signing out and then opening a profile hit it
  almost every time: heading drawn, skeletons drawn, and nothing ever replacing
  them. Nothing logged and nothing threw. The check the router makes for itself
  is now made for the views too, in `onLeavingScreen`.

- **Coming back to a list landed about four hundred pixels too high.** The
  position was read at teardown, and by then the page had moved: activating a
  card focuses its link, and the browser scrolls a focused element clear of the
  sticky header before any of our code runs. Measured on the feed, leaving from
  900px cached 498. It is now taken at the last moment it is still the
  reader's — the press that starts the navigation — and only trusted for a
  second afterwards, so a navigation nobody pressed for still falls back to
  asking the window.


- **The danger red failed AA on every light surface.** `--danger` was `#c0492f`,
  which measures 4.37:1 against `--bg` — under the 4.5:1 small text needs. It
  had gone unnoticed for the ordinary reason: the two screens carrying a quiet
  danger button (a post you wrote, and now your account) were not being
  axe-scanned, so nothing ever asked. It is `#a63a22` now — the same hue walked
  down until it clears on every light surface, 5.69:1 on `--bg` and 6.29:1 on a
  card.
- **Two destructive buttons sat side by side at 320px.** They fit, which was the
  problem: a thumb aimed at *Keep it* landed a few millimetres from *Delete my
  account*, and of the two mistakes only one is recoverable. Below 380px the
  confirmation row stacks and both go full width.
- **Deleting an account cleared the refresh cookie with the wrong flags.** A
  browser only replaces a cookie whose name, path *and* flags match, so clearing
  it without `Secure` would have left the original sitting there in production.
  The flags were already written down correctly next to the route that sets
  them; they now live in `oauth2.clear_refresh_cookie`, which all three ways of
  ceasing to be signed in call.


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
