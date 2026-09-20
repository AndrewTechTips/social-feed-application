// @ts-check
// Boot: paint the header, wire the theme toggle and search, register routes,
// start the router.

// First, and for one reason: `beforeinstallprompt` is fired once at the window
// and a listener added after it has fired never hears it. Importing this
// module is what registers that listener — see js/install.js.
import "./install.js";

import {
  route,
  startRouter,
  navigate,
  currentPath,
  currentQuery,
  forgetCurrentScreen,
} from "./router.js";
import { forgetConditional } from "./api.js";
import { IS_DEMO } from "./config.js";
import { mountDemoStrip } from "./demo/strip.js";
import { get, subscribe, dropFeedCache } from "./store.js";
import {
  currentTheme,
  otherTheme,
  toggleTheme,
  signOut,
  syncThemeColor,
} from "./actions.js";
import { h, icon } from "./dom.js";
import { toast } from "./toast.js";
import { mountPalette, openPalette } from "./components/palette.js";
import { shelfCount } from "./shelf.js";
import { unreadCount, startNotifications } from "./notify.js";
import { wireFeedKeys } from "./components/feedkeys.js";
import { wireReader } from "./components/reader.js";
import { wireQuote } from "./components/quote.js";
import { renderFeed } from "./views/feed.js";
import { renderPost } from "./views/post.js";
import { renderProfile } from "./views/profile.js";
import { renderShelf } from "./views/shelf.js";
import { renderColophon } from "./views/colophon.js";
import { renderSettings } from "./views/settings.js";
import { renderNotifications } from "./views/notifications.js";
import { renderLogin, renderRegister } from "./views/auth.js";
import { renderCompose, renderEdit } from "./views/compose.js";

// — theme -----------------------------------------------------------------------
// The behaviour lives in actions.js, because the command palette does this too.
function paintThemeButton(btn) {
  btn.setAttribute("aria-label", `Switch to ${otherTheme()} theme`);
  btn.replaceChildren(icon(currentTheme() === "dark" ? "sun" : "moon"));
}
function themeButton() {
  const btn = h("button", { class: "btn btn--quiet btn--icon", type: "button" });
  paintThemeButton(btn);
  btn.addEventListener("click", toggleTheme);
  // Repaint whoever changed it — the button, or the palette.
  addEventListener("commons:theme", () => paintThemeButton(btn));
  return btn;
}

// — header account cluster ---------------------------------------------------
const accountEl = () => document.getElementById("account");

// A way in, and only once there is somewhere to go.
//
// A shelf link on an empty shelf is a button that leads to a sentence
// apologising for itself, and it would be taking 44 pixels off the narrowest
// header in the app to do it. So it appears when the first post is saved and
// goes again when the last one is taken off — which is also how somebody finds
// out the shelf exists, without anything having to announce it.
//
// No count on it. A number in a corner of a header is a notification badge
// whatever you call it, and this is a bookshelf, not an inbox. The count is on
// the shelf, where it is a fact about what you are looking at.
// The lamp, and the one number in this header.
//
// The shelf link a few lines below says, in as many words, that a number in the
// corner of a header is a notification badge whatever you call it. This is the
// exception that proves it: this *is* an inbox, so it is the one control here
// entitled to a count.
//
// No amber. The accent is spent on a vote, on warmth, and on where you are, and
// an unread count is none of those — it is said in the neutrals, with the
// weight doing the work. `aria-hidden` on the number because the accessible
// name below already says it in words, and a screen reader should hear
// "Notifications, three unread" rather than "Notifications 3".
function notificationsLink() {
  const n = unreadCount();
  const link = h(
    "a",
    {
      class: "btn btn--quiet btn--action lamp" + (n ? " lamp--lit" : ""),
      href: "#/notifications",
      "aria-label":
        n === 0
          ? "Notifications"
          : n === 1
            ? "Notifications, one unread"
            : `Notifications, ${n} unread`,
      title: "Notifications",
    },
    icon("lamp"),
    h("span", { class: "btn__label" }, "Notifications")
  );
  if (n) {
    link.append(
      h(
        "span",
        { class: "lamp__count", "aria-hidden": "true" },
        n > 99 ? "99+" : String(n)
      )
    );
  }
  return link;
}

function shelfLink() {
  const n = shelfCount();
  return h(
    "a",
    {
      class: "btn btn--quiet btn--action",
      href: "#/shelf",
      "aria-label":
        n === 1 ? "Your shelf, one post saved" : `Your shelf, ${n} posts saved`,
      title: "Your shelf",
    },
    icon("bookmark"),
    h("span", { class: "btn__label" }, "Shelf")
  );
}

