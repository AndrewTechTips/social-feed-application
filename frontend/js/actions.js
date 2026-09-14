// @ts-check
// The handful of things the app can do from more than one place.
//
// The header has always owned the theme toggle and the sign-out button. The
// command palette does both too, and a palette whose "Toggle theme" drifts
// away from the button next to it is worse than no palette. So the behaviour
// lives here and both call it.

import { api, forgetPendingRefresh } from "./api.js";
import { clearSession, dropFeedCache } from "./store.js";
import { toast } from "./ui.js";
import { navigate } from "./router.js";

const THEME_KEY = "commons.theme";

export function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function otherTheme() {
  return currentTheme() === "dark" ? "light" : "dark";
}

export function toggleTheme() {
  const next = otherTheme();
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
  toast("Signed out.");
  navigate("/");
  // Nothing to say if it fails. The person is signed out here either way, and
  // an error about a request they never made would be noise — but an unhandled
  // rejection is still an unhandled rejection.
  goodbye.catch(() => {});
}
