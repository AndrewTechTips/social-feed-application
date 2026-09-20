// @ts-check
// Installing Commons.
//
// ── why this is a module and not a button ──────────────────────────────────
// The app has been installable since the manifest and the service worker
// shipped, and has never once said so: the only route in was Chrome's own
// address-bar icon. The obvious fix — an "Install" button in the header — is
// worse than nothing, because `beforeinstallprompt` is Chromium's alone.
// iOS Safari has no prompt and never will; Firefox has no install at all. A
// single button is therefore dead or lying for a large share of visitors, and
// a dead button is the first thing a reader presses.
//
// So there are four states, and two of them draw nothing:
//
//   1. installable now    the event fired and is stashed  → a button
//   2. installable, no API  iOS, not already installed    → a sentence
//   3. already installed                                  → nothing
//   4. anything else                                      → nothing
//
// Never a disabled control. A control that cannot do anything is a control
// that should not be on the page, and "nothing happens" is the degradation
// this app asks for everywhere else.
//
// ── two mechanics that are only learned the hard way ───────────────────────
// **The event has to be caught at boot, and preventDefault()-ed.** It is fired
// once at the window, and a listener added afterwards never hears it; without
// preventDefault, Chrome shows its own mini-infobar and this never gets a
// turn. The listener below is registered at module scope for that reason, and
// js/main.js imports this file first so that "module scope" is as early as the
// app can make it.
//
// **The stashed event is single-use.** Once prompt() has resolved, that object
// is spent — a second press does nothing at all, silently. So it is discarded
// and the control removed whatever the reader chose, including when they
// dismissed the dialog. Chrome will fire a fresh event later if it still wants
// to, and the control comes back on its own when it does.

import { h } from "./dom.js";

/**
 * The stashed `beforeinstallprompt`. Untyped because the event is Chromium's
 * own and is in no lib the checker has.
 * @type {any}
 */
let deferred = null;

/** `appinstalled` fired in this tab. */
let installed = false;

// The sentence iOS gets, in one place: the palette says it in a toast and the
// masthead and the colophon say it behind a disclosure, and three copies of an
// instruction is two copies that go wrong.
export const INSTALL_HELP =
  "In Safari, press Share, then Add to Home Screen. It opens in a window of " +
  "its own after that, and what you have already read stays readable with no " +
  "connection at all.";

// Every way a browser has of saying "you are not in a tab". `standalone` is the
// one the manifest asks for; the rest are what a browser falls back to, and
// each of them is still an installed app rather than a page.
const INSTALLED_MODES = [
  "standalone",
  "minimal-ui",
  "fullscreen",
  "window-controls-overlay",
];

/**
 * iOS and iPadOS, which is the whole of the population that can install and
 * has no API for it.
 *
 * iPadOS 13 and later claim to be a Mac, down to the platform string, and the
 * one thing that gives them away is that a Mac has no touch screen.
 */
function isApple() {
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

/** Already an app, by any of the ways a browser will admit to it. */
export function isInstalled() {
  if (installed) return true;
  // iOS's own flag. It predates display-mode by years and is still the only
  // thing an installed iOS web app answers to.
  if (/** @type {any} */ (navigator).standalone === true) return true;
  return INSTALLED_MODES.some((mode) => matchMedia(`(display-mode: ${mode})`).matches);
}

/**
 * Which of the four states we are in, as the two that draw something plus null
 * for the two that don't.
 *
 * The order matters. Installed wins over everything, so an installed iOS app
 * is never told how to install itself. A stashed event wins over the Apple
 * branch after that, so if a future iOS ever does fire one, it gets the real
 * button rather than a paragraph about the Share sheet.
 *
 * @returns {"prompt" | "manual" | null}
 */
export function installState() {
  if (isInstalled()) return null;
  if (deferred) return "prompt";
  if (isApple()) return "manual";
  return null;
}

// — who is watching -----------------------------------------------------------
// The state changes after the screen is drawn: Chrome decides to fire the event
// some time after load, and `appinstalled` can arrive at any point. So whatever
// is on the page has to be repainted rather than built once.
//
// Each watcher names the element it belongs to, and a watcher whose element has
// left the document is dropped. That is the whole of the cleanup: the feed
// rebuilds its masthead on every render and none of those renders has to
// remember to unsubscribe, which is the kind of bookkeeping that is always
// right until the one path that forgets it.
/** @type {Set<{ el: Element, paint: () => void }>} */
const watchers = new Set();

function sweep() {
  for (const w of watchers) if (!w.el.isConnected) watchers.delete(w);
}

function notify() {
  sweep();
  for (const w of watchers) {
    try {
      w.paint();
    } catch (e) {
      /* one broken painter is not worth taking the others down with it */
    }
  }
}

// — the event -----------------------------------------------------------------
addEventListener("beforeinstallprompt", (event) => {
  // Without this Chrome shows its own mini-infobar and the controls below
  // never get a turn.
  event.preventDefault();
  deferred = event;
  notify();
});

addEventListener("appinstalled", () => {
  installed = true;
  // It has been used. Holding on to it would mean offering to install an app
  // that is already installed.
  deferred = null;
  notify();
});

// Installing from the browser's own menu can move this very window into an app
// window, with no navigation and no `appinstalled` in this tab.
const standalone = matchMedia("(display-mode: standalone)");
standalone.addEventListener?.("change", notify);

/**
 * Show the browser's install dialog, once.
 *
 * Resolves to what the reader chose, or null if there was nothing to show or
 * the browser refused — every caller treats all three the same way, because in
 * every one of them the answer is "the control goes away".
 *
 * @returns {Promise<string | null>}
 */
export async function promptToInstall() {
  const event = deferred;
  if (!event) return null;
  // Read and cleared in the same breath, before anything is awaited. Two
  // presses in the same tick is the ordinary way to press a button twice, and
  // a second prompt() on a spent event throws — so the second caller has to
  // find the stash already empty, which it does because nothing yields between
  // these two lines. An `inFlight` flag beside this would look like a third
  // guard and would in fact never once be the one that fired.
  deferred = null;
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice?.outcome ?? null;
  } catch (e) {
    // Chrome throws here when the event has already been used or when it
    // decides the press was not a gesture. Neither is worth a toast: the
    // control is about to disappear either way, which is the honest report.
    return null;
  } finally {
    notify();
  }
}

