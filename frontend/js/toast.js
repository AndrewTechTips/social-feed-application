// @ts-check
// The one way this app interrupts you.
//
// Its own module for a reason that shows up two files away: `api.js` used to
// import this from `ui.js`, which meant the transport layer depended on the
// same module as the vote control and the post card. A toast is a leaf — it
// needs `h` and the live region in index.html and nothing else — so anything
// may depend on it without dragging the interface in behind it.

import { h } from "./dom.js";

/**
 * @param {string} message
 * @param {{ duration?: number }} [options]
 */
export function toast(message, { duration = 4200 } = {}) {
  // The aria-live region, likewise from index.html.
  const host = /** @type {HTMLElement} */ (document.getElementById("toasts"));
  const el = h("div", { class: "toast" }, message);
  host.append(el);
  while (host.children.length > 3) host.firstElementChild?.remove();

  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add("toast--leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // belt and braces if animationend is skipped
  };
  const timer = setTimeout(remove, duration);
  el.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });
  return remove;
}
