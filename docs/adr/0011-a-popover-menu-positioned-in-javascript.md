# 0011 — A popover menu, positioned in JavaScript

**Status:** accepted · 2026-09-20

## What was decided

[`frontend/js/components/accountmenu.js`](../../frontend/js/components/accountmenu.js)
is the app's first *anchored* floating layer — the command palette is a
centred modal, which is a different problem — and it is built from three
choices that were made on purpose rather than arrived at:

| | Chosen | Not chosen |
| --- | --- | --- |
| The layer | the native `popover` attribute, `popover="auto"` | a hand-rolled `position: absolute` div; a `<dialog>` |
| The toggle | `popovertarget` on the button | `showPopover()` from a click handler |
| The position | `place()`, twelve lines of JavaScript, anchoring by the panel's **right** edge | CSS anchor positioning behind `@supports` |

The panel carries `role="menu"` with roving tabindex, so the arrow keys, Home,
End and Escape all do what a menu promises. Tab closes it and lets focus carry
on past the button, which is what the APG asks for and is not a focus trap.

## Why

**`popover` is the only one of the three that isn't a judgement call.**
`.site-header` carries a `backdrop-filter`, and a non-`none` backdrop-filter
makes an element a containing block for every fixed-position descendant. A
panel positioned `fixed` inside that header is therefore positioned against
the *header* — silently, and only above 640px, because
[`chrome.css`](../../frontend/styles/chrome.css) drops the filter below that
width for the frame cost. That is a bug that would have been found on a phone
and not on a laptop. A popover renders in the top layer, which no ancestor
containing block and no `z-index` reaches, so the bug cannot happen. Light
dismiss and Escape come with it, from the browser, correct the first time.

**`popovertarget` rather than a click handler, because of one specific bug.**
Press the trigger while a hand-rolled menu is open and the outside-click rule
closes it on `pointerdown`, then the trigger's own handler opens it again — so
the control that opened the menu cannot close it. The invoker attribute is the
browser doing that bookkeeping, and it also keeps the panel in the invoker's
tab order even though it is drawn somewhere else entirely. There is an
assertion for it in `tests/accountmenu.spec.js`.

**Positioning in JavaScript, and specifically not CSS anchor positioning.**
Anchor positioning is the pretty answer and it is Chromium-only, which means
an `@supports` branch with a JavaScript path underneath it anyway: two
behaviours, one of which nobody on this project can look at. `chrome.css`
already makes this exact call about `env(titlebar-area-*)` — *a branch for a
mode the app cannot enter is a branch nobody can check.* One code path is
twelve lines and behaves the same everywhere.

**`place()` anchors by `right`, not `left`, and that is the whole trick.**
Anchoring by the left edge needs the panel's width, and a popover that has not
been shown yet is `display: none` and measures zero — so a width-based place
can only run once the panel is on screen, which is one frame too late. It
showed as a real flash: the panel painted at the wrong end of the header and
jumped. Anchoring by the right edge hands that arithmetic to the browser, so
the work happens in `beforetoggle`, before the first paint, and there is
nothing to jump. The left edge needs no clamp either, because the panel's own
`width: min(17rem, 100vw - …)` already guarantees it fits.

**Not a `<dialog>`.** A dialog is modal and a menu is not. Making this modal
would put a backdrop over a header the reader is still looking at, in order to
choose between four links.

**There is a fallback, which is a departure.** Everywhere else this app
reaches for something new — scroll-driven reading progress — the degradation
is to draw nothing, and that is right for a progress bar. It is wrong here,
because "nothing happens" would mean no sign out and no settings. So a browser
without `popover` gets the same panel moved to `<body>`, with our own Escape
and outside-`pointerdown`. It is the only branch in the file.

## What it costs

**Two events, and the reason is timing.** `beforetoggle` is synchronous and is
where the panel is placed; `toggle` is queued as a task and is where focus
moves into the menu, because the click that opened the panel focuses the
button it was aimed at and would undo an earlier focus call. That queue is
also why `onOpened` will not move focus if focus is already inside the panel —
somebody typing quickly can be two rows down before the task runs, and hauling
them back to the top reads as the keyboard being broken.

**The cluster is built once and kept.** `renderAccount` in `main.js` runs on
every store change, every shelf change and every notification poll, and it
used to rebuild the header wholesale. `replaceChildren` on an open popover
takes it out of the document, which closes it — so the menu would shut by
itself somewhere between one poll and the next. It is now rebuilt only when
the person changes, and everything else repaints in place.

**No scroll listener, on purpose.** The header is `position: sticky; top: 0`,
so the trigger does not move relative to the viewport while the page does. A
listener recomputing an unchanged rectangle every frame is the per-frame cost
this project keeps taking back out. Only `resize` is watched.

**`role="menu"` is a promise.** It means the arrow keys have to work, focus has
to rove, and the rows stop being announced as links. That is the right trade
for an account menu and it is more code than a list of links in a box would
have been.

## When to change our minds

- **If CSS anchor positioning reaches all three engines**, `place()` becomes a
  `position-area` and a `position-try` and this ADR's third row is deleted. The
  right-edge trick goes with it — the whole reason for it is measuring before
  paint, which CSS does not need to do.
- **If a second anchored layer is ever wanted**, the open/close/position/keys
  part of this file is the thing to lift out, not to copy. One menu does not
  justify an abstraction; two do.
- **If `popover` support is ever universal enough to stop caring**, delete the
  `HAS_POPOVER` branch and the `<body>` re-parenting with it. The rest of the
  file does not change.
