// @ts-check
// A block of DOM that repaints when something outside it changes.
//
// Two features need the same small, slightly subtle thing: a piece of the page
// whose *existence* depends on state that arrives after the page was drawn.
// The install control appears when Chrome decides to fire an event, some time
// after the feed has rendered; the offline notice appears when the network
// goes, which is whenever it likes. Both are empty most of the time, and both
// are built fresh by screens that render repeatedly.
//
// The awkward part is unsubscribing. The feed rebuilds its masthead on every
// render, so a subscription per render would accumulate for as long as the tab
// is open — and the usual fix, handing every screen a teardown to remember, is
// the kind of bookkeeping that is correct until the one path that forgets.
//
// So a watcher names the element it belongs to, and a watcher whose element has
// left the document is dropped on the next pass. Nothing has to remember
// anything: leaving the DOM *is* the unsubscribe.

import { h } from "./dom.js";

/**
 * @template T
 * @typedef {object} Live
 * @property {() => void} notify        repaint every block that is still on the page
 * @property {(build: (state: NonNullable<T>) => (Node | string | null)[], props?: Record<string, any>) => HTMLElement} block
 */

/**
 * @template T
 * @param {() => T} read  the current state; a falsy value means "draw nothing"
 * @returns {Live<T>}
 */
export function live(read) {
  /** @type {Set<{ el: Element, paint: () => void }>} */
  const watchers = new Set();

  const sweep = () => {
    for (const w of watchers) if (!w.el.isConnected) watchers.delete(w);
  };

  const notify = () => {
    sweep();
    for (const w of watchers) {
      try {
        w.paint();
      } catch (e) {
        /* one broken painter is not worth taking the others down with it */
      }
    }
  };

  /**
   * A container that holds whatever `build` makes of the current state, and is
   * `hidden` whenever there is no state worth drawing.
   *
   * It stays in the document while empty rather than being removed, because
   * the whole point is that the thing it holds can arrive later and needs
   * somewhere to arrive.
   */
  const block = (build, props) => {
    const el = h("div", props);
    const paint = () => {
      const state = read();
      el.replaceChildren();
      el.hidden = !state;
      if (state) el.append(...build(state).filter((n) => n != null));
    };
    paint();
    // Pruned here as well as in notify(), so a long run of renders with nothing
    // ever changing cannot grow the set without bound.
    sweep();
    watchers.add({ el, paint });
    return el;
  };

  return { notify, block };
}
