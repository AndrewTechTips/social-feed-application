# Commons — the Settings plan

Written 2026-09-20, alongside [`PWA_UPGRADE_PLAN.md`](PWA_UPGRADE_PLAN.md).

There is already a `#/settings`. This is about the two things wrong with it and
the things that genuinely have nowhere else to live.

---

## 1. Where it actually stands

`views/settings.js` is 323 lines with a spec of its own. It does three things —
rename yourself, sign out everywhere, delete your account — in that order,
running from the reversible to the permanent, and it says out loud why changing
your email or password isn't offered (both need a confirmation sent by mail this
project has no way to send).

Two real problems.

**It is nearly unreachable.** `grep -rn "#/settings" frontend/js` returns exactly
one link: a text link on your own profile. The palette's *Your account* row goes
to the profile, not here.

**The header is full.** Signed in, `main.js` renders six controls —
notifications, write, shelf, username, sign out, theme — and the comment beside
them notes they already fought for space at 320px.

And one decision, in the file's own header comment, that this plan **keeps**
rather than overrules:

> Nothing here is a preference: theme, text size and focus mode belong to the
> browser rather than to the account, and they live where you are when you want
> them rather than on a screen you have to go and find.

That is correct, and it is why the reader control sits on the post screen. So
the plan is not "move the preferences into Settings". It is: give Settings a
door, and give it the things that have nowhere else to be.

---

## 2. The UI: one door, three sections

### The door

**Replace the header cluster with an account menu.** The avatar — `format.js`
already builds one from a username — becomes a single button opening a small
popover: *Your shelf · Notifications · Settings · Sign out*. The theme toggle
stays outside as its own button, because it is a one-press action rather than a
destination.

That reclaims header space at 320px **and** creates the entry point the screen
has never had.

One mechanic to decide deliberately rather than by accident: this is the app's
first floating layer. `components/reader.js` chose inline expansion specifically
to avoid positioning, a focus trap, an outside-click rule and a scroll listener,
and wrote that down. So either pay that cost properly, once, with `popover` plus
CSS anchor positioning and a `<dialog>` fallback — or don't, and expand inline
the way the reader panel and the delete confirm both already do. Either is
defensible; what isn't is a `position: absolute` with no note saying which was
chosen.

### The screen

**1 · Your account** — what is already there, unchanged, including the honest
note about email and password.

**2 · This browser** — the new section, and the interesting one. Everything in
it is device-local, which is exactly what makes it worth a screen.

**3 · About** — install state, version, offline state, links to the colophon and
to the keyboard shortcuts.

---

## 3. What goes in it

Ranked. The first three are the ones worth building.

### ① The data panel — "what this browser knows about you"

Commons keeps ten `localStorage` keys, and `reading.js` carries an unusually
careful comment about why a record of what somebody has read belongs on the
machine doing the reading and is *sent nowhere*. Put that on screen: each key in
plain English, with its size and a control.

| What | Key | Control |
| --- | --- | --- |
| 47 posts you've read | `commons.read` | *Forget what I've read* |
| 6 posts on your shelf | `commons.shelf` | *Empty the shelf* |
| A saved draft | `commons.draft` | *Discard it* |
| Theme, text size, line width | `commons.theme`, `commons.textsize`, `commons.measure` | *Reset* |
| Sign-in | `commons.identity`, `commons.csrf` | explained, not deletable here |

Plus one *Forget everything on this browser* at the bottom.

**None of these clear functions exist yet.** `reading.js` and `shelf.js` export
readers and togglers and no resets, so this is a small, well-shaped piece of work
rather than a UI over something that already exists.

One thing that has to be got right, and it is the reason this can't be a loop
over `localStorage`: **the shelf is no longer only local.** *Empty the shelf*
signed in has to mean the account's shelf, not just the mirror, or the next sync
puts it all back and the control reads as broken. The same distinction the shelf
screen's own line already makes.

This is the standout item. It is a privacy feature that is genuinely honest
rather than performative, it is entirely client-side except for that one case, it
ships to the demo the day it is written, and nobody else's portfolio feed has it.

