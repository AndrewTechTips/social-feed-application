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
const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

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
export function nameForMorph(el) {
  if (!el || !canMorph()) return;
  el.style.viewTransitionName = MORPH;
}

export function clearMorph(el) {
  if (el) el.style.viewTransitionName = "";
}

/**
 * Run a DOM swap inside a view transition, if one is possible and wanted.
 *
 * Returns true if it took the swap — false means it did nothing at all and the
 * caller still owns it. Deliberately does *not* fall back to swapping itself:
 * the caller has a cross-fade to add in that case, and one function that
 * sometimes swaps and sometimes doesn't is how you end up swapping twice.
 */
export function tryTransition(swap) {
  if (!canMorph()) return false;

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
      document
        .querySelectorAll('[style*="view-transition-name"]')
        .forEach(clearMorph);
    });
  return true;
}
