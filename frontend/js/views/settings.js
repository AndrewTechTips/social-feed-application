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
import { themeChoice, themeChoices, setThemeChoice } from "../actions.js";
import {
  textSize,
  textSizes,
  setTextSize,
  measure,
  measures,
  setMeasure,
} from "../reading.js";
import {
  inventory,
  anythingToForget,
  saySize,
  forgetEverything,
} from "../browserdata.js";
import { openPalette } from "../components/palette.js";
import { notifyPrefs, setNotifyPref } from "../notify.js";
import { motionReduced, setMotionReduced } from "../transitions.js";
import { isInstalled, installBlock, installButton, installHowTo } from "../install.js";
import { isOffline } from "../offline.js";
import { radioGroup, toggleSwitch } from "../components/radiogroup.js";

// — keeping the reader's place -----------------------------------------------
//
// **Disabling a focused control hands focus to the body**, so a reader who
// pressed a button with the keyboard is returned to the top of the tab order
// by their own press — and then has to Tab back down a long screen to find
// out what happened. Every button here that says "Saving…" or "Deleting…"
// while it works had this.
//
// Call before disabling; call the result after re-enabling.
//
// Two guards, and both matter. It only puts focus back if the control *had*
// it — otherwise pressing a button with the mouse would yank focus to it for
// no reason. And it only does so if focus is currently nowhere, because a
// reader who has tabbed somewhere else while a request was out has chosen to
// be there, and a slow response should not drag them back.
//
// `isConnected` because a few of these controls are gone by the time their
// own work finishes: the data panel rebuilds its rows, and two of them
// navigate away entirely.
//
/** @param {HTMLElement} el @returns {() => void} */
function keepingFocus(el) {
  const had = document.activeElement === el;
  return () => {
    if (!had || !el.isConnected) return;
    const nowhere =
      !document.activeElement ||
      document.activeElement === document.body ||
      document.activeElement === document.documentElement;
    if (nowhere) el.focus();
  };
}

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
    const restoreFocus = keepingFocus(save);
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
      restoreFocus();
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