### ② Theme: System / Light / Dark

A real gap rather than a nice-to-have. The bootstrap in `index.html` reads
`commons.theme` and falls back to `prefers-color-scheme` — but `toggleTheme()`
writes a concrete value, so **the first press pins you forever with no way back
to following the system.**

Three radios, `"system"` stored as its own value, and a `matchMedia` listener
while it is active. The header toggle stays as the fast path and simply moves you
off `system` when pressed.

### ③ Reading defaults

Text size and line width, set here as defaults rather than per-post. Both now
exist as tokens and as controls (`reading.js`, `components/reader.js`), so this
is exposing them in a second place rather than building anything — and Settings
is arguably the better home for the width: size is something you reach for
mid-read, width is something you decide once.

Same radio-group builder the reader panel already factored out. Two widths, not
four; the risk note from the plan this came from still applies.

### ④ Notifications

`notify.js` polls unconditionally while you are signed in. Give it on/off per
kind (replies to you, comments on your posts), and — once the PWA work lands —
a *Show the count on the app icon* switch driving `setAppBadge`. This is the row
where the two plans meet.

### ⑤ Motion

The app respects `prefers-reduced-motion` thoroughly, but only obeys the OS. A
*Reduce motion in Commons* override is a handful of lines given the CSS already
branches, and it is a genuine accessibility signal: honouring the system setting
is table stakes, letting somebody override it per-app is not.

### ⑥ Install & offline — the *About* section

Install state and the button from the PWA plan, "the shell is cached, N shelved
posts are available offline", and a *Check for a new version* that talks to the
service worker. This is where the PWA becomes legible to somebody who would never
open DevTools.

### ⑦ Export your data

A JSON download of your posts and comments. Half a day, and it reads as a product
that takes itself seriously. Lower priority because the demo makes it slightly
odd — it exports data that only ever lived in the browser.

---

## 4. Explicitly not in Settings

| Item | Why not |
| --- | --- |
| **Focus mode** | A mode, not a preference. `components/reader.js` already argues this and is right: a reader who found every post arriving with no thread and no way back would think the app was broken. |
| **Sort order** | It is a URL. That means it can be shared and Back undoes it, and a copy of it in Settings would be a second source of truth for something the address bar already holds. |
| **Language** | There is no i18n. A menu with one entry is worse than no menu. |
| **A second theme** | The light theme is a deliberately cool off-white and says so in `tokens.css`. A warm cream reading mode would contradict a decision already made on purpose. |

---

## 5. Effort and order

| # | Step | Cost |
| --- | --- | --- |
| 1 | The account menu, and a real door to `#/settings` | 1 day — the popover is most of it |
| 2 | The three-section structure; the account section moves in unchanged | ½ day |
| 3 | ① the data panel, plus the reset functions `reading.js` / `shelf.js` don't have | 1 day |
| 4 | ② theme system/light/dark | ½ day |
| 5 | ③ reading defaults | ½ day |
| 6 | ④ notifications, ⑤ motion, ⑥ About | 1 day |

**Roughly 4½ days.** Everything except ④'s badge switch and ①'s one server case
is frontend-only, so by the write-it-twice arithmetic it costs half: one
implementation, one test pass, and it ships to the published demo the day it is
written.

---

## 6. Definition of done — unchanged from how we already work

- Playwright passes against **both** projects (`mock_api.py` and demo mode).
- `axe` is clean on the new screen, and the keyboard journey goes through the
  popover — which is the part most likely to be wrong, and the reason §2 says to
  decide the floating-layer question deliberately.
- Reduced motion is respected, and the feature degrades to "nothing happens"
  rather than to "broken".
- Lighthouse hasn't moved.
- `tsc --noEmit` and `prettier --check` clean; a visual baseline for the new
  screen, recorded deliberately.
- If a decision in it was load-bearing, it has an ADR.
- One entry in `CHANGELOG.md`, in the project's own voice: what changed, and what
  was wrong before.
