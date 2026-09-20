// @ts-check
// The handful of things the app can do from more than one place.
//
// The header has always owned the theme toggle and the sign-out button. The
// command palette does both too, and a palette whose "Toggle theme" drifts
// away from the button next to it is worse than no palette. So the behaviour
// lives here and both call it.

import { api, forgetPendingRefresh } from "./api.js";
import { clearSession, dropFeedCache } from "./store.js";
import { toast } from "./toast.js";
import { navigate } from "./router.js";
import { crossFade } from "./transitions.js";

// Exported so js/browserdata.js can name it on the screen that lists what
// this browser is holding, rather than keeping a second copy of the string.
export const THEME_KEY = "commons.theme";

export function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function otherTheme() {
  return currentTheme() === "dark" ? "light" : "dark";
}

/**
 * Paint the browser's own chrome to match the theme: the title bar of an
 * installed window, and the address bar on Android Chrome.
 *
 * index.html ships two `<meta name="theme-color">` keyed to
 * `prefers-color-scheme`, which is the right answer for the moment before any
 * of this has run. It stops being the right answer as soon as it does: the
 * theme here is the reader's own choice, kept in localStorage, and it is
 * allowed to disagree with what the operating system thinks. An installed
 * window in light mode on a dark desktop had a dark title bar.
 *
 * Every one of them is set, to the same value, rather than working out which
 * the browser will use. The rule is "the first whose media matches", and a
 * wrong guess about that is invisible — so this makes the question not worth
 * asking. The colour is read from --bg rather than typed here, so the title
 * bar cannot drift from the page under it.
 */
export function syncThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (!bg) return;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", bg);
  }
}

// — the theme, in three states ------------------------------------------------
//
// ── the gap this closes ───────────────────────────────────────────────────
// The bootstrap in index.html reads `commons.theme` and falls back to
// `prefers-color-scheme` when it is absent, so a reader who has never touched
// the toggle follows their machine. The moment they press it once, a concrete
// value is written — and there was no way back. Not a preference anybody had
// thought about; just a door that only opened outward. A laptop that goes
// dark at sunset stopped taking Commons with it, for ever, because of one
// press months earlier.
//
// ── how "system" is stored, which is: it isn't ────────────────────────────
// **Following the system is the absence of the key, not the string
// "system".** The plan this comes from asked for the string, and the reason
// to do otherwise arrived after it was written: `#/settings` now lists every
// key this browser holds, with its size, and a control that removes it. Two
// encodings of one state — no key, and a key reading "system" — would mean
// that panel showing "6 bytes" for a reader whose position is *I have no
// preference*, and the panel's Reset landing somewhere subtly different from
// the radio marked System. One representation keeps both honest.
//
// It also leaves the pre-paint bootstrap alone, which is worth something on
// its own: that inline script is the only code in the app that has to run
// before the first frame, and `data-theme="system"` matches no rule in
// tokens.css.
const CHOICES = ["system", "light", "dark"];

/** What the machine is asking for, right now. */
const systemTheme = () =>
  matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

/**
 * Which of the three the reader has asked for — not what is on screen.
 *
 * `currentTheme()` answers "what is painted"; this answers "what was chosen",
 * and under `system` those are different questions with different answers.
 * @returns {"system" | "light" | "dark"}
 */
export function themeChoice() {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch (e) {
    // Storage disabled: nothing can be pinned, so the system is all there is.
    return "system";
  }
}

/** The three, in the order they should be offered. */
export const themeChoices = () => CHOICES.slice();

/**
 * Paint a theme and tell everything that draws itself from one.
 *
 * `fade` is not decoration. Every colour in the app is a custom property, so
 * the flip is one attribute and the repaint is instantaneous — which is
 * exactly the problem. A room does not snap from lamplight to daylight, and
 * the snap is most of why a theme toggle feels like a setting rather than
 * like a light switch. Inside a view transition the browser cross-fades the
 * two paintings of the page for a fifth of a second and it reads as the
 * lights coming up.
 *
 * crossFade answers false where the API is missing or the reader has asked
 * for less motion, and then the flip still has to happen — unwrapped, which
 * is what it always was.
 *
 * @param {string} theme "light" or "dark" — a painted value, never "system"
 * @param {{fade?: boolean}} [opts]
 */
