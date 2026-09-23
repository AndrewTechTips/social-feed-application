// @ts-check
// Making elements. Nothing in here knows what the app is about.
//
// This was the top of `ui.js`, which grew into the file everything imported
// because it was the file everything imported: a hyperscript builder, toasts,
// time formatting, avatars, skeletons, view mounting *and* the vote control —
// a stateful component that makes network calls — in 549 lines. Splitting it
// is the last item of the first upgrade plan, and the line it is split along
// is "does this need to know what a post is".
//
// Nothing here does. There is no import in this file and there should never be
// one.

const SVG_NS = "http://www.w3.org/2000/svg";
// Which tags have to be created in the SVG namespace. `text`, `defs`,
// `linearGradient` and `stop` joined the shape tags for the 404 screen, whose
// numerals are SVG text filled from a gradient rather than HTML text with
// `background-clip` — see js/views/notfound.js for why that choice is about
// accessibility rather than about looks.
const SVG_TAGS = new Set([
  "svg",
  "path",
  "circle",
  "line",
  "rect",
  "g",
  "polyline",
  "polygon",
  "text",
  "defs",
  "linearGradient",
  "stop",
]);

// h("button", {class: "btn", onclick: fn}, "Label", childNode)
export function h(tag, props, ...kids) {
  const el = SVG_TAGS.has(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);

  for (const key in props || {}) {
    const val = props[key];
    if (val == null || val === false) continue;
    if (key === "class") el.setAttribute("class", val);
    else if (key === "style" && typeof val === "object") Object.assign(el.style, val);
    else if (key === "dataset") Object.assign(el.dataset, val);
    else if (key.startsWith("on") && typeof val === "function") {
      el.addEventListener(key.slice(2), val);
    } else if (key === "text") el.textContent = val;
    else if (key in el && !SVG_TAGS.has(tag)) el[key] = val;
    else el.setAttribute(key, val === true ? "" : val);
  }

  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

export function clear(el) {
  el.replaceChildren();
}

// Icon from the shared sprite: <use href="./assets/icons.svg#i-name">.
export function icon(name, size = 16) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("class", "icon");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `./assets/icons.svg#i-${name}`);
  s.append(use);
  return s;
}

// — skeletons ---------------------------------------------------------------
/**
 * One grey bar. Trivial, and shared rather than written twice: the post screen
 * draws its loading state out of these and so does the comment thread, and the
 * two stopped being in the same file when the thread moved out.
 * @param {Partial<CSSStyleDeclaration>} [style]
 */
export const skeletonBar = (style) =>
  h("span", { class: "sk", style: { display: "block", ...style } });

export function skeletonCards(n) {
  const tpl = /** @type {HTMLTemplateElement} */ (
    document.getElementById("tpl-skeleton-card")
  );
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) frag.append(tpl.content.cloneNode(true));
  return frag;
}
