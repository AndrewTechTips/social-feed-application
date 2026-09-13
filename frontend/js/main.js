// Boot: paint the header, wire the theme toggle and search, register routes,
// start the router.

import { route, startRouter, navigate, currentPath, currentQuery } from "./router.js";
import { IS_DEMO } from "./config.js";
import { get, subscribe, clearSession, dropFeedCache } from "./store.js";
import { h, icon, toast } from "./ui.js";
import { renderFeed } from "./views/feed.js";
import { renderPost } from "./views/post.js";
import { renderLogin, renderRegister } from "./views/auth.js";
import { renderCompose, renderEdit } from "./views/compose.js";

// — theme -----------------------------------------------------------------------
function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
function paintThemeButton(btn) {
  const next = currentTheme() === "dark" ? "light" : "dark";
  btn.setAttribute("aria-label", `Switch to ${next} theme`);
  btn.replaceChildren(icon(currentTheme() === "dark" ? "sun" : "moon"));
}
function themeButton() {
  const btn = h("button", { class: "btn btn--quiet btn--icon", type: "button" });
  paintThemeButton(btn);
  btn.addEventListener("click", () => {
    const to = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = to;
    try {
      localStorage.setItem("commons.theme", to);
    } catch (e) {}
    paintThemeButton(btn); // swap in place — don't rebuild the cluster
  });
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
    const email = h("span", { class: "account__email", title: session.email }, session.email);
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
    out.addEventListener("click", () => {
      clearSession();
      dropFeedCache();
      toast("Signed out.");
      navigate("/");
    });
    kids.push(write, email, out, themeButton());
  } else {
    kids.push(
      h("a", { class: "btn btn--quiet", href: "#/login" }, "Sign in"),
      themeButton()
    );
  }
  box.replaceChildren(...kids);
}

// — search (feed only) ------------------------------------------------------
function wireSearch() {
  const form = document.querySelector(".search");
  const input = document.getElementById("search-input");
  let timer;

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

function syncChrome() {
  const onFeed = currentPath() === "/";
  const form = document.querySelector(".search");
  const input = document.getElementById("search-input");
  form.hidden = !onFeed;
  if (onFeed) {
    const q = currentQuery().get("search") || "";
    if (document.activeElement !== input) input.value = q;
  }
  const titles = {
    "/": "Commons",
    "/login": "Sign in · Commons",
    "/register": "Create an account · Commons",
    "/compose": "New post · Commons",
  };
  document.title = titles[currentPath()] || "Commons";
}

// — brand: a click always means "fresh feed" -----------------------------
document.querySelector(".brand").addEventListener("click", () => dropFeedCache());

// — routes -------------------------------------------------------------------
route("/", renderFeed);
route("/login", renderLogin);
route("/register", renderRegister);
route("/compose", renderCompose);
route("/posts/:id", renderPost);
route("/posts/:id/edit", renderEdit);

subscribe(renderAccount);
addEventListener("hashchange", syncChrome);

renderAccount();
wireSearch();
syncChrome();

// On a static host the app answers its own API calls, and the strip is how a
// visitor finds that out. Loaded only when it applies, so the normal build
// never fetches it.
if (IS_DEMO) {
  import("./demo/strip.js").then((m) => m.mountDemoStrip());
}

startRouter();
