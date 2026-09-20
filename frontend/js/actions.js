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

const THEME_KEY = "commons.theme";

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

export function toggleTheme() {
  const next = otherTheme();

  const apply = () => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (e) {
      /* storage disabled — the choice just won't survive a reload */
    }
    // The header's toggle draws itself from the current theme, and the palette
    // can change it from the other side of the app. Announce it rather than
    // letting the button quietly go stale.
    dispatchEvent(new CustomEvent("commons:theme", { detail: next }));
    syncThemeColor();
  };

  // Every colour in the app is a custom property, so the flip is one attribute
  // and the repaint is instantaneous — which is exactly the problem. A room
  // does not snap from lamplight to daylight, and the snap is most of why a
  // theme toggle feels like a setting rather than like a light switch. Inside
  // a view transition the browser cross-fades the two paintings of the page
  // for a fifth of a second and it reads as the lights coming up.
  //
  // crossFade answers false where the API is missing or the reader has asked
  // for less motion, and then the flip still has to happen — unwrapped, which
  // is what it always was.
  if (!crossFade(apply)) apply();
  return next;
}

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
