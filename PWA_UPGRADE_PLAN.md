# Commons — the PWA plan

Written 2026-09-20, against a clean tree with the last of `UPGRADE_PLAN.md` and
`UPGRADE_PLAN_V2.md` closed out. Those two files are gone; what they contained is
in `CHANGELOG.md`, in `docs/adr/` and in the history.

This one is about a feature that is already built and that nobody can find.

---

## 1. Where it actually stands

`manifest.webmanifest` has eleven keys and four icons, all generated from the one
brand mark by `docs/make_icons.mjs`. `sw.js` is 202 well-reasoned lines,
network-first, with `tests/offline.spec.js` holding it to its word and
[ADR 0007](docs/adr/0007-a-network-first-service-worker.md) explaining why not
cache-first. That is a real PWA, better than most, and **the app never once
mentions it**.

Three findings, each verified rather than assumed:

1. **`grep -r beforeinstallprompt frontend/` returns nothing.** There is no
   install affordance anywhere in the app. The only route to installing is
   Chrome's own address-bar icon, which is exactly the symptom: a feature that
   exists in the URL bar and nowhere else.
2. **The manifest has no `screenshots` key.** This is the specific cause of the
   weak install dialog. Without it Chrome on Android shows a cramped
   mini-infobar instead of the rich install card, and desktop shows a bare
   one-liner. It is the single highest-leverage key in the file.
3. **Nothing in the app behaves differently when installed.** No
   `display-mode: standalone` branch in the CSS, no `appinstalled` handling. The
   installed app is the website in a frameless window.

Two smaller things: `orientation: portrait-primary` is asserted for an app that
is installable on a desktop, and there is no `display_override`,
`launch_handler`, `categories`, `lang` or `dir`.

---

## 2. The rule everything below has to obey

From the design thesis the second plan left behind, and it has not moved:

> **The amber is spent on three things: a vote, warmth, and where you are.**
> Anything new that wants attention has to earn it with *structure* — weight,
> space, position, a hairline — not with a second colour.

A floating "Install this app!" bar would break that outright, and it would break
it on the first screen a visitor sees. Every placement in §4 is chosen against
that rule rather than around it.

The second constraint is the one from the last plan that still decides
everything: **there is no server in production.** It rules out Web Push on its
own, and it is the reason the offline story in §6 is the truest thing this app
could possibly ship.

---

## 3. Finish the manifest — ½ day

First, because the install button in §4 is only worth pressing if what it opens
looks like an app.

| Key | What | Why |
| --- | --- | --- |
| `screenshots` | Two or three at `form_factor: "wide"`, two or three at `"narrow"`, each with a `label`. | The rich install card. This is the one that changes what the dialog looks like. |
| `shortcuts` | *Write a post* (`#/compose`), *Your shelf* (`#/shelf`), *Notifications* (`#/notifications`), each with an icon. | Long-press the installed icon and get them. The most "this is a real app" moment available for the effort. |
| `display_override` | `["standalone", "minimal-ui"]` | A browser that can't do one falls to the other rather than to a full tab. |
| `launch_handler` | `{ "client_mode": "navigate-existing" }` | A shortcut or a share reuses the open window instead of stacking a second one. |
| `categories`, `lang`, `dir` | `["social", "news"]`, `"en"`, `"ltr"` | Free, and catalogues read them. |
| `orientation` | **Remove it**, or `"any"`. | A reading app that refuses landscape on a tablet is worse, not more app-like — and the type system exists for long-form reading. |

**Generate the screenshots, don't take them.** `docs/make_icons.mjs` already
drives Chromium to render the brand mark and the OG card, so nothing can drift
from the header. Extend it to load the feed, a post and the colophon at both
viewports against the demo adapter. Screenshots that are taken by hand are
screenshots that are six months old by the time anyone looks at the dialog.

**Done when:** the manifest parses, every icon and screenshot it promises
resolves 200, and `tests/offline.spec.js` says so — it already has the test that
keeps the service worker's shell list in step with what is on disk, and this is
the same shape of check.

---

## 4. The install button — 1 day

### The trap

`beforeinstallprompt` is Chromium-only. iOS Safari has no prompt at all and
never will; Firefox has no install. A single "Install" button is therefore dead
or lying for a large share of visitors — and a dead button in the masthead is
worse than no button, because it is the first thing a recruiter clicks.

### The strategy: four states, one of which renders nothing

| State | How it is known | What renders |
| --- | --- | --- |
| Installable now | `beforeinstallprompt` fired and the event is stashed | *Install Commons* — calls `prompt()` |
| Installable, no API | iOS/iPadOS Safari, and not already standalone | *Add to your home screen* — expands one sentence: Share → Add to Home Screen |
| Already installed | `matchMedia("(display-mode: standalone)")`, or `appinstalled` fired this session | **Nothing.** Never a disabled button |
| Not installable | anything else | **Nothing** |

Two mechanics worth a comment in the code, because both are the kind of thing
that is discovered the hard way:

- **The event must be captured at boot with `preventDefault()`**, or Chrome
  shows its own mini-infobar instead and the button never gets a turn.
- **The stashed event is single-use.** After `prompt()` resolves it has to be
  discarded and the control removed *whatever the outcome was*, or the second
  press silently does nothing.

### Where it goes — three places, no banners

1. **The masthead** (`views/feed.js`), anonymous visitors only. It is already
   the one block of type where a first-timer is told what this is, it already
   carries the demo notice and the *How this was made* link, and it already
   collapses once you sign in or scroll past it. One more line in the same
   voice: *It installs, too — it works on a plane.* This is the
   recruiter-facing surface.
