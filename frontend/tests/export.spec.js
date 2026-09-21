// Taking your writing with you, and the settings screen with nobody signed in.
//
// Two features, one file, because they are the two halves of the same
// question: what does `#/settings` owe a reader, and who is it for. One says
// the account half is yours to take away; the other says the other two thirds
// of the screen never needed an account at all.
//
// ── what is actually worth asserting about a download ────────────────────
// Not that a button exists. A download is a promise that the file contains
// everything, so these read the blob back and check what is *in* it — the
// draft that the public endpoints would have hidden, the comment left under
// somebody else's post that no public endpoint can even find. `URL.createObjectURL`
// is intercepted to get at the Blob, because the object URL is revoked a tick
// after the click and there is nothing left to fetch by the time a test asks.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled, accountButton } = require("./support/fixtures");

const ADA = "ada@commons.test";
const BEA = "bea@commons.test";
const PW = "seedpassword";

async function onSettings(page, api, { posts = 2 } = {}) {
  await api.seed(posts, ADA);
  await api.signIn(page, ADA, PW);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
}

/**
 * Press Download and hand back the file that would have been saved.
 *
 * The anchor is detached and the object URL is revoked on the next tick, so
 * neither a `download` event nor a fetch of the href is available afterwards.
 * Holding on to the Blob as it is created is the only thing that survives.
 */
async function download(page) {
  await page.evaluate(() => {
    window.__dl = { blobs: [], clicks: [], revoked: 0 };
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = function (blob) {
      window.__dl.blobs.push(blob);
      return create.call(URL, blob);
    };
    URL.revokeObjectURL = function (url) {
      window.__dl.revoked += 1;
      return revoke.call(URL, url);
    };
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        window.__dl.clicks.push({
          name: this.download,
          detached: !this.isConnected,
        });
        return;
      }
      return click.call(this);
    };
  });

  await page.getByRole("button", { name: "Download your data" }).click();
  await expect(page.getByRole("button", { name: "Download your data" })).toBeEnabled();

  return page.evaluate(async () => {
    const text = window.__dl.blobs[0] ? await window.__dl.blobs[0].text() : null;
    return {
      name: window.__dl.clicks[0]?.name ?? null,
      detached: window.__dl.clicks[0]?.detached ?? null,
      revoked: window.__dl.revoked,
      type: window.__dl.blobs[0]?.type ?? null,
      text,
      data: text ? JSON.parse(text) : null,
    };
  });
}

