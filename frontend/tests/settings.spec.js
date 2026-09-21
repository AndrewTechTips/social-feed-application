// Your account (#/settings) — rename, sign out everywhere, delete.
//
// Three operations whose interesting part is not the response code but what is
// still true afterwards: a rename that keeps your posts, a sign-out that
// reaches the other browser, a delete that takes the comments you left under
// somebody else's post. The backend suite pins those down against Postgres;
// this file pins down that the screen in front of a person asks for the right
// thing and tells the truth about what happened.
//
// It runs twice — against tests/mock_api.py over HTTP, and against
// js/demo/backend.js in the page — which is the only way to know the published
// demo does what the API does.

const AxeBuilder = require("@axe-core/playwright").default;
const {
  test,
  expect,
  CARD,
  settled,
  accountButton,
  accountWho,
  openAccountMenu,
} = require("./support/fixtures");

const EMAIL = "ada@commons.test";

async function signedIn(page, api, { posts = 0 } = {}) {
  if (posts) await api.seed(posts, EMAIL);
  else await api.register(EMAIL, "seedpassword", "ada");
  await api.signIn(page, EMAIL, "seedpassword");
  await page.goto("/#/settings");
  await expect(page.locator(".settings__title")).toBeVisible();
}

const name = (page) => page.locator("#settings-username");
const saveName = (page) => page.getByRole("button", { name: "Save name" });

// ── getting there ──────────────────────────────────────────────────────────
test("your own profile offers a way in; other people's don't", async ({
  page,
  api,
}) => {
  await api.seed(1, EMAIL);
  await api.register("bea@commons.test", "seedpassword", "bea");
  await api.signIn(page, EMAIL, "seedpassword");

  await page.goto("/#/u/ada");
  const link = page.locator(".profile__more a");
  await expect(link).toHaveText("Your account");

  await page.goto("/#/u/bea");
  await expect(page.locator(".profile__more")).toHaveCount(0);
});

test("the palette can get there, and only offers it when there's an account", async ({
  page,
  api,
}) => {
  await api.seed(1, EMAIL);

  // Signed out: no row, because it would lead straight back to the sign-in
  // screen — a promise the palette shouldn't make.
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette__row", { hasText: "Your account" })).toHaveCount(
    0
  );
  await page.keyboard.press("Escape");

  await api.signIn(page, EMAIL, "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator(".palette__row", { hasText: "Your account" }).click();
  await expect(page).toHaveURL(/#\/settings$/);
});

test("a signed-out visitor is shown the screen, not the sign-in form", async ({
  page,
}) => {
  await page.goto("/#/settings");

  // This used to redirect. Two of the three parts are about this machine
  // rather than about an account, and the reader who most wants to know what
  // a site keeps about them is the one who has not handed it a name — so
  // being bounced to a form was the last thing here that only worked one
  // way. export.spec.js has the rest of it.
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.locator(".settings__signedout")).toBeVisible();
});

// ── your name ──────────────────────────────────────────────────────────────
test("changing your name changes it everywhere it is drawn", async ({ page, api }) => {
  await signedIn(page, api, { posts: 2 });
  await expect(name(page)).toHaveValue("ada");

  await name(page).fill("adalovelace");
  await saveName(page).click();

  await expect(page.locator(".toast")).toHaveText("You're adalovelace now.");
  // The header is drawn from the store, so it has to have moved too — both
  // halves of it: the name the account button answers to, and the row behind
  // it that points at your own posts.
  await expect(accountButton(page)).toHaveAttribute(
    "aria-label",
    /^Your account, adalovelace\b/
  );
  await openAccountMenu(page);
  await expect(accountWho(page)).toHaveAttribute("href", "#/u/adalovelace");
  await expect(accountWho(page)).toContainText("adalovelace");
});