// ── taking it with you ─────────────────────────────────────────────────────
//
// A JSON file of everything you have written here: the account, your posts
// including the drafts, and every comment wherever you left it. One request
// to `/users/me/export`, which exists because there is no way to assemble
// this from the public endpoints — they hide unpublished posts, and there is
// no "comments by one person" list at all. See ADR 0013.
//
// **In part 1, not part 2.** Everything in this section is on the server and
// follows you to another machine, which is exactly what this downloads. Part
// 2 is about what is on this disk, and would have been the wrong neighbour:
// the reader who wants their writing and the reader who wants to know what
// is being kept about them are asking two different questions.
//
// It sits above Leaving on purpose. Somebody who has decided to delete their
// account should pass the way to keep a copy on the way to the button that
// throws it away.
function exportSection(me) {
  const button = h(
    "button",
    { class: "btn btn--quiet", type: "button" },
    "Download your data"
  );
  const status = h("p", { class: "settings__note", role: "status" });

  let pending = false;

  button.addEventListener("click", async () => {
    if (pending) return;
    pending = true;
    const restoreFocus = keepingFocus(button);
    button.disabled = true;
    button.textContent = "Gathering…";
    status.textContent = "";

    /** @type {string | null} */
    let href = null;
    try {
      const data = await api.get("/users/me/export");

      // Two spaces. The file is meant to be opened and read by a person —
      // that is the whole point of offering it — and minified JSON is a
      // wall. The size cost is nothing at this scale.
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      href = URL.createObjectURL(blob);

      // Dated, so a second download does not overwrite the first in the
      // downloads folder and so the file says when it was true.
      const day = new Date().toISOString().slice(0, 10);
      const link = h("a", { href, download: `commons-${me.username}-${day}.json` });
      // Not appended to the document. A click on a detached anchor still
      // triggers the download in every browser that supports the attribute,
      // and appending one means a stray element if anything below throws.
      link.click();

      // Numerals, not spellCount: its words are capitalised for the start of
      // a sentence ("Four new posts since…") and this is the middle of one.
      // A count of records reads better as a figure anyway.
      const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
      status.textContent =
        `Downloaded — ${n(data.posts.length, "post", "posts")} and ` +
        `${n(data.comments.length, "comment", "comments")}.`;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        status.textContent = "That didn't download. Try again?";
      }
    } finally {
      // Released on the next turn of the loop rather than immediately: the
      // click above starts the download asynchronously, and revoking the URL
      // in the same task can cancel it out from under itself.
      // `url` rather than `href` inside the closure: TypeScript narrows the
      // outer `let` back to `string | null` across the await boundary, and it
      // is right to — nothing else guarantees it has not been reassigned.
      const url = href;
      if (url) setTimeout(() => URL.revokeObjectURL(url), 0);
      pending = false;
      button.disabled = false;
      button.textContent = "Download your data";
      restoreFocus();
    }
  });

  return section(
    "Your writing",
    "A JSON file of everything you have written here: your posts, including " +
      "any drafts, and every comment wherever you left it. Yours to keep, and " +
      "readable without Commons — it is a text file, not an archive.",
    button,
    status
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
    const restoreFocus = keepingFocus(button);
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
      restoreFocus();
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
      const restoreFocus = keepingFocus(go);
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
        restoreFocus();
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

// ── 2 · this browser: reading ──────────────────────────────────────────────
//
// The same two settings the panel on a post already offers, in the place
// somebody looks for them when they are not on a post. **Not a default that a
// post can override** — there is one value each and both controls write it,
// which is why choosing here moves the panel's radios and vice versa. Saying
// "default" would promise a per-post override that does not exist and that
// nothing in this app wants to exist.
//
// Settings is arguably the better home for the width in particular: the size
// is something you reach for mid-read, and the width is something you decide
// once and never think about again.
//
// Two widths, not four, and no slider. The type system already decided what a
// good measure is — 66ch, chosen with Newsreader and 18px together — and what
// this offers is not "any width" but "the one the type picked, or a narrower
// one for a long sitting". A slider would invite somebody to set 90ch and
// conclude the typography was bad.
function readingSection() {
  return section(
    "Reading",
    "The two settings the reading panel on a post offers, for when you are " +
      "not on one. They change the long serif column a post is set in, and " +
      "nothing else — this is not a zoom control, and your browser already " +
      "has one of those that is better.",
    radioGroup({
      legend: "Text size",
      // A different `name` from the panel's group for the same setting. They
      // are never on screen together — one is a post, one is this — and if
      // they ever were, a shared name would make the browser treat two
      // fieldsets in two places as one radio group.
      name: "settings-text-size",
      values: textSizes(),
      labels: { s: "Small", m: "Medium", l: "Large" },
      current: textSize,
      choose: setTextSize,
      event: "commons:textsize",
    }),
    radioGroup({
      legend: "Line width",
      name: "settings-measure",
      values: measures(),
      labels: { normal: "Normal", narrow: "Narrow" },
      current: measure,
      choose: setMeasure,
      event: "commons:measure",
    }),
    specimen()
  );
}

/**
 * A line of type, set the way a post is.
 *
 * Beyond what the plan asked for, and the reason is the screen it is on. The
 * panel on a post needs no specimen because the post *is* the specimen — you
 * change the size and the thing you are reading changes under your hand.
 * Settings has no long serif column anywhere on it, so without this the two
 * controls are a pair of numbers you set blind and confirm by navigating
 * somewhere else.
 *
 * It costs no JavaScript. Both settings are custom properties on <html>, so a
 * paragraph asking for `--fs-read` and `--measure` is *by construction* the
 * same type at the same width a post will be, and it moves the instant a
 * radio is pressed without anything having to tell it to. It also shows the
 * one interaction between the two that is genuinely surprising: the measure
 * is written in `ch`, so a narrow column at Large is not the same number of
 * pixels as a narrow column at Small.
 */
function specimen() {
  return h(
    "p",
    { class: "specimen" },
    "Commons is set in Newsreader, a face drawn for long paragraphs on a " +
      "screen rather than on paper. This line is set the way a post will be, " +
      "so the change is something you can see rather than something you have " +
      "to go and check."
  );
}

// ── 2 · this browser: notifications ────────────────────────────────────────
//
// `notify.js` has polled unconditionally since it shipped. These switch off
// what you are told about, and what a switched-off kind means is written down
// in that file: the rows are still made, they are simply not shown or counted
// here, so turning one back on reveals what arrived while you were not
// listening. That is the right behaviour for a setting somebody may change
// twice in a week.
//
// The badge is a third switch rather than a consequence of the other two,
// because it answers a different question. "Tell me about replies" is about
// this app; "put the number on my dock" is about the reader's desktop, and
// somebody can reasonably want the first without the second.
function notificationsSection() {
  const kinds = h(
    "div",
    { class: "settings__switches" },
    toggleSwitch({
      label: "Replies to you",
      current: () => notifyPrefs().reply,
      choose: (on) => setNotifyPref("reply", on),
      event: "commons:notifyprefs",
    }),
    toggleSwitch({
      label: "Comments on your posts",
      current: () => notifyPrefs().comment,
      choose: (on) => setNotifyPref("comment", on),
      event: "commons:notifyprefs",
    })
  );

  const badgeNote = h(
    "p",
    { class: "settings__note", id: "settings-badge-note" },
    isInstalled()
      ? "The count on the app's icon, which is the one part of this you can " +
          "see with Commons closed."
      : "The count on the app's icon. It needs Commons installed to have an " +
          "icon to put it on, so nothing will change until it is."
  );

  const badge = toggleSwitch({
    label: "Show the count on the app icon",
    current: () => notifyPrefs().badge,
    choose: (on) => setNotifyPref("badge", on),
    event: "commons:notifyprefs",
    describedBy: "settings-badge-note",
  });

  return section(
    "Notifications",
    "Somebody replying to you, or commenting on a post of yours. Nothing else " +
      "is ever a notification here — a vote is a number moving, and this app " +
      "does not turn that into something you have to look at.",
    kinds,
    badge,
    badgeNote
  );
}

// ── 2 · this browser: motion ───────────────────────────────────────────────
//
// The app has honoured `prefers-reduced-motion` thoroughly since the
// beginning and only ever obeyed the operating system. Honouring the system
// is table stakes; being able to turn the motion down in *one* app without
// turning it down everywhere is not, and it is a genuine accessibility
// signal rather than a preference for its own sake.
//
// One switch and not three states, unlike the theme. Off means *follow your
// device*; on means *less, whatever the device says*. There is deliberately
// no way to ask for more: a machine that has requested reduced motion has
// requested it, and an app offering to overrule that would be offering to
// ignore an accessibility setting.
function motionSection() {
  return section(
    "Motion",
    "Commons already follows your device when it asks for less motion. This " +
      "turns it down here whatever your device says — the page transitions, " +
      "the aurora behind the feed, and everything that fades or slides.",
    toggleSwitch({
      label: "Reduce motion in Commons",
      current: motionReduced,
      choose: setMotionReduced,
      event: "commons:motion",
    })
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
        const restoreFocus = keepingFocus(control);
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
          restoreFocus();
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
    "commons:notifyprefs",
    "commons:motion",
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
      "commons:notifyprefs",
      "commons:motion",
    ]) {
      removeEventListener(event, repaint);
    }
  });

  paint();

  return section(
    "What this browser knows about you",
    "Everything below is on this machine and has never been sent anywhere. " +
      "This is the whole list, and each line can be checked against your " +
      "browser's own storage inspector.",
    list,
    foot
  );
}

