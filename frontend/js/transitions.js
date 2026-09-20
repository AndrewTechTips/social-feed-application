// @ts-check
// The one orchestrated movement in the app: the title you tapped becomes the
// title of the screen you land on.
//
// Borrowed from iOS navigation and Things 3 — a push transition tells you where
// you came from, so the back gesture is never a surprise. Arc does the same
// thing when a tab becomes a window. What all three have in common is that the
// motion is an *answer to an action*, not decoration playing on arrival. That's
// the line this app draws: this and the vote pop are the only things that move
// on purpose.
//
// Built on the View Transitions API. Where it isn't supported the app falls
// straight through to the cross-fade it always had, which is why there's no
// polyfill here and no library.

const MORPH = "post-title";

export const supported = () => typeof document.startViewTransition === "function";

// The View Transitions API does *not* consult prefers-reduced-motion — the
// user-agent's own cross-fade runs regardless, and base.css's blanket
// animation-duration override can't reach ::view-transition-* pseudo-elements.
// So the check has to happen here, before the transition starts.
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export const canMorph = () => supported() && !reducedMotion();

// Which post the next feed render should hand the morph to, so that going back
// reverses the journey rather than just fading. Set when a post screen mounts,
// claimed once, then forgotten — a stale id would name an element with nothing
// to morph from.
let returningFrom = null;

export function morphingBackTo(id) {
  returningFrom = String(id);
}

export function claimReturn(id) {
  if (returningFrom === null || returningFrom !== String(id)) return false;
  returningFrom = null;
  return true;
}

export function forgetReturn() {
  returningFrom = null;
}

// Only ever one element at a time may carry a given view-transition-name — two
// would make the name ambiguous and the browser drops the whole transition. So
// the name goes on at the moment of the action and comes off as soon as the
// snapshot has been taken.
//
// The class rides along because the name itself can't be looked up. An inline
// style is not selectable in any honest way, and pairOrStrip() below has to be
// able to ask "is either end of this morph here?" — of the live document, and
// of a screen that has been built but not mounted yet.
const MORPH_CLASS = "is-morphing";
const MORPH_SEL = "." + MORPH_CLASS;

// A second class for the one element that keeps its name after the transition
// is over, rather than being stripped with the rest. See `hold` below.
const HELD_CLASS = "is-morphing--held";

/**
 * @param {Element | null | undefined} el
 * @param {{ hold?: boolean }} [options]
 *   `hold` keeps the name on after the transition finishes, for an element
 *   that is going to be the *leaving* end of the next one.
 *
 *   The post's heading is the only such element. Strip it on arrival, as
 *   everything else is stripped, and the journey back has no old snapshot to
 *   travel from: the card claims the name on the feed side, finds nothing
 *   opposite it, and pops into place instead of being travelled to. Which is
 *   the same half-a-morph glitch as the one going the other way, and it was
 *   there from the day the reverse was written. Holding the name for as long
 *   as the post is on screen is what makes "going back reverses the journey"
 *   true rather than aspirational — and it costs no invariant, because while
 *   that post is up it is the only thing in the document wearing the name.
 */
export function nameForMorph(el, { hold = false } = {}) {
  if (!el || !canMorph()) return;
  /** @type {HTMLElement} */ (el).style.viewTransitionName = MORPH;
  el.classList.add(MORPH_CLASS);
  el.classList.toggle(HELD_CLASS, hold);
}

/** @param {Element | null | undefined} el */
export function clearMorph(el) {
  if (!el) return;
  /** @type {HTMLElement} */ (el).style.viewTransitionName = "";
  el.classList.remove(MORPH_CLASS, HELD_CLASS);
}

/**
 * Is there a morph waiting to happen — did the reader get here by tapping a
 * title, rather than by submitting a form, following the palette, or pasting a
 * link?
 *
 * The answer decides whether a screen that has to fetch before it can draw is
 * allowed to leave the previous one up while it waits. See views/post.js.
 */
export const morphPending = () => !!document.querySelector(MORPH_SEL);

/** Every element on either side of the swap that is wearing the morph name. */
function endsOf(incoming) {
  const leaving = [...document.querySelectorAll(MORPH_SEL)];
  const arriving = incoming
    ? [
        ...(incoming.matches?.(MORPH_SEL) ? [incoming] : []),
        ...(incoming.querySelectorAll?.(MORPH_SEL) ?? []),
      ]
    : [];
  return { leaving, arriving };
}

