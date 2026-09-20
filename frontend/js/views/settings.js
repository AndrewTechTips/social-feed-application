// @ts-check
// Settings (#/settings) — your account, this browser, and what Commons is.
//
// ── three parts, and the line between them ────────────────────────────────
// The screen used to be one list of four blocks about an account. It is three
// numbered parts now, and the division is not cosmetic — it is the answer to
// "who does this belong to":
//
//   1 · Your account   lives on the server, follows you to another machine
//   2 · This browser   lives on this disk, and has never been anywhere else
//   3 · About          neither; what the app is and where to read more
//
// A reader who wants to know what Commons keeps about them can answer it by
// reading part 2, and the answer is complete. That is the whole reason the
// parts are numbered rather than just spaced apart.
//
// ── what is still deliberately not here ───────────────────────────────────
// **Preferences.** Theme, text size and focus mode belong to the browser
// rather than to the account, and they live where you are when you want them
// rather than on a screen you have to go and find. Part 2 lists them as
// *stored data*, with a control that forgets them — which is a different
// thing from a control that sets them, and is the only reason they are named
// on this screen at all.
//
// **The email and the password.** Changing either is a flow with a
// confirmation in it — a link to an address, a current password to prove the
// session isn't borrowed — and this project has no way to send mail. A text
// box that pretended otherwise would be worse than the absence, so the
// absence says so out loud.
//
// ── signed in only, for now ───────────────────────────────────────────────
// The screen still turns a signed-out reader away, because it opens by asking
// /users/me for the email. Part 2 would make sense without an account — a
// shelf, a draft and a reading history all exist before you have one — and
// there is an argument for splitting the load so it does. There is no door to
// here signed out, so nobody meets the wall; it is written down rather than
// fixed.

import { api, ApiError, forgetPendingRefresh } from "../api.js";
import { h } from "../dom.js";
import { toast } from "../toast.js";
import { mountView } from "../view.js";
import { get, setSession, clearSession, dropFeedCache } from "../store.js";
import { navigate, forgetCurrentScreen, onLeavingScreen } from "../router.js";
import {
  inventory,
  anythingToForget,
  saySize,
  forgetEverything,
} from "../browserdata.js";
import { openPalette } from "../components/palette.js";

// Mirrors schemas.USERNAME_RE. Case-insensitive, because the server folds what
// it is given rather than refusing it — so ADA is offered and `ada` is stored,
// and the field says so by putting the folded name back afterwards.
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{2,19}$/;
const USERNAME_HINT = "3–20 characters: letters, digits, - and _";

/**
 * One of the three numbered parts. The number is drawn separately from the
 * word so it can be set in the meta face without being read out twice — the
 * heading a screen reader hears is "Your account", not "1 Your account".
 *
 * @param {number} n @param {string} title @param {string} blurb
 */
function group(n, title, blurb, ...body) {
  return h(
    "section",
    { class: "settings__group" },
    h(
      "h2",
      { class: "settings__group-head" },
      h("span", { class: "settings__group-n", "aria-hidden": "true" }, String(n)),
      title
    ),
    blurb ? h("p", { class: "settings__group-blurb" }, blurb) : null,
    ...body
  );
}

/**
 * A titled block inside a part. An h3 now rather than an h2: the parts above
 * took the level, and a heading order that skips is the commonest thing axe
 * finds on a page that grew a layer.
 */
function section(title, blurb, ...body) {
  return h(
    "section",
    { class: "settings__section" },
    h("h3", { class: "settings__heading" }, title),
    blurb ? h("p", { class: "settings__blurb" }, blurb) : null,
    ...body
  );
}

