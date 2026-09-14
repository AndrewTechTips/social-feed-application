// @ts-check
// Sign in (#/login) and Register (#/register). One builder, two modes.
// Register creates the account, then signs in straight away so the person lands
// on the feed able to post — the API hands back a token only from /login.

import { api } from "../api.js";
import { h, icon, mountView, toast } from "../ui.js";
import { get, setSession, setAccess } from "../store.js";
import { navigate } from "../router.js";

const EMAIL_RE = /^\S+@\S+\.\S+$/;
// Mirrors schemas.USERNAME_RE in the backend. Case-insensitive here because
// the server folds what it's given rather than refusing it.
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{2,19}$/;
const USERNAME_HINT = "3–20 characters: letters, digits, - and _";

const MARK = () =>
  h("svg", { viewBox: "0 0 24 24", width: 26, height: 26, "aria-hidden": "true" },
    h("circle", { cx: 12, cy: 12, r: 9, fill: "none", stroke: "currentColor", "stroke-width": 1.6 }),
    h("circle", { cx: 12, cy: 10, r: 2.6, fill: "currentColor" }),
    h("path", {
      d: "M10.7 11.6 L9.6 16.2 A0.6 0.6 0 0 0 10.2 17 h3.6 a0.6 0.6 0 0 0 0.6-.8 L13.3 11.6 Z",
      fill: "currentColor",
    }));

/**
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.label
 * @param {string} spec.type
 * @param {string} spec.autocomplete
 * @param {string | null} [spec.hint]  the line under the box, where there is one
 */
function field({ id, label, type, autocomplete, hint }) {
  const input = h("input", { id, class: "input", type, autocomplete, "aria-describedby": `${id}-err` });
  const err = h("p", { class: "field__error", id: `${id}-err`, role: "alert" });
  const wrap = h("div", { class: "field" }, h("label", { class: "field__label", for: id }, label));

  let mount = input;
  if (type === "password") {
    const toggle = h("button", { class: "reveal", type: "button", "aria-label": "Show password" });
    toggle.append(icon("eye"));
    toggle.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      toggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      input.focus();
    });
    mount = h("div", { class: "input-wrap" }, input, toggle);
  }
  wrap.append(mount, err);
  if (hint) wrap.append(h("p", { class: "field__label" }, hint));

  return {
    wrap,
    input,
    setError: (msg) => {
      err.textContent = msg || "";
      input.setAttribute("aria-invalid", msg ? "true" : "false");
    },
  };
}

function screen(mode) {
  const isRegister = mode === "register";

  const username = isRegister
    ? field({
        id: "username",
        label: "Username",
        type: "text",
        autocomplete: "username",
        hint: USERNAME_HINT,
      })
    : null;
  const email = field({ id: "email", label: "Email", type: "email", autocomplete: "email" });
  const password = field({
    id: "password", label: "Password", type: "password",
    autocomplete: isRegister ? "new-password" : "current-password",
    hint: isRegister ? "At least 8 characters." : null,
  });

  const formError = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { class: "btn btn--primary btn--block", type: "submit" },
    isRegister ? "Create account" : "Sign in");
  const form = h("form", { class: "auth__form", novalidate: true },
    // The name people will see comes first; the address is a credential.
    username ? username.wrap : null,
    email.wrap, password.wrap, formError, submit);

  let pending = false;

  function validate() {
    const ev = email.input.value.trim();
    const pv = password.input.value;
    if (username) {
      const uv = username.input.value.trim();
      username.setError(
        !uv
          ? "Pick a username."
          : !USERNAME_RE.test(uv)
          ? USERNAME_HINT + ", starting with a letter."
          : ""
      );
    }
    email.setError(
      !ev ? "Enter your email." : !EMAIL_RE.test(ev) ? "That doesn't look like an email." : ""
    );
    password.setError(
      !pv
        ? "Enter a password."
        : isRegister && pv.length < 8
        ? "Use at least 8 characters."
        : isRegister && pv.length > 72
        ? "That's too long — 72 characters max."
        : ""
    );
    const bad = form.querySelector('[aria-invalid="true"]');
    if (bad) bad.focus();
    return !bad;
  }

  const setPending = (on) => {
    pending = on;
    submit.disabled = on;
    submit.textContent = on ? "Just a sec…" : isRegister ? "Create account" : "Sign in";
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (pending) return;
    formError.textContent = "";
    if (!validate()) return;

    const creds = { email: email.input.value.trim(), password: password.input.value };
    if (username) creds.username = username.input.value.trim();
    setPending(true);
    try {
      if (isRegister) {
        await api.post("/users/", creds, { auth: false });
      }

      // Signing in by email — the username is the public identity, not a
      // credential. Two things come back: an access token for this tab, and a
      // refresh cookie the browser keeps and this code never sees.
      setAccess(await api.login(creds.email, creds.password));

      // The token says nothing about the person it just signed in, and the feed
      // no longer carries anyone's address to match against. So ask: /users/me
      // is what makes "which of these posts are mine" answerable on a browser
      // that has never been here before.
      const me = await api.get("/users/me");
      setSession({ id: me.id, username: me.username });

      toast(isRegister ? "Welcome to Commons." : "Signed in.");
      navigate("/");
    } catch (err) {
      setPending(false);
      if (isRegister && err.status === 409) {
        // The backend says which of the two collided.
        const aboutUsername = /username/i.test(err.detail || "");
        // A 409 about a username can only come from the register screen, which
        // is the only screen that has that field.
        const field = (aboutUsername ? username : email) ?? email;
        field.setError(
          aboutUsername
            ? "That username is taken."
            : "There's already an account with that email."
        );
        field.input.focus();
      } else {
        formError.textContent =
          err.status === 401
            ? "That email and password don't match."
            : err.status === 429
            ? "Too many tries. Give it a minute."
            : err.status === 0
            ? "Can't reach the server. Is the backend running?"
            : "That didn't go through. Try again?";
      }
    }
  });

  const card = h("div", { class: "auth__card" },
    h("div", { class: "auth__mark" }, MARK()),
    h("h1", { class: "auth__title" }, isRegister ? "Make an account." : "Welcome back."),
    h("p", { class: "auth__sub" },
      isRegister ? "You just need an email and a password." : "Sign in to post and to upvote."),
    form,
    h("p", { class: "auth__alt" },
      isRegister ? "Already have one? " : "New here? ",
      h("a", { href: isRegister ? "#/login" : "#/register" },
        isRegister ? "Sign in" : "Create an account")));

  mountView(h("div", { class: "auth" }, card), { focus: email.input });
}

export function renderLogin() {
  if (get("session")) return navigate("/");
  screen("login");
}

export function renderRegister() {
  if (get("session")) return navigate("/");
  screen("register");
}