// ── 2 · this browser: the theme ────────────────────────────────────────────
//
// **A preference, on the screen the plan said was not for preferences.** That
// note is kept everywhere else and overruled here for one reason: the header's
// toggle is a two-state control and this is a three-state choice. *System* has
// nowhere else it could live, and without it the toggle is a door that only
// opens outward — one press, months ago, and a laptop that goes dark at sunset
// stopped taking Commons with it.
//
// So the fast path stays where it is and this is the only place the third
// state exists. The radios and the toggle draw from the same value and
// announce with the same event, so neither can go stale while the other is
// used — press the toggle with this screen open and the selection moves.
function themeSection() {
  return section(
    "Theme",
    "System follows whatever your device is set to, and keeps following it — " +
      "including when your device changes it while Commons is open. The " +
      "toggle in the header is the fast way between light and dark, and " +
      "pressing it is what moves you off System; this is the way back.",
    radioGroup({
      legend: "Theme",
      hideLegend: true,
      name: "commons-theme",
      values: themeChoices(),
      labels: { system: "System", light: "Light", dark: "Dark" },
      current: themeChoice,
      choose: setThemeChoice,
      event: "commons:theme",
    })
  );
}

// ── 2 · this browser ───────────────────────────────────────────────────────
// The settings that live on this machine, and then the list of everything it
// is keeping. In that order: what you can change, then what is there.
/** @param {number} n which part this is on the screen it is being put on */
function browserGroup(n) {
  return group(
    n,
    "This browser",
    "None of this is on your account — it is on this machine, and it stays " +
      "here. Another device signed in as you knows none of it.",
    themeSection(),
    readingSection(),
    motionSection(),
    notificationsSection(),
    dataPanel()
  );
}

