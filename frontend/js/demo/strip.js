// The demo-mode notice.
//
// The published site answers its own API calls (js/demo/backend.js), and a
// visitor has no way of knowing that unless we say so. This says so — plainly,
// on every visit, in the same voice as the rest of the app.
//
// It appears in exactly one of two places, never both:
//
//   · folded into the masthead, when an anonymous visitor is on the feed and
//     there's already a block of type there explaining what Commons is
//   · as a band under the header, everywhere else
//
// main.js owns that choice (syncDemoStrip); this module owns the words, so the
// two placements can't drift apart.
//
// The band can be folded away, but only for the current tab: the note is kept
// in sessionStorage, never localStorage, so the next person to open the link —
// and the same person tomorrow — sees it again. A notice you can permanently
// dismiss is a notice that stops being true.

import { h, icon } from "../ui.js";
import { resetDemo } from "../config.js";
import { clearSession, clearVotes, dropFeedCache } from "../store.js";

const REPO = "https://github.com/AndrewTechTips/social-feed-application";
const FOLDED_KEY = "commons.demo.strip-folded";

const folded = () => {
  try {
    return sessionStorage.getItem(FOLDED_KEY) === "1";
  } catch (e) {
    return false;
  }
};

const remember = (isFolded) => {
  try {
    sessionStorage.setItem(FOLDED_KEY, isFolded ? "1" : "0");
  } catch (e) {
    /* storage disabled — it just won't stay folded, which is the safe way to
       fail for a notice that has to be seen */
  }
};

// The sentence itself, in one place. Both placements use it verbatim.
export function demoSentence() {
  return h(
    "p",
    { class: "demo__text" },
    h("strong", { class: "demo__label" }, "Demo mode"),
    " — this runs entirely in your browser. The real backend is in ",
    h("a", { href: `${REPO}/tree/main/backend`, target: "_blank", rel: "noopener" }, "backend/"),
    "; here's ",
    h("a", { href: `${REPO}#the-api`, target: "_blank", rel: "noopener" }, "the API contract"),
    " it implements. Nothing you post is saved anywhere."
  );
}

export function resetButton() {
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
  return reset;
}

// The version that lives inside the masthead: same words, no fold control —
// there's nothing to fold away from when it's part of the page's opening block.
export function demoNote() {
  return h(
    "div",
    { class: "demo demo--inline", "aria-label": "About this demo" },
    h("div", { class: "demo__inner" }, demoSentence(), h("div", { class: "demo__actions" }, resetButton()))
  );
}

// The band under the header, used on every screen the masthead doesn't cover.
export function mountDemoStrip() {
  const fold = h("button", {
    class: "btn btn--quiet btn--icon demo__fold",
    type: "button",
    "aria-label": "Hide the demo notice for this visit",
    title: "Hide for this visit",
  });
  fold.append(icon("chevron-left"));

  const strip = h(
    "aside",
    { class: "demo demo--band", "aria-label": "About this demo" },
    h(
      "div",
      { class: "demo__inner" },
      demoSentence(),
      h("div", { class: "demo__actions" }, resetButton(), fold)
    )
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
  return strip;
}