test("a rename keeps your posts", async ({ page, api }) => {
  await signedIn(page, api, { posts: 3 });
  await name(page).fill("adalovelace");
  await saveName(page).click();
  await expect(page.locator(".toast")).toBeVisible();

  // The same three, at the new address — they were joined to the account, not
  // to the name.
  await page.goto("/#/u/adalovelace");
  await expect(page.locator(CARD)).toHaveCount(3);
  // And the byline on each has moved with it rather than keeping a stale copy.
  await expect(page.locator(`${CARD} .card__author`).first()).toContainText(
    "adalovelace"
  );
});

test("a name somebody else has comes back as an error on the field", async ({
  page,
  api,
}) => {
  await api.register("bea@commons.test", "seedpassword", "bea");
  await signedIn(page, api);

  await name(page).fill("bea");
  await saveName(page).click();

  await expect(page.locator("#settings-username-err")).toHaveText(
    "That username is taken."
  );
  await expect(name(page)).toHaveAttribute("aria-invalid", "true");
  // Still signed in as who you were, and the box still holds what you tried —
  // a form that clears itself on a rejection makes you type it twice to find
  // out it was wrong twice.
  await expect(accountButton(page)).toHaveAttribute(
    "aria-label",
    new RegExp(`^Your account, ada\\b`)
  );
  await expect(name(page)).toHaveValue("bea");
});

test("a name that breaks the rules never leaves the page", async ({ page, api }) => {
  await signedIn(page, api);

  let asked = 0;
  await page.route(/\/users\/me/, (route) => {
    if (route.request().method() === "PATCH") asked += 1;
    return route.continue();
  });

  await name(page).fill("9lives");
  await saveName(page).click();

  await expect(page.locator("#settings-username-err")).toContainText(
    "starting with a letter"
  );
  expect(asked).toBe(0);
});

test("saving the name you already have is not an error", async ({ page, api }) => {
  // The commonest thing done to a settings form, and the one a naive
  // implementation answers with "that username is taken" — by you, from you.
  await signedIn(page, api);

  await saveName(page).click();

  await expect(page.locator(".toast")).toHaveText("You're ada now.");
  await expect(page.locator("#settings-username-err")).toHaveText("");
});

test("the field comes back folded, because that is what was stored", async ({
  page,
  api,
}) => {
  await signedIn(page, api);
  await name(page).fill("AdaLovelace");
  await saveName(page).click();

  await expect(name(page)).toHaveValue("adalovelace");
});

// ── the email ──────────────────────────────────────────────────────────────
test("your email is shown, and is not a text box", async ({ page, api }) => {
  await signedIn(page, api);

  await expect(page.locator(".settings__value")).toHaveText(EMAIL);
  // One text box on the screen, and it is the username. Nothing here pretends
  // to change an address, because nothing here can send a confirmation to one.
  //
  // Text boxes rather than inputs: the theme picker in part 2 is three radios,
  // which are inputs and are not boxes anybody can type an address into. The
  // count was a proxy for the claim; this is the claim.
  await expect(page.locator(".settings input[type='text']")).toHaveCount(1);
  await expect(page.locator(".settings input[type='email']")).toHaveCount(0);
  // Scoped to the section the email is in. `.settings__note` was unique when
  // this was written and now names three lines — the email's, the app badge's
  // and the offline one — which is what a class shared by "a quiet paragraph"
  // is always going to become.
  await expect(
    page.locator(".settings__section", { has: page.locator(".settings__value") })
  ).toContainText("no way to send mail");
});

// ── signed in elsewhere ────────────────────────────────────────────────────
test("signing out everywhere signs this browser out too", async ({ page, api }) => {
  await signedIn(page, api, { posts: 1 });

  await page.getByRole("button", { name: "Sign out everywhere" }).click();

  await expect(page.locator(".toast")).toHaveText("Signed out on every device.");
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(".account")).toContainText("Sign in");
  // And the feed it lands on is the signed-out one, not a cached page drawn
  // while there was still a session.
  await expect(page.locator(CARD)).toHaveCount(1);
  await expect(page.locator(".vote").first()).toHaveAttribute("aria-pressed", "false");
});