// ── your name ──────────────────────────────────────────────────────────────
function nameSection(me) {
  const input = h("input", {
    id: "settings-username",
    class: "input",
    type: "text",
    autocomplete: "username",
    value: me.username,
    "aria-describedby": "settings-username-err",
  });
  const err = h("p", {
    class: "field__error",
    id: "settings-username-err",
    role: "alert",
  });
  const save = h("button", { class: "btn btn--primary", type: "submit" }, "Save name");

  const form = h(
    "form",
    { class: "settings__form", novalidate: true },
    h(
      "div",
      { class: "field" },
      h("label", { class: "field__label", for: "settings-username" }, "Username"),
      input,
      err,
      h("p", { class: "field__label" }, USERNAME_HINT)
    ),
    save
  );

  let pending = false;
  const setError = (msg) => {
    err.textContent = msg || "";
    input.setAttribute("aria-invalid", msg ? "true" : "false");
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pending) return;
    const wanted = input.value.trim();

    if (!wanted) return (setError("Pick a username."), input.focus());
    if (!USERNAME_RE.test(wanted)) {
      setError(USERNAME_HINT + ", starting with a letter.");
      return input.focus();
    }
    setError("");

    pending = true;
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const updated = await api.patch("/users/me", { username: wanted });
      // The session in the store is what the header draws from, so it has to
      // move too — otherwise the name at the top of the page stays the old one
      // until the next reload, on the one screen where that is most obviously
      // wrong.
      setSession({ id: updated.id, username: updated.username });
      // Every card in the cache carries the author's name as it was fetched.
      // Cheaper and more honest to throw the page away than to walk it
      // patching a name that the next fetch will bring back correct anyway.
      dropFeedCache();
      input.value = updated.username;
      toast(`You're ${updated.username} now.`);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 409) {
        setError("That username is taken.");
        input.focus();
      } else if (status === 422) {
        setError(USERNAME_HINT + ", starting with a letter.");
        input.focus();
      } else if (status !== 401) {
        // 401 is already handled for us: the client has shown a toast and sent
        // the reader to the sign-in screen, and a second message about a
        // username would be about the wrong problem.
        setError("That didn't save. Try again?");
      }
    } finally {
      pending = false;
      save.disabled = false;
      save.textContent = "Save name";
    }
  });

  return section(
    "Your name",
    "What everybody else sees. Change it whenever you like — your posts, comments and votes come with you, because they're joined to your account rather than to your name.",
    form
  );
}

// ── the credential half, and why it isn't here ─────────────────────────────
function emailSection(me) {
  return section(
    "Your email",
    "Only you ever see this — it never appears on a post or a profile.",
    h("p", { class: "settings__value" }, me.email),
    h(
      "p",
      { class: "settings__note" },
      "You can't change it here. Moving an account to a new address means sending a confirmation link to it, and Commons has no way to send mail — so it isn't offered rather than half-offered."
    )
  );
}

// ── sign out everywhere ────────────────────────────────────────────────────
function sessionsSection() {
  const button = h(
    "button",
    { class: "btn btn--quiet", type: "button" },
    "Sign out everywhere"
  );

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Signing out…";
    try {
      await api.post("/auth/logout-all", undefined);
      // This browser is one of the everywhere.
      forgetPendingRefresh();
      clearSession();
      dropFeedCache();
      toast("Signed out on every device.");
      forgetCurrentScreen();
      navigate("/");
    } catch (error) {
      button.disabled = false;
      button.textContent = "Sign out everywhere";
      if (!(error instanceof ApiError) || error.status !== 401) {
        toast("That didn't go through. Try again?");
      }
    }
  });

  return section(
    "Signed in elsewhere",
    "Ends every session on every device, including this one. Worth doing if you've signed in on a machine you don't have any more.",
    button
  );
}

