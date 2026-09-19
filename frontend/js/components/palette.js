// @ts-check
// The command palette — ⌘K, or Ctrl-K.
//
// Two habits borrowed, and deliberately nothing else:
//
//   Raycast — one flat list. No categories, no section headers, no "Actions"
//   and "Results" split. Categories are a way of organising a list that has got
//   too long; the honest fix is a list that hasn't.
//
//   Linear — every row shows the key that runs it, so the palette teaches the
//   app while you use it and you stop needing the palette. Which means the keys
//   have to actually work outside it: see wireShortcuts below. A hint for a
//   shortcut that doesn't exist is just decoration.
//
// Not borrowed: fuzzy matching everything in the product. This searches the
// posts already on screen and runs a handful of actions. It doesn't grow.

import { h, toast } from "../ui.js";
import { get, knownPosts } from "../store.js";
import { otherTheme, toggleTheme, signOut } from "../actions.js";
import { navigate, currentPath } from "../router.js";
import { focusCursor, hasCards, hasOnward, readOn, typing } from "./feedkeys.js";

const MAX_POSTS = 7; // a palette you scroll is a list, not a palette

let open = false;
let lastFocused = null;

// — the things it does --------------------------------------------------------
// `key` is a real global shortcut (see wireShortcuts); rows without one show ↵,
// which is true of every row. `owned` marks the one row whose keys are
// registered by the control they belong to rather than here — the promise the
// hints make is that the key works, not that this file is what makes it work.
/** @returns {import("../types.js").Command[]} */
function commands() {
  const signedIn = !!get("session");
  const onPost = /^\/posts\/\d+$/.test(currentPath());

  const rows = [
    {
      id: "compose",
      label: "Write a post",
      key: "N",
      run: () => navigate("/compose"),
    },
    {
      id: "theme",
      label: `Switch to the ${otherTheme()} theme`,
      key: "T",
      run: toggleTheme,
      // The label names the theme it's switching to, so it has to be rebuilt
      // rather than cached between openings.
    },
    {
      id: "feed",
      label: "Go to the feed",
      key: "G",
      run: () => navigate("/"),
    },
    // Always, not only when there is something on it. The header link appears
    // with the first save, so without this row there is nowhere at all to
    // learn that the shelf exists — and the empty state it leads to is an
    // invitation rather than an apology.
    {
      id: "shelf",
      label: "Open your shelf",
      run: () => navigate("/shelf"),
    },
    // Only where there's a list to move through, which is the feed and a
    // profile. j and k are a pair everyone who knows one knows the other, so
    // the chip shows both; Enter and u follow from having a card focused.
    hasCards() && {
      id: "feedkeys",
      label: "Move through the feed",
      key: "J K",
      owned: true,
      run: focusCursor,
    },
    // The other end of the same pair. On a post there is no cursor to move, but
    // there is a list to move along — so the keys keep their meaning and the
    // palette keeps its promise that what it shows you works outside it.
    // Enter takes the next one, and settles for the previous at the end of the
    // list, which is the only place "next" has nowhere to go.
    !hasCards() && hasOnward() && {
      id: "onward",
      label: "Move to the next or previous post",
      key: "J K",
      owned: true,
      run: () => {
        readOn("next") || readOn("prev");
      },
    },
    onPost && {
      id: "copy",
      label: "Copy a link to this post",
      key: "C",
      run: copyLink,
    },
    signedIn
      ? { id: "signout", label: "Sign out", run: signOut }
      : { id: "signin", label: "Sign in", run: () => navigate("/login") },
    // The `&&` guards leave a literal false in the list when they don't
    // apply; filter(Boolean) drops it. The checker can't follow that on its
    // own, so the cast says what the filter did.
  ];
  return /** @type {import("../types.js").Command[]} */ (rows.filter(Boolean));
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied.");
  } catch (e) {
    // Clipboard access needs a secure context and, in some browsers, a
    // permission. Say so rather than failing silently.
    toast("Couldn't copy the link.");
  }
}

// — matching ------------------------------------------------------------------
// Plain case-insensitive substring, on purpose. Fuzzy matching earns its keep
// over hundreds of commands; over half a dozen it mostly produces surprising
// results.
const matches = (text, query) => text.toLowerCase().includes(query);

function rowsFor(query) {
  const q = query.trim().toLowerCase();
  const actions = commands().filter((c) => !q || matches(c.label, q));
  /** @type {import("../types.js").Command[]} */
  const posts = (q ? knownPosts().filter((p) => matches(p.title, q)) : [])
    .slice(0, MAX_POSTS)
    .map((p) => ({
      id: `post-${p.id}`,
      label: p.title,
      post: true,
      run: () => navigate(`/posts/${p.id}`),
    }));

  // Actions first: they're the fixed furniture, and a reader who typed two
  // letters expecting "Write a post" shouldn't have it move under a post title.
  return [...actions, ...posts];
}

