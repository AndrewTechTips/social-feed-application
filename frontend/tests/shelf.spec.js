// The shelf: saving a post, finding the shelf, and what happens to a saved
// post that stops existing.
//
// It used to have no backend at all. It has one now: signed in, `saves` on the
// server is the truth and `commons.shelf` is a local mirror of it, which is
// what keeps `isShelved` answerable on every card without a request. Signed
// out, it is exactly what it always was — one key in localStorage, sent
// nowhere. Both halves are below, and the seam between them (signing in
// *merges* rather than replaces) is the part most worth testing, because it is
// the one where a reader could lose something.

const AxeBuilder = require("@axe-core/playwright").default;
const { test, expect, CARD, settled } = require("./support/fixtures");

const SAVE = ".shelved";
const HEADER_SHELF = ".account a[href='#/shelf']";

const shelfIds = (page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("commons.shelf") || "[]").map((e) => e.id);
    } catch (e) {
      return [];
    }
  });

const plantShelf = (page, ids) =>
  page.addInitScript((list) => {
    try {
      localStorage.setItem(
        "commons.shelf",
        JSON.stringify(list.map((id, i) => ({ id, at: Date.now() - i })))
      );
    } catch (e) {}
  }, ids);

// Go somewhere with the planted state actually in place.
//
// addInitScript only runs on a *document* load, and this app is a hash router:
// once a document is up, page.goto("/#/shelf") changes the fragment and nothing
// else, so a plant registered after the first load would never be read. The
// reload is what makes it a document load. (page.goto("/") needs none of this
// — it has no fragment, so it reloads on its own.)
async function gotoPlanted(page, path) {
  await page.goto(path);
  await page.reload();
}

async function openCard(page, index) {
  await page.locator(`${CARD} .card__link`).nth(index).click();
  await expect(page.locator(".detail__title")).toBeVisible();
}

const idsOnScreen = (page) =>
  page
    .locator(`${CARD} .card__link`)
    .evaluateAll((els) =>
      els.map((el) => Number(el.getAttribute("href").split("/").pop()))
    );

// ── saving ─────────────────────────────────────────────────────────────────
test("saving a post says so, and opens a way to the shelf", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);

  // Nothing to go to, so nothing in the header offering to take you there.
  await expect(page.locator(HEADER_SHELF)).toHaveCount(0);

  await openCard(page, 0);
  const save = page.locator(SAVE);
  await expect(save).toHaveText("Save");
  await expect(save).toHaveAttribute("aria-pressed", "false");

  await save.click();
  await expect(save).toHaveText("Saved");
  await expect(save).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".toast")).toHaveText("Saved to your shelf.");
  await expect(page.locator(HEADER_SHELF)).toHaveCount(1);
});

test("taking the last one off closes the way in again", async ({ page, api }) => {
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await openCard(page, 0);
  await page.locator(SAVE).click();
  await expect(page.locator(HEADER_SHELF)).toHaveCount(1);

  await page.locator(SAVE).click();
  await expect(page.locator(SAVE)).toHaveText("Save");
  await expect(page.locator(".toast").last()).toHaveText("Removed from your shelf.");
  await expect(page.locator(HEADER_SHELF)).toHaveCount(0);
  expect(await shelfIds(page)).toEqual([]);
});

test("it survives a reload, and does not need an account", async ({ page, api }) => {
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await openCard(page, 0);
  await page.locator(SAVE).click();
  const saved = await shelfIds(page);
  expect(saved).toHaveLength(1);

  await page.reload();
  await expect(page.locator(".detail__title")).toBeVisible();
  await expect(page.locator(SAVE)).toHaveText("Saved");
  await expect(page.locator(HEADER_SHELF)).toHaveCount(1);
  // Signed out the whole way through — this is a fact about the browser, not
  // about an account.
  await expect(page.locator(".account")).toContainText("Sign in");
});

// ── the shelf screen ───────────────────────────────────────────────────────
test("the shelf is a feed of what you saved, newest save first", async ({
  page,
  api,
}) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const feedIds = await idsOnScreen(page);

  // Save the third card, then the first — so save order and feed order differ.
  await openCard(page, 2);
  await page.locator(SAVE).click();
  await page.locator(".back").click();
  await expect(page.locator(CARD)).toHaveCount(3);
  await openCard(page, 0);
  await page.locator(SAVE).click();

  await page.locator(HEADER_SHELF).click();
  await expect(page.locator(".shelf__title")).toHaveText("Your shelf");
  await expect(page.locator(CARD)).toHaveCount(2);
  expect(await idsOnScreen(page)).toEqual([feedIds[0], feedIds[2]]);
});

test("an empty shelf is an invitation, not an apology", async ({ page, api }) => {
  await api.seed(1);
  await page.goto("/#/shelf");
  await expect(page.locator(".shelf__title")).toBeVisible();
  await expect(page.locator(".feed__status")).toHaveText(
    "Nothing here yet. Open a post and press Save to keep it for later."
  );
  await expect(page.locator(CARD)).toHaveCount(0);
});