// ── delete ─────────────────────────────────────────────────────────────────
function dangerSection(me) {
  const open = h(
    "button",
    { class: "btn btn--quiet danger", type: "button" },
    "Delete your account"
  );
  const slot = h("div", { class: "settings__confirm" });

  const confirm = () => {
    const input = h("input", {
      id: "settings-confirm",
      class: "input",
      type: "text",
      autocomplete: "off",
      "aria-describedby": "settings-confirm-hint",
    });
    const go = h(
      "button",
      { class: "btn btn--danger", type: "submit", disabled: true },
      "Delete my account"
    );
    const cancel = h("button", { class: "btn btn--quiet", type: "button" }, "Keep it");

    const form = h(
      "form",
      { class: "settings__form", novalidate: true },
      h(
        "div",
        { class: "field" },
        h(
          "label",
          { class: "field__label", for: "settings-confirm" },
          `Type ${me.username} to confirm`
        ),
        input,
        // Not a hoop for its own sake. Typing your own name is the one
        // confirmation that can't be cleared by a reflex, because the button
        // stays dead until the thing you typed matches.
        h(
          "p",
          { class: "field__label", id: "settings-confirm-hint" },
          "This deletes your posts, your comments and your votes. It can't be undone."
        )
      ),
      h("div", { class: "settings__row" }, go, cancel)
    );

    input.addEventListener("input", () => {
      go.disabled = input.value.trim().toLowerCase() !== me.username;
    });

    cancel.addEventListener("click", () => {
      slot.replaceChildren(open);
      open.focus();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      go.disabled = true;
      go.textContent = "Deleting…";
      try {
        await api.del("/users/me");
        forgetPendingRefresh();
        clearSession();
        dropFeedCache();
        toast("Your account is gone. Thanks for reading.");
        forgetCurrentScreen();
        navigate("/");
      } catch (error) {
        go.disabled = false;
        go.textContent = "Delete my account";
        if (!(error instanceof ApiError) || error.status !== 401) {
          toast("That didn't go through. Try again?");
        }
      }
    });

    return form;
  };

  open.addEventListener("click", () => {
    const form = confirm();
    slot.replaceChildren(form);
    // The field is the next thing to do, and moving focus into it is also what
    // tells a screen reader that something appeared.
    /** @type {HTMLElement | null} */ (form.querySelector("input"))?.focus();
  });

  slot.append(open);

  return section(
    "Leaving",
    "Everything you wrote goes with you: your posts, the comments under them, the comments you left elsewhere, and your votes. Nothing is kept and nothing is recoverable.",
    slot
  );
}

// ── 2 · this browser ───────────────────────────────────────────────────────
// The data panel. js/browserdata.js owns what the rows *are*; this owns what
// they look like and what pressing one feels like.
//
// **It repaints itself, and that is the requirement rather than a detail.** A
// privacy control that says "Forgotten" while the line above still reads "47
// posts" has not been believed by anybody. So every control ends by rebuilding
// the whole list from `inventory()`, which is recomputed from storage — the
// panel never holds a number it was told, only numbers it has just read.
//
// The row that just changed keeps focus. It is a list of buttons and pressing
// one destroys and rebuilds it, so without this focus would fall to the body
// and a keyboard reader would be back at the top of the page for each control
// they used.

/** One line under a row, replacing the control once it has been used. */
function said(words) {
  return h("p", { class: "data__said", role: "status" }, words);
}

