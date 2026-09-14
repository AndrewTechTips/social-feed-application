// @ts-check
// Boot: paint the header, wire the theme toggle and search, register routes,
// start the router.

import {
  route,
  startRouter,
  navigate,
  currentPath,
  currentQuery,
  forgetCurrentScreen,
} from "./router.js";
import { IS_DEMO } from "./config.js";
import { mountDemoStrip } from "./demo/strip.js";
import { get, subscribe, dropFeedCache } from "./store.js";
import { currentTheme, otherTheme, toggleTheme, signOut } from "./actions.js";
import { h, icon } from "./ui.js";
import { mountPalette, openPalette } from "./components/palette.js";
import { wireFeedKeys } from "./components/feedkeys.js";
import { renderFeed } from "./views/feed.js";
import { renderPost } from "./views/post.js";
import { renderProfile } from "./views/profile.js";
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

function renderAccount() {
  const box = accountEl();
  const session = get("session");
  const kids = [];

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
    kids.push(write, who, out, themeButton());
  } else {
    kids.push(
      h("a", { class: "btn btn--quiet", href: "#/login" }, "Sign in"),
      themeButton()
    );
  }
  if (box) box.replaceChildren(...kids);
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
  const mastheadHasIt = !get("session") && currentPath() === "/" && !currentQuery().get("search");
  demoBand.hidden = mastheadHasIt;
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
  hint.replaceChildren(
    h("kbd", { "aria-hidden": "true" }, mac ? "\u2318K" : "Ctrl K")
  );
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
  };
  document.title = titles[currentPath()] || "Commons";
}

// — brand: a click always means "fresh feed" -----------------------------
document
  .querySelector(".brand")
  ?.addEventListener("click", () => dropFeedCache());

// — routes -------------------------------------------------------------------
route("/", renderFeed);
route("/login", renderLogin);
route("/register", renderRegister);
route("/compose", renderCompose);
route("/posts/:id", renderPost);
route("/posts/:id/edit", renderEdit);
route("/u/:username", renderProfile);

subscribe(renderAccount);
// Signing in or out changes what every screen shows, so the router mustn't
// decide the one already on screen is still good enough.
subscribe(forgetCurrentScreen);
// Signing in or out moves the notice between the masthead and the band, and a
// same-route navigate() fires no hashchange — so the store drives this too.
subscribe(syncDemoStrip);
addEventListener("hashchange", syncChrome);

renderAccount();
wireSearch();
syncChrome();
mountPalette();
paintPaletteHint();
wireFeedKeys();

startRouter();
