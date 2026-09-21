// @ts-check
// The account menu — the header's one door, and the app's first anchored layer.
//
// ── what it replaces, and why the header had to give ───────────────────────
// Signed in, the header rendered six controls: notifications, write, shelf,
// username, sign out, theme. The comment beside them in main.js already
// admitted they fought for space at 320px, and the narrow-screen rule in
// chrome.css is that fight written down — every label hidden, every button
// squeezed to a 44px square, and the theme toggle still the first thing to go
// over the edge. Six controls is not a header, it is a toolbar that has not
// been designed yet.
//
// Meanwhile `#/settings` had exactly one way in — a text link on your own
// profile — which is to say the screen was effectively unreachable.
//
// One change fixes both. The destinations go behind the avatar, the actions
// stay on the surface, and the header drops from six controls to three.
//
// ── what stays outside, and the rule that decides it ───────────────────────
// **A one-press action stays on the surface; a destination goes in the menu.**
//
//   outside   theme (one press), write (one press, and the whole point of a
//             writing app — burying it would be a joke)
//   inside    your posts, the shelf, notifications, settings, sign out
//
// Sign out is the one action inside, and it is inside because it is the one
// action nobody should be able to hit by accident on the way to somewhere else.
//
// ── the unread count, which the lamp used to carry ─────────────────────────
// The old lamp earned its badge with an argument worth keeping: a number in a
// corner of a header is a notification badge whatever you call it, the shelf
// is a bookshelf and gets none, and this is an inbox and gets one. Moving
// notifications into the menu would have quietly thrown that away — a count
// behind a closed door is not a count.
//
// So the signal survives and the number moves. The avatar takes a dot when
// something is waiting — present or absent, no digits, because the header only
// has to say *that* there is something; the menu row says how many, and so
// does the button's accessible name. Same neutrals as the lamp, for the same
// reason: the accent is spent on a vote, on warmth, and on where you are.
//
// ── the floating-layer decision, made on purpose ───────────────────────────
// components/reader.js chose inline expansion specifically to avoid
// positioning, a focus trap, an outside-click rule and a scroll listener, and
// wrote down that it was avoiding them. This is the case that cannot: a menu
// hanging off an avatar in a sticky header is anchored by definition, and
// expanding it inline would push the header's own height around on every open.
// So the cost gets paid, once, here, and the three decisions inside it are:
//
// **1. Native `popover`, not a hand-rolled layer.** It is the only one of the
// three that is not a judgement call. `.site-header` carries a
// `backdrop-filter`, and a non-`none` backdrop-filter makes an element a
// containing block for every fixed-position descendant — so a panel positioned
// `fixed` inside the header is positioned against the *header*, silently, and
// only above 640px where chrome.css keeps the filter on. A popover renders in
// the top layer, which no ancestor containing block or `z-index` reaches, and
// the bug cannot happen. Light dismiss and Escape come with it, from the
// browser, correct on the first try.
//
// **2. `popovertarget` on the button rather than `showPopover()` from a click
// handler.** This is the classic bug in every hand-rolled menu: pressing the
// trigger while the menu is open light-dismisses it on pointerdown and then
// the click handler opens it again, so the menu will not close. The invoker
// attribute is the browser doing that bookkeeping, and it also keeps the
// panel in the invoker's tab order even though it is drawn somewhere else.
//
// **3. Positioning in JavaScript, and *not* CSS anchor positioning.** Anchor
// positioning is the pretty answer and it is Chromium-only, which would mean
// an `@supports` branch and a JS path underneath it anyway — two behaviours,
// one of which nobody on this project can look at. chrome.css already makes
// exactly this call about `env(titlebar-area-*)`: "a branch for a mode the app
// cannot enter is a branch nobody can check." So there is one code path, it is
// twelve lines, it clamps to the viewport, and it is the same on every browser.
//
// Not a `<dialog>`, which was the other option on the table: a dialog is modal
// and a menu is not. Making this modal would put a backdrop over a header the
// reader is still looking at, to choose between four links.
//
// ── and the fallback, because of what is inside it ─────────────────────────
// `popover` has been in all three engines since 2024, and everywhere else the
// app reaches for something that new — scroll-driven reading progress — the
// fallback is to draw nothing. That is right for a progress bar and wrong
// here, because "nothing happens" would mean no sign out and no settings. So
// there is a small manual path: the same positioning, our own Escape and
// outside-pointerdown, and the panel moved to <body> where `fixed` is honest
// again. It is the only branch in the file and it is about fifteen lines.

import { h, icon } from "../dom.js";
import { avatar } from "../format.js";
import { signOut } from "../actions.js";
import { shelfCount } from "../shelf.js";
import { unreadCount } from "../notify.js";

const GAP = 8; // between the trigger's bottom edge and the panel
const EDGE = 8; // smallest gap the panel keeps from a viewport edge

