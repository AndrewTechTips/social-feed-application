// @ts-check
// Your account (#/settings) — the three things you can do to it.
//
// Rename yourself, sign out everywhere, and leave. They are on one screen
// because they are the same subject, and they are in that order because it
// runs from the reversible to the permanent. Nothing here is a preference:
// theme, text size and focus mode belong to the browser rather than to the
// account, and they live where you are when you want them rather than on a
// screen you have to go and find.
//
// What is deliberately missing is the email and the password. Changing either
// is a flow with a confirmation in it — a link to an address, a current
// password to prove the session isn't borrowed — and this project has no way
// to send mail. A text box that pretended otherwise would be worse than the
// absence, so the absence says so out loud.

import { api, ApiError, forgetPendingRefresh } from "../api.js";
import { h, mountView, toast } from "../ui.js";
import { get, setSession, clearSession, dropFeedCache } from "../store.js";
import { navigate, forgetCurrentScreen } from "../router.js";

// Mirrors schemas.USERNAME_RE. Case-insensitive, because the server folds what
// it is given rather than refusing it — so ADA is offered and `ada` is stored,
// and the field says so by putting the folded name back afterwards.
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{2,19}$/;
const USERNAME_HINT = "3–20 characters: letters, digits, - and _";

/** A titled block. Every section on this screen is one of these. */
function section(title, blurb, ...body) {
  return h(
    "section",
    { class: "settings__section" },
    h("h2", { class: "settings__heading" }, title),
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

    if (!wanted) return setError("Pick a username."), input.focus();
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
  const open = h("button", { class: "btn btn--quiet danger", type: "button" }, "Delete your account");
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

// Built twice — once under the loading line and once under the real screen —
// so that the title doesn't arrive after the page it titles.
const head = () =>
  h(
    "header",
    { class: "settings__head" },
    h("h1", { class: "settings__title" }, "Your account"),
    h("p", { class: "settings__line" }, "Three things you can do to it.")
  );

export async function renderSettings({ isStale }) {
  if (!get("session")) return navigate("/login");

  const root = h(
    "section",
    { class: "settings", "aria-label": "Your account" },
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
      h("p", { class: "settings__loading" }, "Couldn't load your account. Reload to try again.")
    );
    return;
  }
  if (isStale()) return;

  root.replaceChildren(
    head(),
    nameSection(me),
    emailSection(me),
    sessionsSection(),
    dangerSection(me)
  );
}