// The sprite has no search glyph — the header draws its own inline — so this
// draws the same one rather than adding a sprite entry used in two places.
const searchGlyph = () =>
  h(
    "svg",
    { class: "palette__glyph", viewBox: "0 0 20 20", width: 16, height: 16, "aria-hidden": "true" },
    h("circle", { cx: 9, cy: 9, r: 6, fill: "none", stroke: "currentColor", "stroke-width": 1.7 }),
    h("line", {
      x1: 13.5, y1: 13.5, x2: 18, y2: 18,
      stroke: "currentColor", "stroke-width": 1.7, "stroke-linecap": "round",
    })
  );

// — the overlay ---------------------------------------------------------------
function build() {
  const input = h("input", {
    class: "palette__input",
    type: "text",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "palette-list",
    "aria-autocomplete": "list",
    "aria-label": "Search posts and commands",
    placeholder: "Search posts, or type a command",
    autocomplete: "off",
    spellcheck: "false",
  });

  const list = h("ul", {
    class: "palette__list",
    id: "palette-list",
    role: "listbox",
    "aria-label": "Results",
  });

  const empty = h("p", { class: "palette__empty", hidden: true }, "Nothing matches that.");

  const panel = h(
    "div",
    {
      class: "palette__panel",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Commands",
    },
    h("div", { class: "palette__field" }, searchGlyph(), input),
    list,
    empty
  );

  const overlay = h("div", { class: "palette", hidden: true }, panel);

  let rows = [];
  let active = 0;

  const paint = () => {
    rows = rowsFor(input.value);
    active = 0;
    list.replaceChildren(
      ...rows.map((row, i) =>
        h(
          "li",
          {
            class: "palette__row",
            id: `palette-row-${i}`,
            role: "option",
            "aria-selected": String(i === 0),
          },
          h("span", { class: "palette__label" }, row.label),
          h("kbd", { class: "palette__key" }, row.key || "↵")
        )
      )
    );
    empty.hidden = rows.length > 0;
    highlight(0);
  };

  const highlight = (next) => {
    const items = [...list.children];
    if (!items.length) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    active = (next + items.length) % items.length;
    items.forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
    input.setAttribute("aria-activedescendant", `palette-row-${active}`);
    items[active].scrollIntoView({ block: "nearest" });
  };

  const runActive = () => {
    const row = rows[active];
    if (!row) return;
    close();
    row.run();
  };

  input.addEventListener("input", paint);

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight(active - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runActive();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      // The input is the only focusable thing in here, so Tab has nowhere
      // useful to go — keep it rather than letting focus escape behind the
      // overlay.
      e.preventDefault();
    }
  });

  list.addEventListener("click", (e) => {
    const li = e.target.closest(".palette__row");
    if (!li) return;
    highlight([...list.children].indexOf(li));
    runActive();
  });
  // Pointer hover moves the selection, so clicking never runs a different row
  // than the one under the cursor.
  list.addEventListener("mousemove", (e) => {
    const li = e.target.closest(".palette__row");
    if (li) highlight([...list.children].indexOf(li));
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });

  return { overlay, input, paint };
}

let parts = null;

export function openPalette() {
  if (open) return;
  if (!parts) return;
  lastFocused = document.activeElement;
  open = true;
  parts.overlay.hidden = false;
  parts.input.value = "";
  parts.paint();
  parts.input.focus();
}

export function close() {
  if (!open) return;
  open = false;
  parts.overlay.hidden = true;
  // Give focus back to wherever it was, the same way the delete confirm does.
  if (lastFocused && lastFocused.isConnected) lastFocused.focus();
  lastFocused = null;
}

export const isOpen = () => open;

// — keyboard ------------------------------------------------------------------
// `typing` is imported rather than declared twice: the feed cursor needs the
// identical guard, and two copies of a rule about which keys belong to the
// page is how they drift apart.

function wireShortcuts() {
  addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key.toLowerCase() === "k") {
      e.preventDefault();
      open ? close() : openPalette();
      return;
    }
    if (open) return; // the panel's own handler owns everything else
    if (meta || e.altKey || typing(e.target)) return;

    // The single keys the palette advertises. They have to work out here, or
    // the hints beside each row are a lie.
    const row = commands().find(
      (c) => c.key && !c.owned && c.key.toLowerCase() === e.key.toLowerCase()
    );
    if (!row) return;
    e.preventDefault();
    row.run();
  });
}

export function mountPalette() {
  parts = build();
  document.body.append(parts.overlay);
  wireShortcuts();
}