// One branch, decided once at module load rather than per open.
const HAS_POPOVER =
  typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

// Ids, because `aria-labelledby` and `popovertarget` both need to name things
// and there is only ever one of these on the page.
const PANEL_ID = "account-menu";
const TRIGGER_ID = "account-menu-button";

/**
 * Right-aligned under the trigger, and never taller than the room below it.
 *
 * Top-layer coordinates are viewport coordinates, which is what makes this
 * short: the trigger's own rect is already in the same space, so there is
 * nothing to convert and no offset parent to walk.
 *
 * **It sets `right`, not `left`, and that is the whole trick.** Anchoring by
 * the left edge needs the panel's width, and a popover that has not been shown
 * yet is `display: none` and measures zero — so a width-based `place()` can
 * only run once the panel is already on screen, which is one frame too late.
 * It showed as a real flash: the panel painted at the wrong end of the header
 * and then jumped. Anchoring by the right edge asks the browser to do that
 * arithmetic instead, so this can run in `beforetoggle`, before the first
 * paint, and there is nothing to jump. The left edge needs no clamp either —
 * the panel's own `width: min(17rem, 100vw - …)` already guarantees it fits.
 *
 * **The right edge comes from the root element's own box, not from
 * `clientWidth`, and the two are not the same number here.** base.css sets
 * `overflow-y: scroll` *and* `scrollbar-gutter: stable` so the page never
 * jumps sideways when a screen changes height. Where the browser draws
 * overlay scrollbars, that gutter is reserved space that no scrollbar
 * occupies — `documentElement.clientWidth` reports the full viewport (it sees
 * no scrollbar to subtract) while the layout is eleven pixels narrower, and a
 * fixed `right` resolves against the narrower one. The panel landed eleven
 * pixels left of the avatar, on exactly the class of alignment bug this
 * function's right-edge anchoring exists to make impossible.
 *
 * `getBoundingClientRect().right` on the root is the layout width in both
 * worlds: with classic scrollbars it is the viewport minus the track, with
 * overlay scrollbars it is the viewport minus the reserved gutter. `* { margin: 0 }`
 * in base.css is what lets the root's border box stand in for the containing
 * block.
 *
 * The height still comes from `clientHeight`, and the asymmetry is deliberate:
 * the root's *height* is the document's, which is usually far taller than the
 * screen, while `clientHeight` on the root is the viewport. There is no
 * horizontal gutter to miss — `overflow-x` is hidden.
 *
 * No scroll listener. The header is `position: sticky; top: 0`, so the trigger
 * does not move relative to the viewport while the page does, and a listener
 * firing every frame to recompute a rectangle that has not changed is exactly
 * the per-frame cost this project keeps taking back out.
 *
 * @param {HTMLElement} trigger
 * @param {HTMLElement} panel
 */
function place(trigger, panel) {
  const doc = document.documentElement;
  const r = trigger.getBoundingClientRect();
  const top = r.bottom + GAP;
  const viewportRight = doc.getBoundingClientRect().right;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.left = "auto";
  panel.style.right = `${Math.round(Math.max(EDGE, viewportRight - r.right))}px`;
  // A floor, so a viewport too short for any of this leaves something to
  // scroll rather than a sliver.
  panel.style.maxHeight = `${Math.max(120, Math.round(doc.clientHeight - top - EDGE))}px`;
}

/** Every focusable row, in the order the arrow keys should walk them. */
const itemsOf = (panel) =>
  /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('[role="menuitem"]')]);

/**
 * The menu. Built once and kept: `renderAccount` in main.js runs on every
 * store change, every shelf change and every notification poll, and a rebuild
 * would tear an open panel out of the document under the reader's cursor — so
 * this exposes `paint` for the counts and never replaces its own nodes.
 *
 * @param {{username: string}} session
 */