/**
 * Give the morph both of its ends, or take the name off it entirely.
 *
 * A view-transition-name present on only one side of a swap doesn't cancel the
 * morph — it makes half of one, and half of one looks broken. The browser has
 * a snapshot with nothing to travel to, so it holds it where it is for the
 * group's whole duration and then cuts it. Worse, base.css deliberately holds
 * ::view-transition-old/new(post-title) at full opacity — a cross-fade between
 * two sizes of the same words just blurs them — so the lone snapshot doesn't
 * even fade on the way out.
 *
 * Tap a card and land on a loading screen and that is exactly what you get:
 * the title you just tapped, opaque, pinned over the skeleton for 240ms, then
 * gone in one frame. It reads as the page flinching. The cure upstream is not
 * to navigate into a loading screen at all (see views/post.js), but the
 * invariant belongs here, where the name is handed out: either both screens
 * carry it or neither does, and the plain root cross-fade carries the rest.
 */
function pairOrStrip(incoming) {
  const { leaving, arriving } = endsOf(incoming);
  // One each way, or it isn't a journey. Two on a side is an ambiguous name,
  // which the browser drops without a word — better to drop it deliberately.
  if (leaving.length === 1 && arriving.length === 1) return;
  [...leaving, ...arriving].forEach(clearMorph);
}

// How many transitions are in flight. Navigating again before one finishes is
// normal, and the flag below has to survive the overlap: a single boolean would
// be cleared by the first one's `finished` while the second was still running,
// and the scrollbar would flicker back into a page that is still moving.
let running = 0;

// The scrollbar is real browser chrome. It is not captured by the transition
// and it does not animate, so while the page is held still by its snapshots the
// thumb jumps — to the top, because the swap scrolls there, and to a new size,
// because the new screen is a different height. Two hundred milliseconds of the
// content standing still and the scrollbar bolting is what reads as the page
// twitching. Hidden for the length of the transition and back at the far end,
// already the right size, it reads as the page simply having changed.
//
// Costs no reflow: html reserves the gutter with `overflow-y: scroll`, so the
// track stays exactly as wide whether or not the thumb is painted in it. See
// the scrollbar block in base.css.
const TRANSITION_CLASS = "is-transitioning";

function transitionStarted() {
  running += 1;
  document.documentElement.classList.add(TRANSITION_CLASS);
}

function transitionEnded() {
  running = Math.max(0, running - 1);
  if (running === 0) document.documentElement.classList.remove(TRANSITION_CLASS);
}

/**
 * Cross-fade the whole page over a change that isn't a navigation.
 *
 * The room changing light rather than the reader changing room, which is a
 * different movement and needs a different one: `tryTransition` above is tuned
 * for going somewhere — the outgoing screen holds still, the incoming one
 * rises four pixels — and applied to a theme flip that rise reads as the page
 * being replaced by a copy of itself. So this marks the document for the
 * duration and base.css swaps in a symmetric fade with no travel.
 *
 * The flag goes on *before* the transition is asked for, which is what lets
 * base.css do the rest of the work: styles set now are the ones captured in the
 * old snapshot, so a rule keyed off it can also take the name off the header
 * and fold the chrome back into the page for the duration.
 *
 * Returns true if it took the swap. False means it did nothing and the caller
 * still has to apply the change itself — same contract as tryTransition, for
 * the same reason.
 *
 * @param {() => void} swap
 */
export function crossFade(swap) {
  if (!canMorph()) return false;

  const root = document.documentElement;
  root.dataset.themeShift = "";
  transitionStarted();
  const transition = document.startViewTransition(swap);

  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
  transition.finished
    .catch(() => {})
    .then(() => {
      transitionEnded();
      delete root.dataset.themeShift;
    });
  return true;
}

/**
 * Run a DOM swap inside a view transition, if one is possible and wanted.
 *
 * Returns true if it took the swap — false means it did nothing at all and the
 * caller still owns it. Deliberately does *not* fall back to swapping itself:
 * the caller has a cross-fade to add in that case, and one function that
 * sometimes swaps and sometimes doesn't is how you end up swapping twice.
 *
 * `incoming` is the screen about to be mounted, passed in so the morph can be
 * checked for both of its ends before the browser is committed to it.
 */
export function tryTransition(swap, incoming) {
  if (!canMorph()) return false;

  pairOrStrip(incoming);

  transitionStarted();
  const transition = document.startViewTransition(swap);

  // Navigating again before a transition finishes is normal — a quick tap on
  // Back while the first one is still running — and the API rejects `ready`
  // and `finished` with "Transition was skipped" when that happens. Nothing has
  // gone wrong, but an unhandled rejection is still an unhandled rejection, so
  // each promise gets a silencer.
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});

  // Whatever happens, don't leave a name behind on a live element: two elements
  // carrying the same one would make the *next* transition ambiguous, and the
  // browser drops ambiguous transitions entirely.
  transition.finished
    .catch(() => {})
    .then(() => {
      transitionEnded();
      document
        .querySelectorAll(`${MORPH_SEL}, [style*="view-transition-name"]`)
        .forEach((el) => {
          // Everything but the held one, which is the far end of the journey
          // back and has to still be wearing the name when it's asked for.
          if (!el.classList.contains(HELD_CLASS)) clearMorph(el);
        });
    });
  return true;
}
