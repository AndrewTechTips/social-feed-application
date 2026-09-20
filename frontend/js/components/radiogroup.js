// @ts-check
// A small set of mutually exclusive choices, drawn as segments.
//
// ── why it moved out of reader.js ─────────────────────────────────────────
// It was a closure inside `readerControl`, shared between the text size and
// the line width, with a comment beside it saying why one builder rather than
// two: *"size and measure are offered as one idea — how this is set for you —
// and two groups drawn by two different pieces of code is how they stop
// looking like one."*
//
// The theme picker on `#/settings` is a third of exactly the same idea, so the
// argument now reaches across two files and the builder has to as well. A
// second copy in the settings view would have been the thing that comment
// warns about, found a month later when one of them grew a focus ring the
// other did not.
//
// ── real radios, not buttons with aria-pressed ────────────────────────────
// A set of mutually exclusive choices is what a radio group *is*, and using
// one means the arrow keys, the roving tab stop and the announcement all
// arrive already built and already correct. Buttons with `aria-pressed` would
// be three separate controls that happen to look related, and a keyboard
// reader would have to Tab through every option to pass them.
//
// The input itself is visually hidden rather than `appearance: none` — the
// label is the segment, and `:has(input:checked)` paints it. The visible word
// is the accessible name, which is why the labels are words and not glyphs.

import { h } from "../dom.js";

/**
 * @param {object} spec
 * @param {string} spec.legend       what the set of choices is called
 * @param {string} spec.name         a radio group needs its own, or two merge
 * @param {string[]} spec.values     in the order they should be offered
 * @param {Record<string, string>} spec.labels
 * @param {() => string} spec.current  asked again on every repaint
 * @param {(value: string) => unknown} spec.choose
 * @param {string} spec.event        the app-wide event meaning "this changed"
 * @param {string} [spec.className]  an extra class on the fieldset
 * @param {boolean} [spec.hideLegend] keep the legend for the accessible name
 *   and take it off the screen — for a group a heading has already named
 */
export function radioGroup({
  legend,
  name,
  values,
  labels,
  current,
  choose,
  event,
  className,
  hideLegend,
}) {
  const steps = h("div", { class: "choice__steps" });
  /** @type {HTMLInputElement[]} */
  const radios = [];

  for (const value of values) {
    const input = /** @type {HTMLInputElement} */ (
      h("input", { type: "radio", name, value })
    );
    input.checked = value === current();
    input.addEventListener("change", () => {
      if (input.checked) choose(value);
    });
    radios.push(input);
    steps.append(
      h("label", { class: "choice__step" }, input, h("span", {}, labels[value]))
    );
  }

  // Changed from somewhere else — the palette, a key, the header's toggle, a
  // second copy of this control on another screen — so redraw from `current`
  // rather than assuming this group was what changed it.
  addEventListener(event, () => {
    radios.forEach((r) => (r.checked = r.value === current()));
  });

  return h(
    "fieldset",
    { class: "choice" + (className ? ` ${className}` : "") },
    // A fieldset needs a name whatever happens, so the legend is always
    // there; `hideLegend` only takes it off the screen. On the settings
    // screen the h3 above it already says "Theme", and printing the word
    // twice in two type sizes is how a form starts to look generated.
    h("legend", { class: hideLegend ? "visually-hidden" : "choice__legend" }, legend),
    steps
  );
}