test("the palette can always open it, empty or not", async ({ page, api }) => {
  await api.seed(1);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+k");
  const row = page.locator(".palette__row", { hasText: "Open your shelf" });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/#\/shelf$/);
  await expect(page.locator(".shelf__title")).toBeVisible();
});

test("reading on works from the shelf, and names it", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const feedIds = await idsOnScreen(page);

  await plantShelf(page, [feedIds[0], feedIds[1]]);
  await gotoPlanted(page, "/#/shelf");
  await expect(page.locator(CARD)).toHaveCount(2);

  await openCard(page, 0);
  await expect(page.locator(".onward__head")).toHaveText("More from your shelf");
  await expect(page.locator(".onward__item--next .onward__title")).toBeVisible();
});

// ── a saved post that stops existing ───────────────────────────────────────
test("a post that has been deleted drops off the shelf", async ({ page, api }) => {
  await api.seed(2, "ada@commons.test");
  await api.signIn(page, "ada@commons.test", "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await openCard(page, 0);
  await page.locator(SAVE).click();
  expect(await shelfIds(page)).toHaveLength(1);

  // Ada deletes her own post. The shelf has no way to hear about that, and is
  // not supposed to — it finds out by asking.
  await page.getByRole("button", { name: "Delete" }).click();
  await page.locator(".confirm .btn--danger").click();
  await expect(page).toHaveURL(/#\/$/);

  await page.goto("/#/shelf");
  await expect(page.locator(".feed__status")).toHaveText(
    "Nothing here yet. Open a post and press Save to keep it for later."
  );
  expect(await shelfIds(page)).toEqual([]);
  // And the header stops offering a shelf that has nothing on it.
  await expect(page.locator(HEADER_SHELF)).toHaveCount(0);
});

test("one missing post does not take the page with it", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const feedIds = await idsOnScreen(page);

  // An id that was never a post, between two that are.
  await plantShelf(page, [feedIds[0], 999999, feedIds[1]]);
  await gotoPlanted(page, "/#/shelf");

  await expect(page.locator(CARD)).toHaveCount(2);
  expect(await idsOnScreen(page)).toEqual([feedIds[0], feedIds[1]]);
  expect(await shelfIds(page)).toEqual([feedIds[0], feedIds[1]]);
  await expect(page.locator(".feed__error")).toHaveCount(0);
});

// ── the quality floor ──────────────────────────────────────────────────────
test("axe is clean on the shelf, both themes", async ({ page, api }) => {
  await api.seed(3);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);
  const feedIds = await idsOnScreen(page);

  await plantShelf(page, [feedIds[0], feedIds[1]]);
  await gotoPlanted(page, "/#/shelf");
  await expect(page.locator(CARD)).toHaveCount(2);

  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await settled(page);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(result.violations, `${theme} theme`).toEqual([]);
  }
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

  test("the header still fits with a shelf on it, signed in", async ({ page, api }) => {
    await api.seed(2, "ada@commons.test");
    await api.signIn(page, "ada@commons.test", "seedpassword");
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(2);

    await openCard(page, 0);
    await page.locator(SAVE).click();
    await expect(page.locator(HEADER_SHELF)).toHaveCount(1);

    // The widest the signed-in header ever gets: Write, Shelf, Sign out, theme.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);

    const box = await page.locator(HEADER_SHELF).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);

    // And the save control keeps its word beside the vote count.
    await expect(page.locator(SAVE)).toHaveText("Saved");
    const row = await page.evaluate(() => {
      const el = document.querySelector(".detail__row");
      const r = el.getBoundingClientRect();
      return {
        right: Math.round(r.right),
        width: Math.round(document.documentElement.clientWidth),
      };
    });
    expect(row.right).toBeLessThanOrEqual(row.width);
  });
});

// ── the account's half ──────────────────────────────────────────────────────
// Everything above is about a shelf in a browser. These are about the one on
// the server, and about the moment the two meet.

const ACCOUNT = { email: "mira@commons.test", password: "seedpassword" };

/**
 * What the *server* thinks is on this account's shelf.
 *
 * `shelfIds` reads the local mirror, which is written optimistically — so it
 * says yes the instant the control is pressed and long before anything has been
 * recorded. Every test below that then throws the mirror away has to know the
 * write actually landed first, or it is racing its own setup.
 *
 * Asked through the app's own API client rather than with a fetch of our own,
 * so this works unchanged against both projects: in demo mode `api.get` goes to
 * js/demo/backend.js in the same window, and against the mock it goes over HTTP
 * with whatever token the app is holding. `background` so a 401 here can never
 * move the page out from under the test.
 */
