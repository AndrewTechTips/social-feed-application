// @ts-check
// j / k / Enter / u over the feed.
//
// Borrowed whole from Hacker News, Reddit and Superhuman. A linear list of
// items is the exact shape this convention was invented for, so there is
// nothing here to invent and nothing to teach — the palette advertises it once
// (the "Move through the feed" row) and otherwise it stays out of the way.
//
// The cursor is real DOM focus, not a `.selected` class, and that one decision
// buys most of the behaviour for free: Enter already opens a focused link, the
// focus ring already draws, a screen reader already follows, and there is no
// second idea of "where you are" to keep in step with the browser's. It also
// means pagination, the feed cache and the profile view need no bookkeeping
// whatsoever — the cards are read out of the DOM at the moment a key lands.
//
// Which is also why Enter has no handler below. Adding one would be writing a
// worse version of something the browser already does.

// The profile view draws the same list from the same cards, so it gets the
// same keys; skeletons are excluded because there is nothing to open yet.
const CARDS = ".feed__list .card:not(.card--skeleton)";

const cards = () =>
  /** @type {HTMLElement[]} */ ([...document.querySelectorAll(CARDS)]);

/** Is there a list to move through on this screen? */
export const hasCards = () => cards().length > 0;

// Inputs you cannot type a letter into. The first version of this guard asked
// only whether the target was an <input>, which was right for every input the
// app had at the time and wrong the moment the reading panel arrived: its text
// size is a radio group, so touching it quietly switched off every single-key
// shortcut until focus moved somewhere else. `f` stopped working immediately
// after the panel that advertises it.
//
// A radio, a checkbox or a button has no letters to steal — the keys that
// operate them are arrows and space — so they are not typing, and the shortcuts
// stay live over them.
const NOT_TYPING = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
  "range",
  "color",
  "image",
]);

/**
 * Don't steal a letter someone is typing. palette.js needs the same guard for
 * the same reason and imports this one — and it doubles as the "is the palette
 * open?" check, because when it is, focus is in its own text field.
 * @param {EventTarget | null} target
 */
export function typing(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === "TEXTAREA") return true;
  if (target.tagName === "INPUT") {
    return !NOT_TYPING.has(/** @type {HTMLInputElement} */ (target).type);
  }
  return false;
}

/** Where the cursor is now: the index of the card holding focus, or -1. */
function cursorIn(list) {
  const el = document.activeElement;
  const card = el instanceof Element ? el.closest(".card") : null;
  return card ? list.indexOf(/** @type {HTMLElement} */ (card)) : -1;
}

// Nothing focused yet — start from the first card the header isn't already
// covering, so pressing j after a long scroll picks up where the eye is rather
// than throwing you back to the top of the list.
function firstInView(list) {
  const header = document.querySelector(".site-header");
  const top = header ? header.getBoundingClientRect().bottom : 0;
  const i = list.findIndex((card) => card.getBoundingClientRect().bottom > top + 1);
  return i === -1 ? list.length - 1 : i;
}

function put(card) {
  const link = /** @type {HTMLElement | null} */ (card.querySelector(".card__link"));
  if (!link) return;
  // preventScroll, then scroll deliberately: `nearest` moves the page as
  // little as it can, and .card's scroll-margin-top keeps the card clear of
  // the sticky header. Together that's a list that steps rather than jumps.
  link.focus({ preventScroll: true });
  card.scrollIntoView({ block: "nearest" });
}

/**
 * Move the cursor by `step`. It stops at both ends rather than wrapping: a
 * list you can fall off the bottom of and reappear at the top of is a list you
 * have to watch instead of read.
 * @param {number} step
 */
function move(step) {
  const list = cards();
  if (!list.length) return;
  const at = cursorIn(list);
  const next =
    at === -1 ? firstInView(list) : Math.min(Math.max(at + step, 0), list.length - 1);
  put(list[next]);
}

/** Put the cursor on the list without moving it — what the palette row runs. */
export const focusCursor = () => move(0);

// u upvotes whatever the cursor is on, by pressing the button that's already
// there. Everything the vote control does — the optimistic count, the pulse,
// the sign-in prompt, the rollback — happens exactly as if it had been
// clicked, because it was.
function upvote() {
  const el = document.activeElement;
  const card = el instanceof Element ? el.closest(".card") : null;
  const btn = /** @type {HTMLElement | null} */ (card && card.querySelector(".vote"));
  if (btn) btn.click();
}

// — the same two keys, one screen further in ----------------------------------
//
// A post page has no list to move a cursor through, but it ends with two links
// into the list the reader arrived from — so j and k go on meaning the one
// thing they have meant all along: a step further down that list, or a step
// back up it. On the feed that moves a cursor; here it moves the reader. Same
// list, same direction, same key.
//
// Read out of the DOM at the moment the key lands, exactly as the cards are.
// The post screen draws the links or doesn't, and this needs to be told
// nothing.
/** @param {"next" | "prev"} dir */
const onwardLink = (dir) =>
  /** @type {HTMLElement | null} */ (document.querySelector(`.onward__item--${dir}`));

/** Is there somewhere to read on to? What the palette asks before offering it. */
export const hasOnward = () => !!(onwardLink("next") || onwardLink("prev"));

/**
 * Follow one of them. Returns false if that direction is the end of the list,
 * which is what lets the palette row settle for the other one.
 * @param {"next" | "prev"} dir
 */
export function readOn(dir) {
  const link = onwardLink(dir);
  if (link) link.click();
  return !!link;
}

export function wireFeedKeys() {
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (typing(e.target)) return;

    const key = e.key.toLowerCase();
    if (key !== "j" && key !== "k" && key !== "u") return;

    // A list on screen takes them first.
    if (hasCards()) {
      e.preventDefault();
      if (key === "u") upvote();
      else move(key === "j" ? 1 : -1);
      return;
    }

    // u has nothing to act on without a cursor, and j/k only move if there is
    // somewhere to go — pressing j at the end of the list does nothing rather
    // than doubling back, which would be a keystroke that means one thing in
    // the middle of a list and the opposite at the end of it. Otherwise the
    // letters belong to the page.
    if (key === "u") return;
    if (readOn(key === "j" ? "next" : "prev")) e.preventDefault();
  });
}
