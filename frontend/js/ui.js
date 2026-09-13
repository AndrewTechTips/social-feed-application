// Small shared UI helpers: a hyperscript builder, toasts, relative time,
// initials avatars, skeletons, the view-mount routine, and the vote control
// (shared by the feed and the post page).

import { api } from "./api.js";
import { get, hasVoted, setVoted } from "./store.js";
import { tryTransition } from "./transitions.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "path", "circle", "line", "rect", "g", "polyline", "polygon"]);

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
  s.setAttribute("width", size);
  s.setAttribute("height", size);
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `./assets/icons.svg#i-${name}`);
  s.append(use);
  return s;
}

// — view mounting ---------------------------------------------------------------
const viewEl = () => document.getElementById("view");

export function mountView(node, { restoreScroll } = {}) {
  const view = viewEl();

  const swap = () => {
    view.replaceChildren(node);
    if (typeof restoreScroll === "number") window.scrollTo(0, restoreScroll);
    else window.scrollTo(0, 0);
  };

  // Not on the very first paint. There's nothing on screen to travel from, so
  // the transition would have nothing to say — and while one runs the document
  // is covered by its snapshot and doesn't take clicks, which is a strange
  // couple of hundred milliseconds to hand someone who has only just arrived.
  const replacingAView = view.childElementCount > 0;

  // A transition and the cross-fade at the same time reads as a stutter, so
  // exactly one of them runs.
  if (!(replacingAView && tryTransition(swap))) {
    swap();
    node.classList.add("route-enter");
    node.addEventListener(
      "animationend",
      () => node.classList.remove("route-enter"),
      { once: true }
    );
  }

  // Move focus to the top of the new screen for keyboard + screen-reader users —
  // unless they're typing in the header search, which drives feed re-renders.
  if (document.activeElement !== document.getElementById("search-input")) {
    view.focus({ preventScroll: true });
  }
}

// — toasts (aria-live region lives in index.html) --------------------------
export function toast(message, { duration = 4200 } = {}) {
  const host = document.getElementById("toasts");
  const el = h("div", { class: "toast" }, message);
  host.append(el);
  while (host.children.length > 3) host.firstElementChild.remove();

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

// — time ----------------------------------------------------------------------
const MIN = 60,
  HOUR = 3600,
  DAY = 86400;

export function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  if (secs < 90) return "a minute ago";
  if (secs < HOUR) return `${Math.round(secs / MIN)}m ago`;
  if (secs < DAY) return `${Math.round(secs / HOUR)}h ago`;
  if (secs < 7 * DAY) return `${Math.round(secs / DAY)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: secs > 330 * DAY ? "numeric" : undefined,
  });
}

export function fullTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function wasEdited(post) {
  return post.updated_at && post.created_at && post.updated_at !== post.created_at;
}

// — initials avatar (no image fetch, quiet deterministic tint) -----------
export function initials(email) {
  const local = String(email || "").split("@")[0];
  const parts = local.split(/[^a-z0-9]+/i).filter(Boolean);
  const pick =
    parts.length >= 2
      ? parts[0][0] + parts[1][0]
      : (local.replace(/[^a-z0-9]/gi, "") || "?").slice(0, 2);
  return pick.toUpperCase();
}

function hueFor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

export function avatar(email, variant) {
  return h(
    "span",
    {
      class: "avatar" + (variant ? ` avatar--${variant}` : ""),
      style: { "--h": hueFor(String(email || "")) },
      "aria-hidden": "true",
    },
    initials(email)
  );
}

// — skeletons ---------------------------------------------------------------
export function skeletonCards(n) {
  const tpl = document.getElementById("tpl-skeleton-card");
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) frag.append(tpl.content.cloneNode(true));
  return frag;
}

// — vote control (optimistic) ---------------------------------------------
export function voteControl(post, { inline = false } = {}) {
  let count = Math.max(0, post.votes || 0);
  let on = hasVoted(post.id);
  let busy = false;

  const label = (o, n) =>
    (o ? "Remove your upvote, now " : "Upvote, now ") + n + (n === 1 ? " vote" : " votes");

  const caret = h(
    "svg",
    { class: "vote__caret", viewBox: "0 0 16 16", width: 15, height: 15, "aria-hidden": "true" },
    h("path", { d: "M8 3 L14 12.5 L2 12.5 Z" })
  );
  const num = h("span", { class: "vote__count" }, String(count));
  const btn = h(
    "button",
    {
      class:
        "vote" + (inline ? " vote--inline" : "") + (on ? " vote--on" : ""),
      type: "button",
      "aria-pressed": String(on),
      "aria-busy": "false",
      "aria-label": label(on, count),
    },
    caret,
    num
  );

  const paint = () => {
    btn.classList.toggle("vote--on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.setAttribute("aria-label", label(on, count));
    num.textContent = String(count);
  };

  btn.addEventListener("click", async () => {
    if (busy) return;
    if (!get("session")) {
      toast("Sign in to upvote.");
      return;
    }
    const next = !on;
    on = next;
    count = Math.max(0, count + (next ? 1 : -1));
    setVoted(post.id, next);
    paint();
    btn.classList.remove("vote--pulse");
    void btn.offsetWidth; // restart the pop animation
    if (next) btn.classList.add("vote--pulse");

    // A second click while the first is still in flight is ignored — two
    // racing vote calls settle in whichever order the network feels like.
    // aria-busy says so out loud: assistive tech announces it, and it gives a
    // test something to wait on other than a guess about latency.
    busy = true;
    btn.setAttribute("aria-busy", "true");
    try {
      await api.post("/vote/", { post_id: post.id, dir: next ? 1 : 0 });
    } catch (err) {
      // 409 = the server already recorded our upvote; 404 = nothing to remove.
      // Either way we're already in the state we wanted — leave it.
      const benign = (next && err.status === 409) || (!next && err.status === 404);
      if (!benign) {
        on = !next;
        count = Math.max(0, count + (next ? -1 : 1));
        setVoted(post.id, on);
        paint();
        if (err.status !== 401) toast("That vote didn't take. Try again?");
      }
    } finally {
      busy = false;
      btn.setAttribute("aria-busy", "false");
    }
  });

  return btn;
}