const onTheServer = (page) =>
  page.evaluate(async () => {
    const { api } = await import("/js/api.js");
    const res = await api.get("/shelf", { background: true });
    return res.items.map((post) => post.id);
  });

/** Seed `n` posts and come back with their ids, newest first. */
async function seedPosts(page, api, n) {
  await api.seed(n, "ada@commons.test");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(n);
  return idsOnScreen(page);
}

/**
 * Sign in the way a reader does, through the form.
 *
 * Not `api.signIn`, and the difference matters for exactly one test. Against
 * demo mode that fixture reinstalls the Node-side copy of the demo state as an
 * init script, which is right for setting a test up and wrong once the *page*
 * has written something the Node-side copy has never heard of — it would
 * replace the page's state and take that write with it. Filling the form leaves
 * whatever the page has alone, which is also what actually happens to a reader.
 */
async function signInWithForm(page, { email, password }) {
  await page.goto("/#/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/#\/$/);
}

async function signOut(page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
}

test("signing in merges this browser's shelf into the account's", async ({
  page,
  api,
}) => {
  await api.register(ACCOUNT.email, ACCOUNT.password, "mira");
  const [newer, older] = await seedPosts(page, api, 2);

  // One saved from "another device" — on the account, and then signed out of,
  // so this browser's mirror no longer holds it.
  await api.signIn(page, ACCOUNT.email, ACCOUNT.password);
  await page.goto(`/#/posts/${older}`);
  await page.locator(SAVE).click();
  await expect.poll(() => onTheServer(page)).toEqual([older]);
  await signOut(page);
  expect(await shelfIds(page)).toEqual([]);

  // And one saved right here, signed out, which lives only in localStorage.
  await page.goto(`/#/posts/${newer}`);
  await page.locator(SAVE).click();
  expect(await shelfIds(page)).toEqual([newer]);

  await signInWithForm(page, ACCOUNT);

  // A union, not a replacement. Losing the save you made a minute ago because
  // you signed in is the one outcome that would make this feature feel unsafe.
  await expect
    .poll(async () => (await shelfIds(page)).slice().sort())
    .toEqual([newer, older].sort());
});

test("a save made while signed in survives losing the local mirror", async ({
  page,
  api,
}) => {
  await api.register(ACCOUNT.email, ACCOUNT.password, "mira");
  const [first] = await seedPosts(page, api, 1);
  await api.signIn(page, ACCOUNT.email, ACCOUNT.password);

  await page.goto(`/#/posts/${first}`);
  await page.locator(SAVE).click();
  // The server's copy, not the mirror's — the mirror says yes optimistically,
  // and clearing it before the write landed would be racing our own setup.
  await expect.poll(() => onTheServer(page)).toEqual([first]);

  // The whole point of the server half. Clearing the mirror is what a second
  // device looks like from here: same account, nothing cached.
  await page.evaluate(() => {
    localStorage.removeItem("commons.shelf");
    localStorage.removeItem("commons.shelf.owner");
  });
  await page.reload();

  await expect.poll(() => shelfIds(page)).toEqual([first]);
});

test("signing out takes an account's shelf off this browser", async ({ page, api }) => {
  await api.register(ACCOUNT.email, ACCOUNT.password, "mira");
  const [first] = await seedPosts(page, api, 1);
  await api.signIn(page, ACCOUNT.email, ACCOUNT.password);

  await page.goto(`/#/posts/${first}`);
  await page.locator(SAVE).click();
  await expect.poll(() => onTheServer(page)).toEqual([first]);

  await signOut(page);

  // Somebody else's reading list should not be sitting on a shared machine
  // after they have left.
  await expect.poll(() => shelfIds(page)).toEqual([]);
});

test("signing out leaves a shelf that was never an account's", async ({
  page,
  api,
}) => {
  const [first] = await seedPosts(page, api, 1);

  // Saved signed out, and nobody ever signed in — so this belongs to the
  // browser, and nothing about a session should empty it.
  await plantShelf(page, [first]);
  await gotoPlanted(page, "/#/");
  expect(await shelfIds(page)).toEqual([first]);

  await page.reload();
  expect(await shelfIds(page)).toEqual([first]);
});

test("a save the server refuses puts the control back", async ({ page, api }) => {
  await api.register(ACCOUNT.email, ACCOUNT.password, "mira");
  const [first] = await seedPosts(page, api, 1);
  await api.signIn(page, ACCOUNT.email, ACCOUNT.password);
  await page.goto(`/#/posts/${first}`);

  const control = page.locator(SAVE);
  await expect(control).toHaveAttribute("aria-pressed", "false");

  await api.failNext({ method: "PUT", path: "/posts/\\d+/save", status: 500 });
  await control.click();

  // Optimistic on the way in and rolled back when the request lands badly —
  // the same contract the vote control has had since the beginning.
  await expect(control).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => shelfIds(page)).toEqual([]);
});