function dataPanel() {
  const list = h("ul", { class: "data" });
  const foot = h("div", { class: "data__foot" });

  /** @param {string | null} keepFocusOn a row id whose control should keep focus */
  function paint(keepFocusOn = null) {
    list.replaceChildren(...inventory().map((row) => line(row)));
    foot.replaceChildren(sweep());
    if (!keepFocusOn) return;
    // The control is gone once it has been used — there is nothing left to
    // forget — so focus goes to the row itself, which is why the <li> is
    // focusable. The reader hears the row's new state rather than silence.
    const li = list.querySelector(`[data-row="${keepFocusOn}"]`);
    if (li instanceof HTMLElement) li.focus();
  }

  /** @param {import("../browserdata.js").DataRow} row */
  function line(row) {
    const li = h("li", {
      class: "data__row",
      dataset: { row: row.id },
      tabindex: "-1",
    });

    const control = row.action
      ? h("button", { class: "btn btn--quiet data__do", type: "button" }, row.action)
      : null;

    if (control) {
      control.addEventListener("click", async () => {
        control.disabled = true;
        const was = control.textContent;
        control.textContent = "Working…";
        // `run` is sometimes synchronous and sometimes a round trip to the
        // server; awaiting covers both, and the only one that can answer
        // false is the shelf, which has an account's copy to clear as well.
        const ok = (await row.run?.()) !== false;
        if (!ok) {
          control.disabled = false;
          control.textContent = was;
          toast("Couldn't empty your shelf. Try again?");
          return;
        }
        paint(row.id);
        toast(row.done || "Done.");
      });
    }

    li.append(
      h(
        "div",
        { class: "data__head" },
        // h3, not h4. The rows sit directly under the part's h2 with nothing
        // between them, so an h4 skips a level — which the unfiltered axe
        // scan in settings.spec.js catches as heading-order and which a
        // screen reader's heading list reads as a missing layer. The sections
        // in part 1 are h3s for the same reason; these are their peers.
        h("h3", { class: "data__title" }, row.title),
        h("p", { class: "data__what" }, row.what),
        // The size is the quiet half of the honesty: a number beside a name is
        // what turns "we keep your reading history" into something a person
        // can weigh.
        h("p", { class: "data__size" }, saySize(row.bytes))
      ),
      h("p", { class: "data__why" }, row.why),
      // The keys themselves, because a panel about storage that would not say
      // what it is called is asking to be taken on trust — and the whole point
      // is that this one can be checked in the browser's own inspector.
      h(
        "p",
        { class: "data__keys" },
        ...row.keys.map((key) => h("code", { class: "data__key" }, key))
      )
    );
    // Appended separately, and guarded. `h()` drops a null child; this is
    // `Element.append`, which stringifies one — so passing the absent control
    // straight in printed the word "null" under the sign-in row.
    //
    // No filler in its place, either. The first version put "Nothing stored"
    // there, which was two different claims wearing one label: on an empty row
    // it was true, and on the sign-in row — no control by design, 51 bytes of
    // identity behind it — it was flatly false, sitting directly under the
    // size that contradicted it. The row already says what it holds, twice.
    if (control) li.append(control);
    return li;
  }

  /** The one at the bottom. */
  function sweep() {
    const slot = h("div", { class: "data__sweep" });

    const open = h(
      "button",
      { class: "btn btn--quiet danger", type: "button" },
      "Forget everything on this browser"
    );

    const ask = () => {
      const go = h(
        "button",
        { class: "btn btn--danger", type: "button" },
        "Yes, forget it all"
      );
      const no = h("button", { class: "btn btn--quiet", type: "button" }, "Keep it");

      no.addEventListener("click", () => {
        slot.replaceChildren(open);
        open.focus();
      });

      go.addEventListener("click", async () => {
        go.disabled = true;
        no.disabled = true;
        go.textContent = "Forgetting…";
        const ok = await forgetEverything();
        paint();
        toast(
          ok
            ? "Forgotten. This browser is holding nothing of yours."
            : "Cleared here, but your shelf wouldn't empty on the server."
        );
        // paint() has already rebuilt the foot, so there is nothing left of
        // this confirm to put focus back into.
        /** @type {HTMLElement | null} */
        (foot.querySelector(".data__sweep .btn"))?.focus();
      });

      return h(
        "div",
        { class: "settings__confirm" },
        h(
          "p",
          { class: "data__ask" },
          "This clears everything listed above: what you've read, your shelf, " +
            "a saved draft and how you like to read. It leaves you signed in, " +
            "and it does not touch anything on your account except the shelf."
        ),
        h("div", { class: "settings__row" }, go, no)
      );
    };

    open.addEventListener("click", () => {
      const confirm = ask();
      slot.replaceChildren(confirm);
      /** @type {HTMLElement | null} */ (
        confirm.querySelector(".btn--danger")
      )?.focus();
    });

    // Nothing to forget, nothing to press. The same rule the install control
    // is built on: a control that cannot do anything should not be on screen.
    if (anythingToForget()) slot.append(open);
    else slot.append(said("This browser is holding nothing of yours."));

    return slot;
  }

  // — kept honest from the outside ---------------------------------------
  //
  // Repainting after its own controls is not enough. Every one of these can
  // be changed from somewhere that is not this panel while this panel is on
  // screen: the theme from the header toggle or the palette, the size and the
  // measure from a post's reader panel, the shelf from another tab's sync.
  // A list whose whole claim is "this is what is stored" cannot be the last
  // thing on the page to find out, so it listens to the same events those
  // controls already announce themselves with.
  //
  // Focus is put back where it was. A repaint destroys the rows, so without
  // this a reader who had tabbed to a control would lose it to the body
  // because something unrelated changed a colour.
  const repaint = () => {
    const active = document.activeElement;
    const row = active instanceof HTMLElement ? active.closest("[data-row]") : null;
    paint();
    if (!(row instanceof HTMLElement)) return;
    const again = list.querySelector(`[data-row="${row.dataset.row}"]`);
    const control = again?.querySelector(".data__do");
    if (control instanceof HTMLElement) control.focus();
    else if (again instanceof HTMLElement) again.focus();
  };

  for (const event of [
    "commons:theme",
    "commons:textsize",
    "commons:measure",
    "commons:shelf",
    "commons:read",
  ]) {
    addEventListener(event, repaint);
  }
  // The screen is rebuilt from scratch on every visit, so these would
  // otherwise accumulate one set per visit for the life of the tab.
  onLeavingScreen(() => {
    for (const event of [
      "commons:theme",
      "commons:textsize",
      "commons:measure",
      "commons:shelf",
      "commons:read",
    ]) {
      removeEventListener(event, repaint);
    }
  });

  paint();

  return group(
    2,
    "This browser",
    "Everything below is on this machine and has never been sent anywhere. " +
      "This is the whole list, and each line can be checked against your " +
      "browser's own storage inspector.",
    list,
    foot
  );
}