/** Say something on the first post, as whoever is signed in. */
async function say(page, words) {
  if (!/#\/$/.test(page.url())) await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.getByLabel("Add a comment").fill(words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".comment").last()).toContainText(words);
}

/** Sign in through the form — see notifications.spec.js for why not api.signIn. */
async function signInWithForm(page, email) {
  const trigger = accountButton(page);
  if (await trigger.isVisible().catch(() => false)) {
    await trigger.click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  }
  await page.goto("/#/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);
}

// ── the file ───────────────────────────────────────────────────────────────

test("it downloads a dated, readable JSON file", async ({ page, api }) => {
  await onSettings(page, api);
  const file = await download(page);

  expect(file.type).toBe("application/json");
  // Dated, so a second download does not silently replace the first and so
  // the file says when it was true.
  expect(file.name).toMatch(/^commons-ada-\d{4}-\d{2}-\d{2}\.json$/);
  // Indented. The whole point of offering it is that a person can open it.
  expect(file.text).toContain('\n  "account"');
  expect(Object.keys(file.data)).toEqual([
    "exported_at",
    "account",
    "email",
    "posts",
    "comments",
  ]);
});

test("it tidies up after itself", async ({ page, api }) => {
  await onSettings(page, api);
  const file = await download(page);

  // A stray <a> left in the document, or an object URL never released, is the
  // usual cost of doing this the quick way.
  expect(file.detached).toBe(true);
  expect(file.revoked).toBe(1);
});

test("the file has your account and your email in it", async ({ page, api }) => {
  await onSettings(page, api);
  const { data } = await download(page);

  expect(data.account.username).toBe("ada");
  // Not on the public profile shape, and an export of your data that left out
  // the identifier you signed up with would be an odd sort of export.
  expect(data.email).toBe(ADA);
  expect(data.exported_at).toBeTruthy();
});

test("it contains your posts, with their words", async ({ page, api }) => {
  await onSettings(page, api, { posts: 3 });
  const { data } = await download(page);

  expect(data.posts).toHaveLength(3);
  for (const post of data.posts) {
    expect(post.title).toBeTruthy();
    expect(post.content).toBeTruthy();
    expect(post).toHaveProperty("created_at");
  }
  // Not the feed's view of a post: votes and shelf state are facts about a
  // moment and a viewer, and in a file they would be a number that was true
  // once. See schemas.ExportedPost.
  expect(data.posts[0]).not.toHaveProperty("votes");
  expect(data.posts[0]).not.toHaveProperty("saved");
});

test("it contains the draft you have not finished", async ({ page, api }) => {
  await onSettings(page, api);

  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill("Not ready yet");
  await page.getByLabel("Body").fill("Half a thought.");
  await page.getByText("Publish now").click(); // becomes "Save as a draft"
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page).toHaveURL(/#\/posts\/\d+$/);

  await page.goto("/#/settings");
  const { data } = await download(page);

  // The single most likely silent omission. `/users/{username}/posts` hides
  // unpublished posts from everyone but their author, so an export composed
  // out of the public endpoints would have quietly lost this.
  const draft = data.posts.find((p) => p.title === "Not ready yet");
  expect(draft, "the draft is missing from the export").toBeTruthy();
  expect(draft.published).toBe(false);
  expect(draft.content).toBe("Half a thought.");
});

test("it contains comments you left on other people's posts", async ({ page, api }) => {
  await api.seed(1, BEA);
  await api.register(ADA, PW, "ada");
  await api.signIn(page, ADA, PW);

  await say(page, "Something I said under somebody else's post");

  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
  const { data } = await download(page);

  // There is no public "comments by one person" endpoint, so from the outside
  // there is no way to find this at all. It is the reason the export is its
  // own request rather than something the client assembles.
  const mine = data.comments.find((c) =>
    c.content.includes("under somebody else's post")
  );
  expect(mine, "a comment on another person's post is missing").toBeTruthy();
  // And enough of the post to resolve it once the file has left the app.
  expect(mine.post_title).toBeTruthy();
  expect(mine.post_id).toBeGreaterThan(0);
});

test("it contains nobody else's writing", async ({ page, api }) => {
  await api.seed(1, ADA);
  await api.register(BEA, PW, "bea");

  await api.signIn(page, BEA, PW);
  await say(page, "Bea was here");

  await signInWithForm(page, ADA);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
  const { data } = await download(page);

  expect(data.comments.some((c) => c.content.includes("Bea was here"))).toBe(false);
  expect(data.posts.every((p) => p.user_id === data.account.id)).toBe(true);
});

test("a new account exports an empty but well-formed file", async ({ page, api }) => {
  await api.register(ADA, PW, "ada");
  await api.signIn(page, ADA, PW);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();

  const { data } = await download(page);
  expect(data.posts).toEqual([]);
  expect(data.comments).toEqual([]);
  expect(data.account.username).toBe("ada");
});

test("it says what it gave you, and counts in the singular", async ({ page, api }) => {
  await api.seed(1, ADA);
  await api.signIn(page, ADA, PW);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();

  await download(page);
  const said = page.locator(".settings__section p[role='status']");
  await expect(said).toContainText("1 post");
  await expect(said).not.toContainText("1 posts");
});

test("it sits above Leaving, not below it", async ({ page, api }) => {
  await onSettings(page, api);

  // Somebody who has decided to delete their account should pass the way to
  // keep a copy on the way to the button that throws it away.
  const order = await page.evaluate(() =>
    [...document.querySelectorAll(".settings__heading")].map((h) => h.textContent)
  );
  expect(order.indexOf("Your writing")).toBeGreaterThan(-1);
  expect(order.indexOf("Your writing")).toBeLessThan(order.indexOf("Leaving"));
});

// ── the settings screen with nobody signed in ─────────────────────────────

test("a signed-out reader gets the screen rather than the sign-in form", async ({
  page,
  api,
}) => {
  await api.seed(1);
  await page.goto("/#/settings");

  await expect(page.locator(".data")).toBeVisible();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
});

test("it asks the server for nothing, so it cannot fail on auth", async ({
  page,
  api,
}) => {
  await api.seed(1);

  const asked = [];
  page.on("request", (r) => {
    if (r.url().includes("/users/me")) asked.push(r.url());
  });

  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
  await settled(page);

  // The account half is the only part that needs /users/me, and it is not on
  // the page. Asking and handling the 401 would work; not asking cannot fail.
  expect(asked).toEqual([]);
  // And no loading line ever appeared, because there was nothing to wait for.
  await expect(page.locator(".settings__loading")).toHaveCount(0);
});

test("the two parts are numbered from one", async ({ page, api }) => {
  await api.seed(1);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();

  // An index of what is on *this* screen. A gap where an account section
  // would be is a question nobody can answer from here.
  await expect(page.locator(".settings__group-head")).toHaveText([
    /This browser/,
    /About/,
  ]);
  await expect(page.locator(".settings__group-n")).toHaveText(["1", "2"]);
});

test("it says why the account half is missing, and offers the way in", async ({
  page,
  api,
}) => {
  await api.seed(1);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();

  await expect(page.locator(".settings__signedout")).toContainText("not signed in");
  await expect(
    page.locator(".settings__signedout").getByRole("link", { name: "Sign in" })
  ).toHaveAttribute("href", "#/login");
  // And the line under the title does not promise an account half either.
  await expect(page.locator(".settings__line")).not.toContainText("Your account");
});

test("nothing account-shaped is on the page", async ({ page, api }) => {
  await api.seed(1);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();

  for (const gone of [
    "Save name",
    "Sign out everywhere",
    "Delete your account",
    "Download your data",
  ]) {
    await expect(page.getByRole("button", { name: gone })).toHaveCount(0);
  }
  await expect(page.locator("#settings-username")).toHaveCount(0);
});

test("the browser half still works signed out", async ({ page, api }) => {
  await api.seed(2);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();

  // The reader who most wants to know what a site keeps about them is the one
  // who has not handed it a name, so the controls have to do something.
  await page.locator('input[name="commons-theme"][value="light"]').click();
  expect(await page.evaluate(() => localStorage.getItem("commons.theme"))).toBe(
    "light"
  );

  await page.getByRole("checkbox", { name: "Reduce motion in Commons" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");

  await expect(page.locator('[data-row="signin"]')).toContainText("Signed out");
});

test("signing in from here brings the account half back", async ({ page, api }) => {
  await api.seed(1, ADA);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
  await expect(page.locator(".settings__group-n")).toHaveText(["1", "2"]);

  await page
    .locator(".settings__signedout")
    .getByRole("link", { name: "Sign in" })
    .click();
  await page.getByLabel("Email").fill(ADA);
  await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);

  await page.goto("/#/settings");
  await expect(page.locator("#settings-username")).toHaveValue("ada");
  await expect(page.locator(".settings__group-n")).toHaveText(["1", "2", "3"]);
  await expect(page.locator(".settings__signedout")).toHaveCount(0);
});

test("signing out while on the screen does not strand you", async ({ page, api }) => {
  await onSettings(page, api);
  await expect(page.locator("#settings-username")).toBeVisible();

  await accountButton(page).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  // Sign-out navigates home; coming back has to give the signed-out screen
  // rather than a sign-in form or a half-rendered one.
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
  await expect(page.locator(".settings__signedout")).toBeVisible();
  await expect(page).toHaveURL(/#\/settings$/);
});

// ── the quality floor ──────────────────────────────────────────────────────

test("axe is clean signed out, in both themes", async ({ page, api }) => {
  await api.seed(1);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();

  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await settled(page);
    const { violations } = await new AxeBuilder({ page })
      .include(".settings")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.help}`);
    expect(summary, `${theme}:\n${summary.join("\n")}`).toEqual([]);
  }
});

test("axe is clean on the account half with the export on it", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  await settled(page);

  const { violations } = await new AxeBuilder({ page })
    .include(".settings")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("the export is reachable and reported by keyboard alone", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  const button = page.getByRole("button", { name: "Download your data" });
  await button.focus();
  await page.evaluate(() => {
    // Same interception as download(), so pressing Enter does not actually
    // put a file in the runner's downloads folder.
    HTMLAnchorElement.prototype.click = function () {};
  });
  await page.keyboard.press("Enter");

  // role="status" so the result is announced without moving focus — the
  // button is still where the reader left it.
  const said = page.locator(".settings__section p[role='status']");
  await expect(said).toContainText("Downloaded");
  await expect(button).toBeFocused();
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

  test("the signed-out screen fits", async ({ page, api }) => {
    await api.seed(1);
    await page.goto("/#/settings");
    await expect(page.locator(".data")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