/**
 * What is missing, and where it went.
 *
 * Without this the screen is two parts that begin at "This browser", and a
 * reader who came looking for their account finds no account and no
 * explanation — which reads as the page having failed rather than as the
 * page being complete for somebody who is not signed in.
 */
function signedOutNote() {
  return h(
    "p",
    { class: "settings__signedout" },
    "You're not signed in, so there's no account half to show. Everything " +
      "below is about this browser and about Commons itself. ",
    h("a", { href: "#/login" }, "Sign in"),
    " to change your name, end your other sessions, or delete your account."
  );
}

// ── 3 · about ──────────────────────────────────────────────────────────────
//
// What Commons is, and what this copy of it is doing right now. The two
// states worth putting on screen are the two nobody can otherwise see:
// whether the app is installed, and whether it is being served from this
// machine's own cache.
//
// **There is no version number, and that is not an oversight.** The plan
// asked for one. This app has no build step (ADR 0001) and a network-first
// service worker whose cache name is a constant on purpose (ADR 0007) —
// there is no artefact to number, and a number typed into a file by hand is
// a number that is wrong the first time somebody forgets it. The colophon
// carries the measurements that *are* real and checked by CI. What this
// section can say honestly is whether there is a worker, and whether it has
// anything newer to fetch — so that is what it says.

/** Is a service worker in charge of this page right now? */
const workerControls = () =>
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  !!navigator.serviceWorker.controller;

function offlineSection() {
  const line = h("p", { class: "settings__note" });
  const check = h(
    "button",
    { class: "btn btn--quiet", type: "button" },
    "Check for a new version"
  );

  const paint = () => {
    if (!workerControls()) {
      // Either the worker has not taken over yet — it claims the page on the
      // *next* load after it installs — or this browser has none.
      line.textContent =
        "Nothing is cached on this machine yet, so Commons needs the network. " +
        "Reload once and the worker takes over.";
      check.hidden = true;
      return;
    }
    check.hidden = false;
    line.textContent = isOffline()
      ? "You are offline, and reading from this machine's own copy — which is " +
        "the arrangement working, not failing."
      : "The app itself is cached here, so it opens with no network at all. " +
        "What you read still comes from the server when there is one.";
  };

  check.addEventListener("click", async () => {
    const restoreFocus = keepingFocus(check);
    check.disabled = true;
    const was = check.textContent;
    check.textContent = "Checking…";
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      // `update()` asks the network for sw.js and installs a new one if the
      // bytes differ. It resolves either way — there is no "nothing changed"
      // signal — so the honest report is that we looked, not what we found.
      if (reg) await reg.update();
      toast(
        reg && reg.installing
          ? "A new version is downloading. It takes over next time you open Commons."
          : "Checked — this is the current version."
      );
    } catch (e) {
      toast("Couldn't check just now. Try again when you're online?");
    } finally {
      check.disabled = false;
      check.textContent = was;
      restoreFocus();
    }
  });

  paint();
  // The band under the header says the same thing in one line; this says it
  // in the place somebody goes to ask.
  for (const event of ["online", "offline"]) addEventListener(event, paint);
  onLeavingScreen(() => {
    for (const event of ["online", "offline"]) removeEventListener(event, paint);
  });

  return section("Offline", "", line, check);
}

