// @ts-check
// How the post is set, and the mode that clears everything else off the page.
//
// Two settings and one mode, and they are here together because they are one
// idea: the post screen is the app's best surface and until now it had exactly
// one thing you could change about it, which was the theme.
//
// **The size is a preference; focus is a mode.** The size is kept — a reader
// who needs larger type needs it every time — and focus is not. Focus is
// something you enter for one reading, the way you'd move a lamp; a reader who
// found every post arriving with no thread, no vote count and no way back would
// reasonably think the app was broken, and would have to find this panel again
// to discover it wasn't. So it lasts as long as the screen does.
//
// Everything below is CSS switched by one attribute on <html>. There is no
// layout being recomputed in JavaScript and nothing measured — which is the
// only reason a mode like this can be a dozen lines rather than a component.

import { h } from "../dom.js";
import { radioGroup } from "./radiogroup.js";
import {
  textSize,
  setTextSize,
  textSizes,
  measure,
  setMeasure,
  measures,
} from "../reading.js";
import { typing } from "./feedkeys.js";
import { currentPath } from "../router.js";

const FOCUS_ATTR = "focus";

const LABELS = { s: "Small", m: "Medium", l: "Large" };
const MEASURE_LABELS = { normal: "Normal", narrow: "Narrow" };

export const focusIsOn = () => !!document.documentElement.dataset[FOCUS_ATTR];

/** @param {boolean} on */
export function setFocus(on) {
  if (on) document.documentElement.dataset[FOCUS_ATTR] = "on";
  else delete document.documentElement.dataset[FOCUS_ATTR];
  // The panel's switch and the palette's row both draw this, and neither is
  // necessarily the one that changed it.
  dispatchEvent(new CustomEvent("commons:focus", { detail: on }));
  return on;
}

export const toggleFocus = () => setFocus(!focusIsOn());

/** Is there a post on screen for focus mode to be about? */
export const canFocus = () => /^\/posts\/\d+$/.test(currentPath());

// — the panel ------------------------------------------------------------------

/**
 * The "Aa" button and the row it opens.
 *
 * Inline rather than a popover, which is the pattern this app already has for
 * a control that needs more room than a button: the delete confirm expands in
 * place instead of floating over the page. A popover would mean positioning,
 * a focus trap, an outside-click rule and a scroll listener, all to avoid
 * pushing four lines of type down the screen.
 *
 * Returns both halves; views/post.js puts the button in the toolbar row and
 * the panel directly beneath it.
 */
export function readerControl() {
  const panel = h("div", { class: "typeset", hidden: true });

  const button = h(
    "button",
    {
      class: "btn btn--quiet typeset__open",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": "typeset-panel",
    },
    // The one place an "A" is clearer than a word, and it is decoration on top
    // of one: the button's name is the text beside it.
    h("span", { class: "typeset__mark", "aria-hidden": "true" }, "Aa"),
    h("span", {}, "Reading")
  );

  panel.id = "typeset-panel";

  // — the two settings ---------------------------------------------------------
  // Both are the same widget, built by the same function, and that is not only
  // tidiness: size and measure are offered as one idea — how this is set for
  // you — and two groups drawn by two different pieces of code is how they
  // stop looking like one. The theme picker on #/settings is a third of the
  // same idea, which is why the builder now lives in components/radiogroup.js
  // rather than in here.

  const sizeGroup = radioGroup({
    legend: "Text size",
    name: "commons-text-size",
    values: textSizes(),
    labels: LABELS,
    current: textSize,
    choose: setTextSize,
    event: "commons:textsize",
  });

  // How far the eye travels back to find the start of the next line. Second
  // because it is the one nobody knows they want until they have tried it, and
  // the size is what people open this panel for.
  const measureGroup = radioGroup({
    legend: "Line width",
    name: "commons-measure",
    values: measures(),
    labels: MEASURE_LABELS,
    current: measure,
    choose: setMeasure,
    event: "commons:measure",
  });

  // — focus --------------------------------------------------------------------
  const focusInput = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox" }));
  focusInput.checked = focusIsOn();
  focusInput.addEventListener("change", () => setFocus(focusInput.checked));

  const focusToggle = h(
    "label",
    { class: "switch typeset__focus" },
    focusInput,
    h("span", { class: "switch__track" }, h("span", { class: "switch__thumb" })),
    h("span", {}, "Focus mode")
  );

  panel.append(
    sizeGroup,
    measureGroup,
    focusToggle,
    h(
      "p",
      { class: "typeset__note" },
      "Kept in this browser. Focus mode lasts until you leave the post."
    )
  );

  const open = (next) => {
    panel.hidden = !next;
    button.setAttribute("aria-expanded", String(next));
  };

  button.addEventListener("click", () => open(panel.hidden));

  // Changed from the palette, from the key, or from the header's way out. The
  // two radio groups look after themselves — see group().
  addEventListener("commons:focus", () => {
    focusInput.checked = focusIsOn();
  });

  return { button, panel };
}

// — the way out, and the keys --------------------------------------------------

/**
 * Wired once, from main.js.
 *
 * The button lives in the header rather than floating over the page, because
 * focus mode keeps the header — a transparent one would let the post scroll
 * visibly underneath the only control that gets you out, and a floating button
 * would be a piece of furniture this app has nowhere else. What changes is what
 * the header holds: the brand, the search and the account cluster go, and this
 * takes their place.
 *
 * `f` is not registered here. It is a row in the command palette, which only
 * offers it on a post, and the palette dispatches the keys it advertises — so
 * there is one list of what the single letters do rather than two.
 */
export function wireReader() {
  // No chevron on it. The Back link two lines up the page uses one, and that
  // one goes somewhere; this stays exactly where it is and puts the room back.
  // One mark, two meanings, is worse than a word.
  const out = h(
    "button",
    { class: "btn btn--quiet focus-out", type: "button" },
    "Leave focus"
  );
  out.addEventListener("click", () => setFocus(false));
  document.querySelector(".site-header__inner")?.append(out);

  addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !focusIsOn()) return;
    // typing() is also how this asks "is the palette open?" — when it is, focus
    // is in its field, and Escape belongs to it.
    if (typing(e.target)) return;
    e.preventDefault();
    setFocus(false);
  });

  // Leaving the post takes the mode with it. Otherwise a reader who pressed
  // Back would arrive at a feed with no header, no search and no account —
  // which is not a reading room, it is a broken page.
  addEventListener("commons:screen", () => {
    if (focusIsOn() && !canFocus()) setFocus(false);
  });
}
