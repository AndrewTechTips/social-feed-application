// @ts-check
// The page's scrollbar, drawn by the app instead of by the browser.
//
// ── why replace something the browser already does ─────────────────────────
// The native one is drawn hard against the edge of the viewport, in whatever
// width the platform picked — 11px of permanently reserved gutter on this
// machine — and the app had to reserve that gutter on every screen forever
// (`scrollbar-gutter: stable`) to stop the layout sliding sideways each time a
// short screen followed a tall one. So it cost a strip of the page, it sat a
// hair from the right-hand edge of the text, and it looked like the operating
// system rather than like this.
//
// This takes no layout width at all. It is `position: fixed`, so the gutter
// and the reflow it was guarding against both stop existing rather than being
// compensated for — see the note in base.css where that reservation used to
// be.
//
// ── what it is, exactly ────────────────────────────────────────────────────
// A rounded thumb in a rail inset from the edge, which fades in while the page
// is moving and fades out about a second after it stops. It is a real
// scrollbar and not a progress decoration: drag the thumb and the page
// follows, press the rail above or below it and the page moves a screen.
//
// It starts below the header rather than at the top of the viewport. The
// header is translucent and sticky, and a thumb sliding underneath it read as
// a bug every time.
//
// ── and what it deliberately is not ────────────────────────────────────────
// **Not the reading bar.** The amber line under the header on a post (`.reading`
// in chrome.css) answers "how much of this piece is left", is drawn by a
// scroll-driven animation with no JavaScript at all, and only exists on a
// post. This answers "where am I in this page" and exists everywhere. They
// are two different questions and they are allowed both.
//
// **Not the only way down a page.** It is `aria-hidden` and takes no focus:
// it duplicates an affordance every browser already gives a keyboard, and a
// tab stop that only repeats the arrow keys is a tab stop in the way. The
// keys, the wheel and a finger are untouched — this draws the position, it
// does not gate reaching it.
//
// **Not shown on a page that fits.** A scrollbar for a screen with nothing
// below the fold is a control that cannot do anything, which is the same rule
// the install block and the data panel's sweep are built on.
//
// ── keeping it cheap ───────────────────────────────────────────────────────
// One passive scroll listener that does nothing but raise a flag and ask for
// a frame; every read and every write happens inside that one frame, so a fast
// scroll paints once per frame rather than once per event. The rail's own
// height is measured on resize rather than on scroll, because it cannot change
// without one and reading it per frame is a layout flush nobody needs. The
// thumb moves on `translate3d` and never on `top`, so the whole thing is a
// composited transform.

import { h } from "./dom.js";
import { motionReduced } from "./transitions.js";

/** How long the page has to hold still before the thumb goes. */
const HIDE_AFTER = 1000;

/** Below this the thumb stops being a handle and becomes a dot. */
const MIN_THUMB = 40;

/** A press on the rail moves this much of a screen — the usual page-up. */
const PAGE = 0.9;

const de = document.documentElement;

/**
 * The OS preference *or* the app's own switch. `motionReduced()` is only the
 * second of those on purpose — see the note on the Motion section in
 * views/settings.js — so a reader who has asked their machine for less motion
 * and never opened Settings still has to be heard here.
 */
const stillness = () =>
  motionReduced() ||
  (typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches);

export function mountScrollbar() {
  const thumb = h("div", { class: "scrollbar__thumb" });
  const rail = h("div", { class: "scrollbar", "aria-hidden": "true" }, thumb);
  document.body.append(rail);

  /** The rail's own height. Only a resize can change it. */
  let railH = 0;
  /** The thumb's height, kept so the drag maths needs no layout read. */
  let thumbH = 0;
  let frame = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idle;
  let held = false;

  function measure() {
    railH = rail.clientHeight;
    paint();
  }

  function paint() {
    frame = 0;
    const viewport = de.clientHeight;
    const total = de.scrollHeight;
    const room = total - viewport;

    // A page that fits has no scrollbar. A class rather than `hidden`, and
    // that is the whole reason the rail is never `display: none` in the
    // stylesheet: the thumb is sized from the rail's own height, so a rail
    // that hid itself here would measure zero on the next pass and could
    // never find its way back.
    if (room <= 1 || railH <= 0) {
      rail.classList.remove("is-live");
      return;
    }
    rail.classList.add("is-live");

    thumbH = Math.max(MIN_THUMB, Math.round((railH * viewport) / total));
    // Clamped rather than trusted: iOS rubber-banding reports a scrollY past
    // both ends of the page, and without this the thumb leaves the rail at
    // the top of a bounce.
    const at = Math.min(1, Math.max(0, window.scrollY / room));
    const y = Math.round((railH - thumbH) * at);
    thumb.style.height = `${thumbH}px`;
    thumb.style.transform = `translate3d(0, ${y}px, 0)`;
  }

  function ask() {
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function wake() {
    rail.classList.add("is-awake");
    clearTimeout(idle);
    // A thumb that vanished from under the finger holding it would be the
    // one moment this must not do its disappearing trick.
    if (held) return;
    idle = setTimeout(() => rail.classList.remove("is-awake"), HIDE_AFTER);
  }

  addEventListener(
    "scroll",
    () => {
      wake();
      ask();
    },
    { passive: true }
  );

  addEventListener("resize", measure);

  // The page's height changes without a scroll and without a resize on nearly
  // every screen here: a view renders, the feed appends a page, a comment
  // opens. Watching the body is what keeps the thumb's size honest through
  // all of that without anything having to remember to tell it.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(ask).observe(document.body);
  }

  // — dragging ---------------------------------------------------------------
  // Pointer capture rather than listeners on the window: the move and the
  // release are delivered to the thumb even when the pointer has left it,
  // which is most of any real drag, and the cleanup is one `releasePointer`
  // rather than a pair of removals that have to match.
  thumb.addEventListener("pointerdown", (e) => {
    if (!(e instanceof PointerEvent) || e.button !== 0) return;
    const from = e.clientY;
    const was = window.scrollY;
    held = true;
    rail.classList.add("is-held");
    wake();
    thumb.setPointerCapture(e.pointerId);
    // Or the press selects the text behind the rail on the way past.
    e.preventDefault();

    const move = (/** @type {PointerEvent} */ ev) => {
      const room = de.scrollHeight - de.clientHeight;
      const travel = railH - thumbH;
      if (travel <= 0 || room <= 0) return;
      window.scrollTo(0, was + ((ev.clientY - from) * room) / travel);
    };
    const drop = () => {
      held = false;
      rail.classList.remove("is-held");
      thumb.removeEventListener("pointermove", move);
      wake();
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", drop, { once: true });
    thumb.addEventListener("pointercancel", drop, { once: true });
  });

  // — pressing the rail ------------------------------------------------------
  // A screen at a time, in the direction of the press, which is what a native
  // scrollbar does and what a hand reaching for the track expects. Smoothly,
  // unless somebody has asked for less motion — the CSS `!important` that
  // flattens `scroll-behavior` under reduced motion cannot reach an explicit
  // `behavior` passed here, so this has to ask for itself.
  rail.addEventListener("pointerdown", (e) => {
    if (e.target !== rail || !(e instanceof PointerEvent) || e.button !== 0) return;
    const above = e.clientY < thumb.getBoundingClientRect().top;
    window.scrollBy({
      top: de.clientHeight * PAGE * (above ? -1 : 1),
      behavior: stillness() ? "auto" : "smooth",
    });
    wake();
  });

  // Shown once at boot without waiting for a scroll, so that a reader who
  // lands on a long feed can see how long it is before touching anything.
  measure();
  wake();
}