/** @param {number} n which part this is — see the note in renderSettings. */
function aboutGroup(n) {
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
    n,
    "About",
    "What Commons is, and what this copy of it is doing.",
    section(
      "Installed",
      isInstalled()
        ? "Commons is installed on this machine and running in its own window."
        : "Commons runs in a tab here. Installed, it opens in its own window " +
            "and keeps working with no network.",
      // Empty in the two states where there is nothing honest to offer — the
      // same block the colophon and the masthead use. See ADR 0010.
      installBlock(
        (state) => [
          state === "prompt" ? installButton("Install Commons") : installHowTo(),
        ],
        { class: "settings__install" }
      )
    ),
    offlineSection(),
    section(
      "Reading further",
      "How this was made, and what it can do without the mouse.",
      h(
        "div",
        { class: "settings__row" },
        h("a", { class: "btn btn--quiet", href: "#/colophon" }, "Read the colophon"),
        keys
      )
    )
  );
}

// Built twice — once under the loading line and once under the real screen —
// so that the title doesn't arrive after the page it titles.
/**
 * @param {boolean} signedIn what the line underneath can honestly promise —
 *   there is no account half to offer somebody who has not signed in
 */
const head = (signedIn) =>
  h(
    "header",
    { class: "settings__head" },
    h("h1", { class: "settings__title" }, "Settings"),
    h(
      "p",
      { class: "settings__line" },
      signedIn
        ? "Your account, and what this browser is keeping."
        : "What this browser is keeping, and what Commons is."
    )
  );

export async function renderSettings({ isStale }) {
  // ── signed out, and not sent away ─────────────────────────────────────
  // Two of the three parts are about this machine rather than about an
  // account: a shelf, a draft, a reading history and a theme all exist
  // before anybody signs in, and the reader who most wants to know what a
  // site is keeping about them is exactly the one who has not handed it a
  // name. Bouncing them to a sign-in form to be told that was the last
  // thing on this screen that only worked one way.
  //
  // It renders straight away and asks for nothing. The account half needs
  // /users/me for the email; the browser half needs the disk, which is
  // already here — so there is no request to fail and no loading line to
  // show, and a signed-out reader cannot be handed an auth error by a screen
  // that never spoke to the server.
  if (!get("session")) {
    const out = h(
      "section",
      { class: "settings", "aria-label": "Settings" },
      head(false),
      // Numbered from one. The parts are an index of what is on *this*
      // screen, so a screen with two of them starts at 1 — a gap where an
      // account section would be is a question nobody can answer from here.
      signedOutNote(),
      browserGroup(1),
      aboutGroup(2)
    );
    mountView(out);
    return;
  }

  const root = h(
    "section",
    { class: "settings", "aria-label": "Settings" },
    head(true),
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
    head(true),
    group(
      1,
      "Your account",
      "This half lives on the server and follows you to any machine you sign " +
        "in on. It runs from the reversible to the permanent.",
      nameSection(me),
      emailSection(me),
      sessionsSection(),
      exportSection(me),
      dangerSection(me)
    ),
    browserGroup(2),
    aboutGroup(3)
  );
}