function renderAccount() {
  const box = accountEl();
  const session = get("session");
  const kids = [];
  const shelf = shelfCount() > 0 ? shelfLink() : null;

  if (session) {
    // Both carry their name in aria-label, so the narrow-screen rule can hide
    // the word and leave a 44px icon button without costing the accessible name
    // (at 320px the full-width labels used to shove the theme toggle off-screen).
    const write = h(
      "a",
      {
        class: "btn btn--quiet btn--action",
        href: "#/compose",
        "aria-label": "Write a post",
        title: "Write a post",
      },
      icon("pencil"),
      h("span", { class: "btn__label" }, "Write")
    );
    // Your name, linking to your own posts — the same place anyone else's
    // byline goes.
    const who = h(
      "a",
      {
        class: "account__email",
        href: `#/u/${encodeURIComponent(session.username)}`,
        title: `Everything by ${session.username}`,
      },
      session.username
    );
    const out = h(
      "button",
      {
        class: "btn btn--quiet btn--action",
        type: "button",
        "aria-label": "Sign out",
        title: "Sign out",
      },
      icon("sign-out"),
      h("span", { class: "btn__label" }, "Sign out")
    );
    out.addEventListener("click", signOut);
    kids.push(notificationsLink(), write, shelf, who, out, themeButton());
  } else {
    kids.push(
      shelf,
      h("a", { class: "btn btn--quiet", href: "#/login" }, "Sign in"),
      themeButton()
    );
  }
  if (box) box.replaceChildren(...kids.filter(Boolean));
}

// — search (feed only) ------------------------------------------------------
function wireSearch() {
  // These three live in index.html and are not optional; the casts say so
  // rather than pretending each call site might get null.
  const form = /** @type {HTMLFormElement} */ (document.querySelector(".search"));
  const input = /** @type {HTMLInputElement} */ (
    document.getElementById("search-input")
  );
  const hint = document.getElementById("palette-hint");
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;

  if (hint) hint.addEventListener("click", openPalette);

  const push = () => {
    const v = input.value.trim();
    location.replace(v ? "#/?search=" + encodeURIComponent(v) : "#/");
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(push, 250);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    clearTimeout(timer);
    push();
  });
}

// — demo notice placement --------------------------------------------------
// The notice has to be seen on every visit, but it should only be said once.
// An anonymous visitor on the feed already gets a block of type explaining what
// Commons is, so the masthead carries it there and the band stands down.
// Everywhere else — signed in, or on any other screen — the band does the job.
let demoBand = null;

function syncDemoStrip() {
  if (!IS_DEMO) return;
  if (!demoBand) demoBand = mountDemoStrip();
  const mastheadHasIt =
    !get("session") && currentPath() === "/" && !currentQuery().get("search");
  demoBand.hidden = mastheadHasIt;
  // The band is built once and kept, so its offer to sign you in as one of the
  // seeded people has to be turned off from out here when you become somebody.
  const signIn = demoBand.querySelector(".demo__signin");
  if (signIn instanceof HTMLElement) signIn.hidden = !!get("session");
}

// ⌘ on a Mac, Ctrl everywhere else.
function paintPaletteHint() {
  const hint = document.getElementById("palette-hint");
  if (!hint) return;
  // userAgentData.platform where it exists; navigator.platform is deprecated
  // but still the only answer in Safari and Firefox.
  // userAgentData isn't in lib.dom yet; navigator.platform is deprecated but
  // still the only answer in Safari and Firefox.
  const nav = /** @type {Navigator & { userAgentData?: { platform?: string } }} */ (
    navigator
  );
  const platform = nav.userAgentData?.platform || nav.platform || "";
  const mac = /mac/i.test(platform);
  hint.replaceChildren(h("kbd", { "aria-hidden": "true" }, mac ? "\u2318K" : "Ctrl K"));
}

function syncChrome() {
  const onFeed = currentPath() === "/";
  const form = /** @type {HTMLFormElement} */ (document.querySelector(".search"));
  const input = /** @type {HTMLInputElement} */ (
    document.getElementById("search-input")
  );
  form.hidden = !onFeed;
  if (onFeed) {
    const q = currentQuery().get("search") || "";
    if (document.activeElement !== input) input.value = q;
  }
  syncDemoStrip();
  const path = currentPath();
  const profile = path.match(/^\/u\/(.+)$/);
  if (profile) {
    document.title = `${decodeURIComponent(profile[1])} · Commons`;
    return;
  }
  /** @type {Record<string, string>} */
  const titles = {
    "/": "Commons",
    "/login": "Sign in · Commons",
    "/register": "Create an account · Commons",
    "/compose": "New post · Commons",
    "/shelf": "Your shelf · Commons",
    "/colophon": "Colophon · Commons",
    "/settings": "Your account · Commons",
    "/notifications": "Notifications · Commons",
  };
  document.title = titles[currentPath()] || "Commons";
}

