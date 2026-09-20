// @ts-check
// Putting a screen on the page, and remembering where the last one was.
//
// The router calls this and the views call this; nothing else should. It is
// separate from dom.js because it is about the *document* — one #view element,
// one scroll position, one transition at a time — rather than about elements
// in general.

import { tryTransition } from "./transitions.js";

// — where you were when you left ------------------------------------------------
/**
 * The scroll position to put a list back to.
 *
 * Not `window.scrollY` read at teardown, which is what this replaced and what
 * was quietly wrong. A list tears down on `hashchange`, and by then the page
 * has already moved: activating a card focuses its link, and a focused element
 * that the sticky header would overlap gets scrolled into view by the browser
 * before anything of ours runs. Measured on the feed, leaving from 900px
 * cached 498 — so coming back landed four hundred pixels above where the
 * reader had actually been, every time, on every list.
 *
 * So the position is taken at the last moment it is still the reader's: the
 * press that starts the navigation. Every pointerdown and keydown stamps one,
 * in the capture phase so it lands before any handler can scroll, and the
 * stamp is only trusted for a second afterwards. A navigation nobody pressed
 * for — a hash typed into the bar, a restored session — has no press to read,
 * and falls back to asking the window, which for that case is right.
 */
let pressed = { y: 0, at: 0 };
const stamp = () => {
  pressed = { y: window.scrollY, at: Date.now() };
};
addEventListener("pointerdown", stamp, true);
addEventListener("keydown", stamp, true);

const PRESS_WINDOW = 1000;

export function leavingScrollY() {
  return Date.now() - pressed.at < PRESS_WINDOW ? pressed.y : window.scrollY;
}

// — view mounting ---------------------------------------------------------------
// #view is in index.html and the whole router depends on it; a call site that
// checked for null would be pretending otherwise.
const viewEl = () => /** @type {HTMLElement} */ (document.getElementById("view"));

/**
 * @param {Element | DocumentFragment} node
 * @param {{ restoreScroll?: number, focus?: HTMLElement, transition?: boolean | "none" }} [options]
 *   `focus` is where the cursor should land — a form's first field, say.
 *   Defaults to #view, which is what a reading screen wants.
 *
 *   `transition` has three answers, because there are three things a swap can
 *   be.
 *
 *   `true` — a journey. This screen became that one, and the view transition
 *   is the sentence saying so.
 *
 *   `false` — not a journey, but still an arrival. A loading state is not a
 *   screen, it's the absence of one: animating into a skeleton says something
 *   untrue, costs the app 160ms of not taking input, and then has to be
 *   animated out of again the moment the real thing lands. Callers putting up
 *   a placeholder pass this and get the quiet cross-fade instead.
 *
 *   `"none"` — not an arrival at all. The same screen, still here, showing a
 *   different answer: the feed re-ordered from Newest to Warmest, or a search
 *   narrowing as it is typed. Nothing has travelled and nothing has arrived,
 *   so nothing should move — the page-level fade-and-rise is a sentence about
 *   a journey, and applied to a list changing under a control the reader is
 *   still pointing at, it reads as the whole page having been reloaded. That
 *   is the entire complaint it exists to answer. See views/feed.js.
 */
export function mountView(node, { restoreScroll, focus, transition = true } = {}) {
  const view = viewEl();

  const swap = () => {
    view.replaceChildren(node);

    // The chrome belongs to the screen, so it changes when the screen does.
    //
    // It used to change on `hashchange`, which fires the moment the link is
    // followed — a good hundred and fifty milliseconds before the screen it
    // belongs to has finished loading. So tapping a card on a phone collapsed
    // the header's search row instantly, the *feed* jumped forty pixels up the
    // page, and it sat there like that until the post arrived. Going back did
    // the same in reverse. That flash of a screen wearing the next screen's
    // chrome is the "something else in between" you can see in the recording,
    // and no amount of transition polish could cover it, because it happened
    // before the transition started.
    //
    // Dispatched inside the swap, so it is captured by the same view
    // transition as the content: the header now folds *with* the page instead
    // of ahead of it. See syncChrome in main.js.
    dispatchEvent(new CustomEvent("commons:screen"));

    if (typeof restoreScroll === "number") window.scrollTo(0, restoreScroll);
    else window.scrollTo(0, 0);

    // Focus belongs *inside* the swap, not after the call to it. With a view
    // transition, startViewTransition() runs this callback asynchronously —
    // so a caller doing `mountView(form); field.focus();` was focusing an
    // element that wasn't in the document yet, which is a silent no-op. The
    // compose and sign-in screens both looked like they autofocused and
    // hadn't since view transitions landed.
    //
    // Not while someone is typing in the header search, which drives feed
    // re-renders on every keystroke.
    if (document.activeElement !== document.getElementById("search-input")) {
      (focus || view).focus({ preventScroll: true });
    }
  };

  // Not on the very first paint. There's nothing on screen to travel from, so
  // the transition would have nothing to say — and while one runs the document
  // is covered by its snapshot and doesn't take clicks, which is a strange
  // couple of hundred milliseconds to hand someone who has only just arrived.
  const replacingAView = view.childElementCount > 0;

  // A transition and the cross-fade at the same time reads as a stutter, so
  // exactly one of them runs — or, for `"none"`, neither.
  if (transition === "none") {
    swap();
  } else if (!(transition && replacingAView && tryTransition(swap, node))) {
    swap();
    const el = /** @type {Element} */ (node);
    el.classList.add("route-enter");
    el.addEventListener("animationend", () => el.classList.remove("route-enter"), {
      once: true,
    });
  }
}
