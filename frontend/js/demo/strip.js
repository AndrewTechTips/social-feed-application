// The demo-mode strip.
//
// The published site answers its own API calls (js/demo/backend.js), and a
// visitor has no way of knowing that unless we say so. This says so — plainly,
// on every visit, in the same voice as the rest of the app.
//
// It can be folded away, but only for the current tab: the note is stored in
// sessionStorage, never localStorage, so the next person to open the link — and
// the same person tomorrow — sees it again. A banner you can permanently
// dismiss is a banner that stops being true.

import { h, icon } from "../ui.js";
import { resetDemo } from "../config.js";
import { clearSession, clearVotes, dropFeedCache } from "../store.js";

const REPO = "https://github.com/AndrewTechTips/social-feed-application";
const HIDDEN_KEY = "commons.demo.strip-folded";

const folded = () => {
  try {
    return sessionStorage.getItem(HIDDEN_KEY) === "1";
  } catch (e) {
    return false;
  }
};

const remember = (isFolded) => {
  try {
    sessionStorage.setItem(HIDDEN_KEY, isFolded ? "1" : "0");
  } catch (e) {
    /* storage disabled — it just won't stay folded, which is the safe way to
       fail for a notice that has to be seen */
  }
};

export function mountDemoStrip() {
  const body = h(
    "p",
    { class: "demo__text" },
    h("strong", { class: "demo__label" }, "Demo mode"),
    " — this runs entirely in your browser. The real backend is in ",
    h("a", { href: `${REPO}/tree/main/backend`, target: "_blank", rel: "noopener" }, "backend/"),
    "; here's ",
    h("a", { href: `${REPO}#the-api`, target: "_blank", rel: "noopener" }, "the API contract"),
    " it implements. Nothing you post is saved anywhere."
  );

  const reset = h(
    "button",
    { class: "btn btn--quiet demo__action", type: "button" },
    "Reset the demo"
  );
  reset.addEventListener("click", async () => {
    reset.disabled = true;
    await resetDemo();

    // The demo's accounts and tokens went with the data, so anything the app
    // still believes about being signed in is now false — including the local
    // upvote mirror, which would otherwise show posts as upvoted by a session
    // that no longer exists. Clear them here rather than leaving the next write
    // to discover it with a 401.
    clearSession();
    clearVotes();
    dropFeedCache();

    location.replace(location.pathname + location.search + "#/");
    location.reload();
  });

  const fold = h("button", {
    class: "btn btn--quiet btn--icon demo__fold",
    type: "button",
    "aria-label": "Hide the demo notice for this visit",
    title: "Hide for this visit",
  });
  fold.append(icon("chevron-left"));

  const strip = h(
    "aside",
    { class: "demo", "aria-label": "About this demo" },
    h("div", { class: "demo__inner" }, body, h("div", { class: "demo__actions" }, reset, fold))
  );

  const paint = (isFolded) => {
    strip.classList.toggle("demo--folded", isFolded);
    fold.setAttribute(
      "aria-label",
      isFolded ? "Show the demo notice" : "Hide the demo notice for this visit"
    );
    fold.setAttribute("aria-expanded", String(!isFolded));
  };

  fold.addEventListener("click", () => {
    const next = !strip.classList.contains("demo--folded");
    paint(next);
    remember(next);
  });

  paint(folded());
  document.querySelector(".site-header").after(strip);
  document.documentElement.classList.add("has-demo-strip");
}