2. **The command palette**, one row, offered only in states 1 and 2. The palette
   is already the app's index of itself.
3. **The colophon**, in *What's honest about this demo*. Somebody reading that
   page is exactly the person who will install it.

Later, once §3 of the Settings plan exists, a fourth home: an *App* row that
also states install status. That is the utilitarian placement; the masthead is
the persuasive one.

**Done when:** a Playwright spec drives state 1 under Chromium (the event fires
in headless Chrome), asserts the control is absent in standalone, and asserts
that the second press after a resolved prompt does nothing. Plus axe on the
masthead with the row present.

---

## 5. Make it feel native when installed — 1 day

This is what separates an app from a bookmark with an icon.

- **A `@media (display-mode: standalone)` branch.** In a frameless window there
  is no browser chrome, so the header is the only thing separating content from
  the title bar and should pick up a slightly heavier bottom edge and sit under
  the safe-area inset. Use `env(titlebar-area-*)` where it exists.
- **`navigator.setAppBadge()` / `clearAppBadge()`**, wired to `unreadCount()` in
  `notify.js`. The count already exists and already polls; this puts it on the
  dock or the home screen. **This is the highest "how did they do that" per line
  in the whole plan — roughly fifteen lines, no server, no permission prompt.**
  Guard it: Safari throws when the app isn't installed.
- **`navigator.share()`** upgrading the palette's *Copy a link to this post* —
  native share sheet where there is one, clipboard where there isn't. Same
  command, better on a phone.
- **`theme_color` should follow the theme.** `index.html` already ships both
  `<meta name="theme-color">` variants; the manifest asserts one dark value, so
  an installed light-mode window currently gets a dark title bar.
- **Check the back gesture in standalone**, where there is no address bar to
  escape to. A Playwright assertion, not an assumption.

---

## 6. Functionality that fits *this* app — 1–2 days

Ranked by return per hour, and by whether it survives the no-server constraint.

1. **Share Target.** Installed, Commons appears in the Android share sheet;
   share a link or some text to it and the composer opens pre-filled. For an app
   whose entire point is writing things down, this is the best fit on the list,
   and it is the one that makes people say "native". It needs a target URL the
   hash router can read, which is deliverable precisely because everything is
   client-side.
2. **Offline reading depth.** The shell is precached; **the shelf is not.** The
   second plan spotted this and it is still true: *your shelf is exactly the set
   of posts worth precaching.* Add a runtime cache for shelved posts, warmed
   when one is saved. That makes the shelf the reason to install, which is a far
   better story than "it caches CSS". It also composes with the shelf's new
   server half — the sync at boot is the natural moment to warm it.
3. **An offline state the app actually shows.** `online`/`offline` events → one
   quiet line, not a toast storm, and the composer saying the draft is safe
   (`commons.draft` already keeps it). Half a day, and it is the difference
   between working offline and *looking like* it does.
4. **Background Sync** for a post written offline against a real backend.
   Genuinely impressive, and honestly scoped: on the published demo there is no
   network to be offline *from*, because the adapter answers locally. Build it
   only if we are willing to say that plainly.

### Explicitly not doing

| Item | Why not |
| --- | --- |
| **Web Push** | Needs a server holding VAPID keys. A key in a static bundle is a key you have published — the same argument that ruled out an AI feature. |
| **Periodic Background Sync** | Chromium-only, gated behind engagement heuristics nobody can demonstrate on demand. |
| **File Handling / Protocol Handlers** | Nothing here opens a file type or a scheme. |
| **Cache-first** | ADR 0007. Still right, and more right now that there are more files. |

---

## 7. Make it provable — ½ day

Everything above is invisible to a reviewer who never installs. So:

- **A colophon section on the PWA**, in the existing typeset voice: what a
  service worker is here, why network-first was right for an app with no
  content-hashed filenames (ADR 0007 in one sentence), what installing buys.
  This is where the reasoning becomes visible to somebody who will not open
  DevTools.
- **One GIF in the README**: install from the button → the app in its own
  window → airplane mode → still reading.
- **Installability assertions in `offline.spec.js`** — the manifest parses,
  every icon and screenshot resolves 200, `beforeinstallprompt` fires under
  Chromium. A *tested* PWA is a rarer signal than a PWA.
- **ADR 0010**, on the install-button strategy: why a capability-detected
  control with a silent state beats a banner, and why iOS gets a sentence rather
  than a dead button.

---

## 8. The order

1. §3 finish the manifest — ½ day
2. §4 the install button — 1 day
3. §5 native feel, badging first — 1 day
4. §7 make it provable — ½ day
5. §6 share target, then the offline depth — 1–2 days

**About four focused days.** Steps 1, 2 and 4 alone are two days and get most of
the visible return.

---

## 9. Definition of done — unchanged from how we already work

- Playwright passes against **both** projects (`mock_api.py` and demo mode).
- `axe` is clean on any screen it touches, and the keyboard journey still works.
- Reduced motion is respected, and the feature degrades to "nothing happens"
  rather than to "broken".
- Lighthouse hasn't moved. (More of the manifest should *raise* it.)
- `tsc --noEmit` and `prettier --check` clean; visual baselines re-recorded
  deliberately if a screen changed, never reflexively.
- If a decision in it was load-bearing, it has an ADR.
- One entry in `CHANGELOG.md`, in the project's own voice: what changed, and
  what was wrong before.