// — the badge -----------------------------------------------------------------
/**
 * Put the unread count on the app's own icon: the dock on a Mac, the home
 * screen on Android, the taskbar on Windows. js/notify.js calls this from the
 * one place the count changes.
 *
 * Fifteen lines, no server and no permission prompt — the count is already
 * being polled for the lamp in the header, and this is the same number in the
 * one place a closed app can still be seen.
 *
 * **Not gated on isInstalled().** It is tempting, and it would be wrong: on a
 * desktop Chrome the app can be installed while you are reading it in an
 * ordinary tab, and the badge still belongs on the installed icon. The browser
 * is the one that knows, so let it decide and say nothing when it declines.
 *
 * @param {number} count
 */
export function setAppBadge(count) {
  const nav = /** @type {any} */ (navigator);
  if (typeof nav.setAppBadge !== "function") return;
  try {
    const done = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.();
    // Safari rejects this when the app is only a tab. That is not a fault and
    // it is certainly not worth a line in somebody's console.
    done?.catch?.(() => {});
  } catch (e) {
    /* and a browser that throws where Safari rejects */
  }
}

// — the pieces ----------------------------------------------------------------

/**
 * The button, for state 1.
 * @param {string} [label]
 * @param {string} [variant] the .btn modifier the surrounding screen uses
 */
export function installButton(label = "Install Commons", variant = "btn--quiet") {
  const btn = h("button", { class: `btn ${variant}`, type: "button" }, label);
  btn.addEventListener("click", async () => {
    // Nothing re-enables it. promptToInstall discards the event, and the
    // repaint that follows takes this button off the page; disabled is what
    // that looks like for the frame in between.
    btn.disabled = true;
    await promptToInstall();
  });
  return btn;
}

/**
 * The sentence, for state 2 — behind a disclosure rather than printed in full,
 * because it is four lines of instructions for one platform and the masthead
 * is three lines of type about what Commons is.
 *
 * <details> rather than a button and a class: it opens with the keyboard, it
 * announces itself as expandable, and it is still readable with no JavaScript
 * running at all.
 * @param {string} [summary]
 */
export function installHowTo(summary = "Add it to your home screen") {
  return h(
    "details",
    { class: "install-how" },
    h("summary", { class: "install-how__summary" }, summary),
    h("p", { class: "install-how__body" }, INSTALL_HELP)
  );
}

/**
 * A block that offers to install and is empty whenever there is nothing honest
 * to offer — which is two of the four states, and the reason this hands back a
 * container that can be empty rather than a button that can be dead.
 *
 * It stays in the document while empty rather than being removed, so that the
 * event arriving late has somewhere to put the control.
 *
 * @param {(state: "prompt" | "manual") => (Node | string | null)[]} build
 * @param {Record<string, any>} [props]
 */
export function installBlock(build, props) {
  const el = h("div", props);
  const paint = () => {
    const state = installState();
    el.replaceChildren();
    el.hidden = !state;
    if (state) el.append(...build(state).filter((n) => n != null));
  };
  paint();
  sweep();
  watchers.add({ el, paint });
  return el;
}