// ── leaving ────────────────────────────────────────────────────────────────
test("deleting takes typing your own name, and can be backed out of", async ({
  page,
  api,
}) => {
  await signedIn(page, api);

  await page.getByRole("button", { name: "Delete your account" }).click();
  const go = page.getByRole("button", { name: "Delete my account" });
  await expect(go).toBeDisabled();

  // A near miss is still a miss.
  await page.locator("#settings-confirm").fill("ad");
  await expect(go).toBeDisabled();
  await page.locator("#settings-confirm").fill("ada");
  await expect(go).toBeEnabled();

  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByRole("button", { name: "Delete your account" })).toBeVisible();
  await expect(page.locator("#settings-confirm")).toHaveCount(0);
  // Nothing happened: still signed in, still here.
  await expect(accountButton(page)).toHaveAttribute(
    "aria-label",
    new RegExp(`^Your account, ada\\b`)
  );
});

test("deleting an account takes everything that was attached to it", async ({
  page,
  api,
}) => {
  // Two authors, so the assertions can tell "your things are gone" from
  // "everything is gone".
  await api.seed(2, EMAIL);
  await api.seed(1, "bea@commons.test");
  await api.signIn(page, EMAIL, "seedpassword");

  // A comment under somebody else's post: the cascade that points away from
  // you, and the one that is easiest to leave behind.
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  await page.locator(`${CARD} .card__link`).last().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.getByLabel("Add a comment").fill("said in passing");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".comment")).toHaveCount(1);

  await page.goto("/#/settings");
  await page.getByRole("button", { name: "Delete your account" }).click();
  await page.locator("#settings-confirm").fill("ada");
  await page.getByRole("button", { name: "Delete my account" }).click();

  await expect(page.locator(".toast")).toHaveText(
    "Your account is gone. Thanks for reading."
  );
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(".account")).toContainText("Sign in");

  // Bea's post is untouched; Ada's two and the comment are not there at all.
  await expect(page.locator(CARD)).toHaveCount(1);
  const dump = await api.dump(page);
  expect(dump.posts.filter((p) => p.author_email === EMAIL)).toHaveLength(0);
  expect(dump.posts).toHaveLength(1);
  expect(dump.comments).toHaveLength(0);
});

test("the name is free again once the account is gone", async ({ page, api }) => {
  await signedIn(page, api);
  await page.getByRole("button", { name: "Delete your account" }).click();
  await page.locator("#settings-confirm").fill("ada");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await expect(page).toHaveURL(/#\/$/);

  await page.goto("/#/register");
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Email").fill("someone-else@commons.io");
  await page.getByLabel("Password", { exact: true }).fill("seedpassword");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/#\/$/);
  await expect(accountButton(page)).toHaveAttribute(
    "aria-label",
    new RegExp(`^Your account, ada\\b`)
  );
});

// ── the shape of it ────────────────────────────────────────────────────────
test("it works at 320px, with the two buttons on separate lines", async ({
  page,
  api,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await signedIn(page, api);
  await page.getByRole("button", { name: "Delete your account" }).click();

  const go = page.getByRole("button", { name: "Delete my account" });
  const keep = page.getByRole("button", { name: "Keep it" });
  const a = await go.boundingBox();
  const b = await keep.boundingBox();
  // Wrapped, not squeezed: "Keep it" starts below "Delete my account" rather
  // than beside it, so the destructive button is never the one you hit by
  // aiming at the safe one on a narrow screen.
  expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  // And nothing spills sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );
  expect(overflow).toBe(true);
});

test("no accessibility violations, closed or opened", async ({ page, api }) => {
  await signedIn(page, api);
  await settled(page);

  const closed = await new AxeBuilder({ page }).include(".settings").analyze();
  expect(closed.violations).toEqual([]);

  await page.getByRole("button", { name: "Delete your account" }).click();
  await expect(page.locator("#settings-confirm")).toBeFocused();
  await settled(page);

  const opened = await new AxeBuilder({ page }).include(".settings").analyze();
  expect(opened.violations).toEqual([]);
});
