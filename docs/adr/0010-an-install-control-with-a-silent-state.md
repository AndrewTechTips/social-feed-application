# 0010 — An install control with a silent state

**Status:** accepted · 2026-09-20

## What was decided

[`frontend/js/install.js`](../../frontend/js/install.js) works out which of
four states the reader is in, and **two of them draw nothing at all**:

| State | How it is known | What renders |
| --- | --- | --- |
| Installable now | `beforeinstallprompt` fired and the event is stashed | *Install Commons* — a button that calls `prompt()` |
| Installable, no API | iOS or iPadOS, and not already installed | *Add it to your home screen* — a `<details>` holding one sentence |
| Already installed | any `display-mode` that isn't a tab, or `navigator.standalone`, or `appinstalled` fired in this tab | **nothing** |
| Anything else | Firefox, desktop Safari, a browser that has declined | **nothing** |

Never a disabled button, and never a banner. It appears in three places — the
masthead on the feed for anonymous visitors, one row in the command palette,
and the colophon — and all three are the same block, built by `installBlock()`,
which stays in the document while empty so a late event has somewhere to land.

## Why

**A single "Install" button is dead or lying for most of the web.**
`beforeinstallprompt` is Chromium's alone. iOS Safari has no prompt and, after
fifteen years of Add to Home Screen living in the share sheet, is not going to
grow one. Firefox has no install at all. A button in the masthead that does
nothing on a third of visits is worse than no button, because the masthead is
the first block of type a recruiter reads and that button is the first thing
they press.

**The alternative to capability detection is a banner, and a banner breaks the
one rule the design has.** The accent is spent on three things — a vote,
warmth, and where you are — and anything new that wants attention has to earn
it with structure rather than with a second colour. A floating "Install this
app!" bar would break that on the first screen a visitor sees.

**Two mechanics are load-bearing and neither is obvious.**

The event must be caught at boot and `preventDefault()`-ed. It fires once at
the window, so a listener registered after it has fired never hears it, and
without `preventDefault` Chrome shows its own mini-infobar and the control
never gets a turn. `js/main.js` imports `install.js` first for that reason —
module scope is as early as an app with no build step can be.

The stashed event is single use. Once `prompt()` has resolved, that object is
spent and calling it again throws. So it is discarded *before* anything is
awaited, and the control is removed whatever the reader chose — including when
they dismissed the dialog, because a button left behind after a dismissal is a
button that silently does nothing. Chrome fires a fresh event later if it still
wants to, and the control comes back on its own.

**iOS gets a sentence rather than a dead button**, behind a disclosure rather
than printed in full: it is four lines of instructions for one platform, and
the masthead is three lines of type about what Commons is. The native `<summary>`
marker is left exactly as drawn, which is unusual for this app and is the point
— the only people who ever see this control are in iOS Safari, where that
triangle is the platform's own affordance.

## What it costs

**The event cannot be driven by automation, so the headline test is a stub.**
Chrome suppresses the install promotion under automation: it does not fire with
`--enable-automation` dropped, with `AutomationControlled` disabled, in headed
mode, or in real Chrome rather than the bundled Chromium — all four were tried,
and `"onbeforeinstallprompt" in window` is true throughout.
[`tests/install.spec.js`](../../frontend/tests/install.spec.js) therefore
dispatches a cancelable `Event` of the right type carrying a `prompt()` and a
`userChoice`, which is the entire surface `install.js` touches. Everything
downstream of the event is tested for real; Chrome's *decision* to fire is not
ours, and [`tests/offline.spec.js`](../../frontend/tests/offline.spec.js)
covers it from the other end by holding the manifest to the criteria that
decision is made on.

**`display-mode` cannot be emulated either.** Playwright's `emulateMedia` has
no such feature and CDP's `Emulation.setEmulatedMedia` ignores it. The
already-installed state is reached in tests by dispatching the real
`appinstalled` event, and by stubbing `matchMedia` from outside the app —
`install.js` itself still knows only about `matchMedia`, with no test-only hook
in it. A real standalone window is reachable through Chrome's `--app=` flag,
which is how the standalone stylesheet is checked, but only on a machine with a
display.

**The Apple check is user-agent sniffing.** There is no feature to detect: the
whole point is the *absence* of an API, and "no `beforeinstallprompt`" is also
true of Firefox, which cannot install at all and must be told nothing. iPadOS
claims to be a Mac, so the test is the user agent plus `maxTouchPoints > 1`. It
will be wrong the day a desktop Safari ships Add to Home Screen, and the cost
of being wrong is one paragraph offered to somebody who cannot act on it.

**Two states render nothing, so most readers never learn the app installs.**
That is the trade being made: a silent state is invisible, and the alternative
is visible and wrong.

## When to change our minds

- **If Safari ever fires `beforeinstallprompt`**, the Apple branch collapses
  into state 1 and the user-agent check goes with it. The ordering in
  `installState()` already prefers a stashed event over the Apple branch, so
  that day needs a deletion and nothing else.
- **If the install rate is measurable and low**, the masthead line is the one
  to change, not the strategy — a second sentence saying what installing buys,
  not a banner.
- **If Chrome ever fires the event under automation**, delete the stub in
  `tests/install.spec.js` and drive the real thing. The assertions around it do
  not change.
