// @ts-check
// The scroll indicator, for the engines that cannot draw it themselves.
//
// `.progress` — the amber hairline on the header's bottom edge — is a CSS
// scroll-driven animation wherever `animation-timeline: scroll()` exists, and
// that path is the one to want: the browser hands the animation the document's
// own scroll progress, so the bar is exact by construction, cannot drift out of
// step with the page, and never involves this thread at all.
//
// This file is the other case, and nothing more. It exists because base.css
// hides the native scrollbar on *every* engine now, including the ones with no
// scroll timelines, and a hidden scrollbar with no bar beside it is a page with
// no way to see where you are in it. Every Safari before 26 is in that set, so
// this is not a theoretical branch — until recently it was every iPhone.
//
// ── why it is written the way it is ────────────────────────────────────────
// A scroll handler is the easiest thing in the browser to make janky, and all
// three of the usual mistakes are avoidable:
//
//   · **It never blocks the scroll.** The listener is `{ passive: true }`, so
//     the browser knows ahead of time that nothing here will call
//     `preventDefault()` and can keep scrolling on the compositor instead of
//     waiting to find out. Without it, every wheel tick and every finger move
//     waits on this thread first — the classic "catchy" scroll.
//
//   · **It never runs more than once a frame.** Scroll events fire faster than
//     the screen redraws, and often in bursts. The handler does nothing but
//     raise a flag; one `requestAnimationFrame` per frame does the work, so a
//     burst of thirty events costs one write, timed to the frame that will
//     actually paint it.
//
//   · **It never reads layout inside the write.** `scrollTop`, `scrollHeight`
//     and `clientHeight` are all read together, at the top of the frame, before
//     anything is written. Interleaving a read after a write is what forces a
//     synchronous re-layout per frame.
//
// And what it writes is a `transform`, the same `scaleX` the CSS path animates
// — a compositor property. Writing `width` or `inset-inline-end` instead would
// re-lay-out and repaint the header on every frame of every scroll, which is
// the shape of this bug most people ship.

/**
 * Draw the scroll indicator from script, on engines without scroll timelines.
 *
 * A no-op where CSS already does it — the check is the same feature query
 * chrome.css gates the animation on, so exactly one of the two paths is ever
 * live and they cannot fight over the element's transform.
 *
 * @returns {void}
 */
export function startScrollProgress() {
  // The CSS path is in charge here. Returning leaves the element's transform
  // entirely to the animation: an inline style written from here would be a
  // higher-priority declaration than the animation's, and would freeze the bar.
  if (CSS.supports("animation-timeline", "scroll()")) return;

  const bar = /** @type {HTMLElement | null} */ (document.querySelector(".progress"));
  if (!bar) return;

  const root = document.documentElement;
  let queued = false;

  const draw = () => {
    queued = false;
    // Read everything first, write after. See the note above.
    const max = root.scrollHeight - root.clientHeight;
    const top = root.scrollTop;
    // A page that fits gets `scaleX(0)` rather than a division by zero — the
    // same nothing the CSS path draws when its timeline is inactive.
    const progress = max > 0 ? Math.min(1, Math.max(0, top / max)) : 0;
    bar.style.transform = `scaleX(${progress})`;
  };

  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(draw);
  };

  addEventListener("scroll", schedule, { passive: true });
  // The page changing length is the other way the bar goes wrong, and it has
  // nothing to do with scrolling: a view swap, a feed appending its next page,
  // an image arriving, the window turning sideways. `scroll` never fires for
  // any of those, and the fraction is different afterwards.
  addEventListener("resize", schedule, { passive: true });
  new ResizeObserver(schedule).observe(document.body);

  draw();
}