function paintTheme(theme, { fade = true } = {}) {
  const apply = () => {
    document.documentElement.dataset.theme = theme;
    // The header's toggle draws itself from this, the palette can change it
    // from the other side of the app, and the settings radios and the data
    // panel both listen. Announce it rather than letting them go stale.
    dispatchEvent(new CustomEvent("commons:theme", { detail: theme }));
    syncThemeColor();
  };
  if (!fade || !crossFade(apply)) apply();
  return theme;
}

/**
 * Choose one of the three.
 *
 * @param {string} next
 * @param {{fade?: boolean}} [opts]
 * @returns {string} the theme now painted, which for "system" is whichever
 *   one the machine is currently asking for
 */
export function setThemeChoice(next, opts) {
  const choice = CHOICES.includes(next) ? next : "system";
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch (e) {
    /* storage disabled — the choice holds for this page and no longer */
  }
  return paintTheme(choice === "system" ? systemTheme() : choice, opts);
}

/**
 * Stop having a theme of your own, and go back to following the system.
 *
 * The same thing as choosing System, reached from the data panel on
 * `#/settings` rather than from the radios — which is why it is a named
 * function and not a call site: it is offered there as *forgetting a stored
 * preference*, which is what removing the key literally is.
 *
 * No cross-fade, and that is the only difference. It sits in a list of things
 * being forgotten, beside three others that take effect instantly, and a
 * theme that dissolved while the rest snapped would read as the reset having
 * been half-applied.
 */
export const forgetTheme = () => setThemeChoice("system", { fade: false });

/**
 * The header's fast path: light ↔ dark, one press.
 *
 * It writes a concrete value, so pressing it while on `system` is what moves
 * you off it — which is the behaviour the plan asked for and which falls out
 * of this rather than needing a branch. There is no third press that would
 * get you back; System is a destination on the settings screen, because a
 * two-state control cannot honestly offer three.
 */
export function toggleTheme() {
  return setThemeChoice(otherTheme());
}

// — following the machine, while that is what was asked for --------------------
//
// Without this, "System" meant "whatever the system was saying when this tab
// loaded". A laptop going dark at sunset would leave every open Commons tab
// light until it was reloaded, which is the failure the setting exists to
// prevent, reintroduced one layer down.
//
// Guarded on the choice rather than unregistered and re-registered: the test
// is one storage read, it runs only when the machine's own setting changes,
// and a listener that is always attached cannot be attached twice.
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (themeChoice() !== "system") return;
  paintTheme(systemTheme());
});

export function signOut() {
  // Locally first, and without waiting. Signing out is the one action that has
  // to look like it worked immediately — a spinner between "Sign out" and
  // being signed out is the app asking permission from a server to let you
  // leave — and the screen is redrawn from the store, not from the response.
  //
  // The call still matters: clearing our own state ends the session in this
  // tab, and revoking it server-side ends the session. Without the request, a
  // copy of the refresh cookie taken from this machine would stay good for a
  // fortnight.
  forgetPendingRefresh();
  const goodbye = api.logout();
  clearSession();
  dropFeedCache();
  // There is no upvote mirror left to clear. It used to be a set of post ids
  // in this browser, and signing out had to wipe it or the next person to sign
  // in here saw filled carets on posts they never touched. The answer comes
  // from the API now, per reader, so signing out is enough on its own —
  // dropFeedCache() above already throws away the page it was drawn on.
  toast("Signed out.");
  navigate("/");
  // Nothing to say if it fails. The person is signed out here either way, and
  // an error about a request they never made would be noise — but an unhandled
  // rejection is still an unhandled rejection.
  goodbye.catch(() => {});
}