// ── 3 · about ──────────────────────────────────────────────────────────────
// Two links and nothing else, for now. The plan puts the install state, the
// version and the offline state here as its own later step; what is here is
// what already exists and can be linked to honestly today. An empty third
// part would have been worse than three parts where one is short — the
// numbering is a promise about what the screen covers, and a heading with
// nothing under it breaks it.
function aboutGroup() {
  const keys = h(
    "button",
    { class: "btn btn--quiet", type: "button" },
    "Keyboard shortcuts"
  );
  // The palette *is* the list of shortcuts — every row shows the key that
  // runs it — so this opens that rather than printing a second copy that
  // could go stale. The colophon makes the same choice for the same reason.
  keys.addEventListener("click", openPalette);

  return group(
    3,
    "About",
    "What Commons is, and how it was put together.",
    h(
      "div",
      { class: "settings__row" },
      h("a", { class: "btn btn--quiet", href: "#/colophon" }, "Read the colophon"),
      keys
    )
  );
}

// Built twice — once under the loading line and once under the real screen —
// so that the title doesn't arrive after the page it titles.
const head = () =>
  h(
    "header",
    { class: "settings__head" },
    h("h1", { class: "settings__title" }, "Settings"),
    h(
      "p",
      { class: "settings__line" },
      "Your account, and what this browser is keeping."
    )
  );

export async function renderSettings({ isStale }) {
  if (!get("session")) return navigate("/login");

  const root = h(
    "section",
    { class: "settings", "aria-label": "Settings" },
    head(),
    h("p", { class: "settings__loading" }, "Loading…")
  );
  mountView(root);

  // Asked for rather than read from the store: the store holds the id and the
  // username because that is all the header needs, and this screen also shows
  // the email — which only ever comes back from /users/me.
  let me;
  try {
    me = await api.get("/users/me");
  } catch (error) {
    if (isStale()) return;
    // A 401 has already sent the reader to sign in; anything else leaves them
    // on a screen that has to say something.
    if (error instanceof ApiError && error.status === 401) return;
    root.replaceChildren(
      h(
        "p",
        { class: "settings__loading" },
        "Couldn't load your account. Reload to try again."
      )
    );
    return;
  }
  if (isStale()) return;

  root.replaceChildren(
    head(),
    group(
      1,
      "Your account",
      "This half lives on the server and follows you to any machine you sign " +
        "in on. It runs from the reversible to the permanent.",
      nameSection(me),
      emailSection(me),
      sessionsSection(),
      dangerSection(me)
    ),
    dataPanel(),
    aboutGroup()
  );
}