export function accountMenu(session) {
  const name = session.username;

  const dot = h("span", { class: "accmenu__dot", hidden: true, "aria-hidden": "true" });

  const trigger = h(
    "button",
    {
      class: "accmenu__trigger",
      id: TRIGGER_ID,
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      "aria-controls": PANEL_ID,
    },
    avatar(name),
    dot,
    icon("chevron-down", 12)
  );

  // Your name, linking to your own posts — the same place anyone else's byline
  // goes, and the row the username in the old header cluster turned into. It
  // leads because it is the one row that says whose menu this is; the account
  // name used to be a 15ch ellipsis that vanished below 900px, and here it has
  // the width to just be read.
  const who = h(
    "a",
    {
      class: "accmenu__who",
      role: "menuitem",
      tabindex: "-1",
      href: `#/u/${encodeURIComponent(name)}`,
    },
    avatar(name, "lg"),
    h(
      "span",
      { class: "accmenu__who-text" },
      h("span", { class: "accmenu__name" }, name),
      h("span", { class: "accmenu__sub" }, "Everything you've written")
    )
  );

  /**
   * A destination. The count is a fact about where the row goes, which is the
   * same footing the shelf screen's own line puts it on — a number in a menu
   * is not the badge the header rule was about.
   * @param {string} href @param {string} glyph @param {string} label
   */
  const row = (href, glyph, label) => {
    const count = h("span", { class: "accmenu__count", hidden: true });
    const el = h(
      "a",
      { class: "accmenu__row", role: "menuitem", tabindex: "-1", href },
      icon(glyph),
      h("span", { class: "accmenu__label" }, label),
      count
    );
    return { el, count };
  };

  const shelf = row("#/shelf", "bookmark", "Your shelf");
  const notifications = row("#/notifications", "lamp", "Notifications");
  const settings = row("#/settings", "gear", "Settings");

  const out = h(
    "button",
    {
      class: "accmenu__row accmenu__row--out",
      role: "menuitem",
      tabindex: "-1",
      type: "button",
    },
    icon("sign-out"),
    h("span", { class: "accmenu__label" }, "Sign out")
  );
  out.addEventListener("click", signOut);

  const panel = h(
    "div",
    {
      class: "accmenu__panel",
      id: PANEL_ID,
      role: "menu",
      "aria-labelledby": TRIGGER_ID,
    },
    who,
    h("hr", { class: "accmenu__rule", role: "separator" }),
    shelf.el,
    notifications.el,
    settings.el,
    h("hr", { class: "accmenu__rule", role: "separator" }),
    out
  );

  if (HAS_POPOVER) {
    panel.setAttribute("popover", "auto");
    trigger.setAttribute("popovertarget", PANEL_ID);
  } else {
    panel.hidden = true;
  }

  const root = h("div", { class: "accmenu" }, trigger, panel);

  // — counts, and the name the button answers to ---------------------------
  // Called instead of a rebuild. Nothing here replaces a node, so an open
  // panel survives a notification arriving underneath it.
  function paint() {
    const unread = unreadCount();
    const saved = shelfCount();

    dot.hidden = !unread;
    trigger.classList.toggle("accmenu__trigger--dot", !!unread);

    // The whole state in one sentence, because with the count out of the
    // header this button is the only thing that can say it. A screen reader
    // gets "Your account, ada, three unread" rather than an avatar and a dot
    // it has no way to see.
    trigger.setAttribute(
      "aria-label",
      unread === 0
        ? `Your account, ${name}`
        : unread === 1
          ? `Your account, ${name}, one unread`
          : `Your account, ${name}, ${unread} unread`
    );
    trigger.title = "Your account";

    // aria-hidden on the numbers: the row's own name already says it in words,
    // so the count is for the eye and the label is for everything else.
    const setCount = (slot, n, one, many) => {
      slot.hidden = !n;
      slot.textContent = n > 99 ? "99+" : String(n);
      slot.setAttribute("aria-hidden", "true");
      return n === 0 ? null : n === 1 ? one : many.replace("%", String(n));
    };

    const shelfSays = setCount(shelf.count, saved, "one post saved", "% posts saved");
    shelf.el.setAttribute(
      "aria-label",
      shelfSays ? `Your shelf, ${shelfSays}` : "Your shelf, empty"
    );
    const unreadSays = setCount(notifications.count, unread, "one unread", "% unread");
    notifications.el.setAttribute(
      "aria-label",
      unreadSays ? `Notifications, ${unreadSays}` : "Notifications"
    );
    notifications.el.classList.toggle("accmenu__row--lit", !!unread);
  }

  // — opening, closing, and where focus goes -------------------------------
  const isOpen = () => (HAS_POPOVER ? panel.matches(":popover-open") : !panel.hidden);

  function open() {
    if (isOpen()) return;
    if (HAS_POPOVER) panel.showPopover();
    else {
      // `fixed` inside the header is measured against the header itself once a
      // backdrop-filter is on it, so in this path the panel leaves the header.
      document.body.append(panel);
      panel.hidden = false;
      place(trigger, panel);
      trigger.setAttribute("aria-expanded", "true");
      addEventListener("keydown", onEscape, true);
      addEventListener("pointerdown", onOutside, true);
      // The popover path gets here from the two toggle events, which are the
      // browser telling us what it did. Nothing is going to tell us here.
      onOpened();
    }
  }

  function close({ refocus = false } = {}) {
    if (!isOpen()) return;
    if (HAS_POPOVER) panel.hidePopover();
    else {
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      removeEventListener("keydown", onEscape, true);
      removeEventListener("pointerdown", onOutside, true);
      onClosed();
    }
    // Only when the keyboard closed it. A pointer that dismissed the menu by
    // pressing something else should leave focus where the pointer went, and
    // yanking it back to the avatar is how a menu steals a click.
    if (refocus) trigger.focus();
  }

  function onEscape(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    close({ refocus: true });
  }

  function onOutside(e) {
    if (!root.contains(e.target) && !panel.contains(e.target)) close();
  }

  function onOpened() {
    // The first row, for pointer and keyboard alike. Focusing on a mouse open
    // costs nothing — :focus-visible keeps the ring off — and it means the
    // arrow keys work without a Tab first, which is the thing people try.
    //
    // Unless focus is already in here, and that guard is not defensive
    // programming. This runs from the queued `toggle` task, so somebody typing
    // quickly — End, or a second ArrowDown — can have moved down the menu
    // before it arrives. Without the check this would haul them back to the
    // top a frame after they left it, which is the kind of bug that reads as
    // the keyboard being broken.
    if (!panel.contains(document.activeElement)) itemsOf(panel)[0]?.focus();
    addEventListener("resize", reposition);
  }

  function onClosed() {
    removeEventListener("resize", reposition);
  }

  const reposition = () => {
    if (isOpen()) place(trigger, panel);
  };

  if (HAS_POPOVER) {
    // Two events, because they happen at different times and two different
    // things need each one.
    //
    // `beforetoggle` is dispatched synchronously, before the panel is shown —
    // which is the only moment that can place it without a visible jump. It
    // takes `aria-expanded` with it so the attribute is never a frame behind
    // the thing it describes.
    panel.addEventListener("beforetoggle", (e) => {
      const ev = /** @type {ToggleEvent} */ (e);
      const opening = ev.newState === "open";
      if (opening) place(trigger, panel);
      trigger.setAttribute("aria-expanded", String(opening));
    });
    // `toggle` is queued as a task, so it runs after the click that opened the
    // panel has finished — including the step that focuses the button it was
    // aimed at. Moving focus into the menu has to happen after that or it is
    // immediately undone, which is why it is here and not above.
    panel.addEventListener("toggle", (e) => {
      const ev = /** @type {ToggleEvent} */ (e);
      if (ev.newState === "open") onOpened();
      else onClosed();
    });
  }

  // — the keyboard ---------------------------------------------------------
  // role="menu" is a promise about the arrow keys, so it gets kept. Roving
  // tabindex: every row is -1 and focus is moved by hand, which is the pattern
  // menus are specified in and the reason Tab leaves rather than walks.
  //
  // On the root rather than on the panel, because while the menu is open focus
  // can legitimately be in either half of it. `toggle` is queued rather than
  // dispatched synchronously, so between the press that opens the panel and
  // the task that moves focus into it there is a real window — short, but long
  // enough for somebody's second keystroke — where the menu is open and focus
  // is still on the trigger. A handler bound to the panel alone does not hear
  // that keystroke, and the arrow key does nothing. This one does.
  root.addEventListener("keydown", (e) => {
    const items = itemsOf(panel);
    // -1 while focus is still on the trigger, which is why the two arrows are
    // asked for separately below rather than derived from one index.
    const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));

    if (!isOpen()) {
      // Closed, the only keys that mean anything are the ones that open it.
      // Enter and Space are the button's own and are left alone.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        open();
      }
      return;
    }

    const step = (d) => {
      e.preventDefault();
      const next =
        at === -1
          ? d > 0
            ? 0
            : items.length - 1
          : (at + d + items.length) % items.length;
      items[next]?.focus();
    };
    const go = (i) => {
      e.preventDefault();
      items[i]?.focus();
    };

    if (e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") {
      // Only reached in the popover path if something swallows the browser's
      // own handling; harmless twice, and the fallback path needs it.
      e.preventDefault();
      close({ refocus: true });
    } else if (e.key === "Tab") {
      // A menu is not a dialog and does not trap. What the APG asks for is
      // that Tab close the menu and move focus to the next element *after the
      // button* — so focus goes back to the trigger here and the keypress is
      // deliberately not cancelled, letting the browser's own tab order carry
      // on from there. Somebody who opened the menu by accident presses one
      // key and is back in the page where they left it.
      close();
      trigger.focus();
    }
  });

  // Enter on a link inside an open popover navigates, and light dismiss does
  // not fire for a press *inside* the panel — so choosing a row has to close
  // it. Including when the row is where you already are, where the hash never
  // changes and there is no navigation to ride along with.
  panel.addEventListener("click", (e) => {
    if (/** @type {Element} */ (e.target).closest('[role="menuitem"]')) close();
  });

  // Without `popovertarget` there is nothing doing the toggle bookkeeping.
  // The arrow keys are handled on the root above, for both paths.
  if (!HAS_POPOVER) {
    trigger.addEventListener("click", () => (isOpen() ? close() : open()));
  }

  paint();
  return { root, paint, close, isOpen };
}
