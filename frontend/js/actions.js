// The handful of things the app can do from more than one place.
//
// The header has always owned the theme toggle and the sign-out button. The
// command palette does both too, and a palette whose "Toggle theme" drifts
// away from the button next to it is worse than no palette. So the behaviour
// lives here and both call it.

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
  clearSession();
  dropFeedCache();
  toast("Signed out.");
  navigate("/");
}