// — brand: a click always means "fresh feed" -----------------------------
//
// It drops the cached lists, and then it navigates — and the second half is the
// half that was missing. The brand is an `<a href="#/">`, so from anywhere else
// the browser's own navigation was doing the work and this only had to empty
// the cache first. From the feed itself there was nothing for the browser to
// do: the hash was already `#/`, no hashchange fired, and the router never
// heard about it. The cache was emptied and the refetch happened the *next*
// time the reader came back to the feed, which is not what pressing it looks
// like it means.
//
// navigate() covers both, because it is the one path that does not depend on
// the address changing: it resolves directly when the hash already matches
// (see the note above resolveIfChanged in router.js, which has always said so)
// and sets the hash when it doesn't. Exactly one render either way.
//
// preventDefault is what makes that "exactly one" true rather than nearly
// true. Without it the browser follows the href as well, and whether that
// costs a second history entry is a question about the browser rather than
// about this app. The modifier keys are let through untouched: ⌘-click and
// friends mean "open this somewhere else", and that is the browser's to answer.
document.querySelector(".brand")?.addEventListener("click", (e) => {
  const event = /** @type {MouseEvent} */ (e);
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  dropFeedCache();
  navigate("/");
});

// — routes -------------------------------------------------------------------
route("/", renderFeed);
route("/login", renderLogin);
route("/register", renderRegister);
route("/compose", renderCompose);
route("/posts/:id", renderPost);
route("/posts/:id/edit", renderEdit);
route("/u/:username", renderProfile);
route("/shelf", renderShelf);
route("/colophon", renderColophon);
route("/settings", renderSettings);
route("/notifications", renderNotifications);

subscribe(renderAccount);
// Saving the first post puts a way into the shelf in the header, and taking the
// last one off takes it away again. js/shelf.js says so rather than this
// polling for it.
addEventListener("commons:shelf", renderAccount);
// And the lamp, when the count changes under it.
addEventListener("commons:notifications", renderAccount);
// Signing in or out changes what every screen shows, so the router mustn't
// decide the one already on screen is still good enough.
subscribe(forgetCurrentScreen);
// And the conditional-request cache goes with it, for the stronger of the two
// reasons: it holds response bodies that can contain the reader's own drafts.
// Wired here rather than inside clearSession() because the store cannot import
// the API client — the client already imports the store.
subscribe(forgetConditional);
// Signing in or out moves the notice between the masthead and the band, and a
// same-route navigate() fires no hashchange — so the store drives this too.
subscribe(syncDemoStrip);
// What a failed request looks like, in one place.
//
// `api.js` used to do this itself — it imported the toast and it assigned to
// `location.hash` — which put the interface and the router underneath the
// transport layer. It says what happened now and this decides what that means,
// which is also why the wording is here: these three sentences are the app
// talking to a person, and that is this file's job rather than the fetch
// wrapper's.
addEventListener("commons:api-error", (event) => {
  const status = /** @type {CustomEvent<{status: number}>} */ (event).detail.status;
  if (status === 401) {
    // The session is already cleared by the time this fires. Sending someone
    // to the form is only right if they aren't looking at it — arriving at
    // `#/login` and being sent to `#/login` reads as the page refusing to load.
    if (!currentPath().startsWith("/login")) navigate("/login");
    toast("Your session expired.");
  } else if (status === 403) {
    toast("You can't edit that.");
  } else if (status === 429) {
    toast("You're doing that a bit fast — try again in a minute.");
  }
});

// Not `hashchange`. The chrome is part of the screen it belongs to, so it
// changes when that screen is put on the page — which is what mountView
// announces, from inside the swap. See the note there.
addEventListener("commons:screen", syncChrome);

renderAccount();
wireSearch();
syncChrome();
mountPalette();
paintPaletteHint();
wireFeedKeys();
wireReader();
wireQuote();
// After the session has been restored, so the first ask is made as somebody
// rather than as nobody.
startNotifications();

startRouter();

// — offline ---------------------------------------------------------------------
// The published build has no server behind it, so there is nothing about this
// app that actually needs the network once its files are in hand. sw.js is what
// makes that true rather than nearly true; the reasoning, including why it is
// network-first, is written down there.
//
// Resolved against import.meta.url rather than against the document, because
// the document's URL carries a hash and a query and this one must not: the
// worker's scope is the directory it is served from, and that has to be the
// app's root or it can't see the app.
//
// After load, so registering never competes with the first paint for the
// connection. A failure is not worth a word to the reader — there is no
// feature here they asked for, only one they get.
// The title bar of an installed window, and Android Chrome's address bar. The
// two <meta name="theme-color"> in index.html are keyed to the operating
// system's preference; this is where the reader's own choice takes over. Once
// at boot, because the choice was restored from storage before first paint and
// nothing has dispatched a change.
syncThemeColor();

if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker
      .register(new URL("../sw.js", import.meta.url).href)
      .catch(() => {});
  });
}
