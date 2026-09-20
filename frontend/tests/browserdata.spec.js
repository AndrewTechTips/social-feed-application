// "What this browser knows about you" — the data panel on #/settings.
//
// The panel makes two promises and this file holds it to both.
//
//   **It is complete.** Every key the app keeps is on the list, or exempt by
//   name with a reason. The last test greps the source for `commons.*` and
//   fails on anything that is neither — the same trick offline.spec.js plays
//   on the service worker's shell, and for the same reason: a list maintained
//   by hand drifts, and the way this one drifts is that the app quietly starts
//   keeping something the privacy screen does not mention.
//
//   **The controls work, and are believed.** A control that clears storage but
//   leaves the line above it reading "47 posts" has not convinced anybody, so
//   every clearing test checks the row afterwards as well as the disk. The
//   shelf gets the most attention because it is the only one with a server
//   half — clearing the mirror alone would last until the next boot and then
//   the sync would put it all back.

const fs = require("fs");
const path = require("path");
const AxeBuilder = require("@axe-core/playwright").default;
const {
  test,
  expect,
  CARD,
  settled,
  accountButton,
  openAccountMenu,
} = require("./support/fixtures");

const ACCOUNT = { email: "ada@commons.test", password: "seedpassword" };

const panel = (page) => page.locator(".data");
const row = (page, id) => page.locator(`[data-row="${id}"]`);
const control = (page, id) => row(page, id).locator(".data__do");
const sweep = (page) => page.locator(".data__sweep");

/** What a row is currently claiming, whitespace flattened. */
const says = (page, id) =>
  row(page, id).evaluate((el) => el.textContent.replace(/\s+/g, " ").trim());

/** What is actually on disk, which is the other half of every assertion here. */
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

async function onSettings(page, api, { posts = 2 } = {}) {
  await api.seed(posts, ACCOUNT.email);
  await api.signIn(page, ACCOUNT.email, ACCOUNT.password);
  await page.goto("/#/settings");
  await expect(panel(page)).toBeVisible();
}

/** Save the first post through the interface, so both halves of the shelf hear. */
async function saveFirstPost(page) {
  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.locator(".shelved").click();
  await expect(page.locator(".shelved")).toHaveText("Saved");
}

/** What the *server* has on this account's shelf. */
const onTheServer = (page) =>
  page.evaluate(async () => {
    const { api } = await import("/js/api.js");
    const res = await api.get("/shelf", { background: true });
    return res.items.map((post) => post.id);
  });

// ── the shape of it ────────────────────────────────────────────────────────

test("the screen is three numbered parts, and the account one is unchanged", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(page.locator(".settings__group-head")).toHaveText([
    /Your account/,
    /This browser/,
    /About/,
  ]);

  // Everything that was on the old screen is still on this one, in order and
  // doing the same thing. The plan asked for it to move in unchanged.
  await expect(page.locator("#settings-username")).toHaveValue("ada");
  await expect(page.locator(".settings__value")).toHaveText(ACCOUNT.email);
  await expect(page.locator(".settings__note")).toContainText("no way to send mail");
  await expect(page.getByRole("button", { name: "Sign out everywhere" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete your account" })).toBeVisible();

  // The numbers are decoration: a screen reader hears the words alone.
  const heard = await page
    .locator(".settings__group-head")
    .first()
    .evaluate((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll("[aria-hidden='true']").forEach((n) => n.remove());
      return clone.textContent.trim();
    });
  expect(heard).toBe("Your account");
});

test("every row names its keys, its size and what it is for", async ({ page, api }) => {
  await onSettings(page, api);

  for (const id of ["read", "shelf", "draft", "appearance", "signin"]) {
    await expect(row(page, id)).toBeVisible();
    // A size on every line, always a measurement rather than a word — the
    // column reads down the list.
    await expect(row(page, id).locator(".data__size")).toHaveText(/^\d/);
    // And the key names, because a panel about storage that would not say
    // what it is called is asking to be taken on trust.
    await expect(row(page, id).locator(".data__key").first()).toContainText("commons.");
  }

  await expect(row(page, "read")).toContainText("commons.read");
  await expect(row(page, "read")).toContainText("sent nowhere");
});

test("the sign-in row explains itself instead of offering a button", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  await expect(row(page, "signin")).toContainText("Signed in as ada");
  await expect(control(page, "signin")).toHaveCount(0);
  // It holds real bytes and has no control, which is the one row where that
  // is deliberate — so it has to say where signing out actually lives.
  await expect(row(page, "signin")).toContainText("Sign out from the menu");
  // And it must not print a stray "null" where the control would be, which is
  // what Element.append does with one.
  expect(await says(page, "signin")).not.toContain("null");
});

// ── the controls ───────────────────────────────────────────────────────────

test("forgetting what you've read clears both keys and says so at once", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  // Read something, the long way, so there is a real mark to forget.
  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.waitForTimeout(2200); // SETTLE_MS in reading.js, plus a margin
  await page.goto("/#/settings");
  await expect(panel(page)).toBeVisible();

  await expect(row(page, "read")).toContainText("One post");
  await control(page, "read").click();

  // The row, not just the disk. This is the assertion the feature is for.
  await expect(row(page, "read")).toContainText("Nothing yet");
  await expect(row(page, "read").locator(".data__size")).toHaveText("0 bytes");
  await expect(control(page, "read")).toHaveCount(0);
  expect(await stored(page, "commons.read")).toBeNull();
  expect(await stored(page, "commons.visit")).toBeNull();
  await expect(page.locator(".toast")).toContainText("Forgotten");
});

test("a browser that has visited but read nothing can still clear the stamp", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  // `commons.visit` is written at boot whether or not anything is opened, so
  // this row holds bytes on a first visit. It used to say "Nothing yet" over
  // 35 stored bytes with no button — a line the panel could not clear, on the
  // one screen whose promise is that it can.
  expect(await stored(page, "commons.visit")).not.toBeNull();
  await expect(row(page, "read")).toContainText("just when you were last here");
  await control(page, "read").click();

  expect(await stored(page, "commons.visit")).toBeNull();
  await expect(row(page, "read").locator(".data__size")).toHaveText("0 bytes");
});

test("emptying the shelf empties the account's, not just the mirror", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  await saveFirstPost(page);
  await expect.poll(() => onTheServer(page)).toHaveLength(1);

  await page.goto("/#/settings");
  await expect(row(page, "shelf")).toContainText("One post");
  await control(page, "shelf").click();
  await expect(row(page, "shelf")).toContainText("Empty");

  // The half a mirror-only version would have missed.
  await expect.poll(() => onTheServer(page)).toEqual([]);
});

test("and it stays empty after a reload, which is the whole point", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  await saveFirstPost(page);
  await expect.poll(() => onTheServer(page)).toHaveLength(1);

  await page.goto("/#/settings");
  await control(page, "shelf").click();
  await expect(row(page, "shelf")).toContainText("Empty");
  // The row empties on the press — the local clear is optimistic, the same way
  // toggleShelf is — so the server has to be waited for before reloading.
  // Reloading on the strength of the row alone aborts the deletes in flight,
  // and then what this measures is whether the sync restores them. It does.
  await expect.poll(() => onTheServer(page)).toEqual([]);

  // syncShelf() runs at boot for a returning reader: it pushes the local list
  // up and pulls the account's down. Clearing only the mirror would be undone
  // right here, and the control would read as broken on the second visit
  // rather than the first — which is the kind of bug that ships.
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await expect(row(page, "shelf")).toContainText("Empty");
  expect(await onTheServer(page)).toEqual([]);
});

test("emptying the shelf updates the header without a reload", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  await saveFirstPost(page);
  await page.goto("/#/settings");

  await openAccountMenu(page);
  await expect(page.locator(".accmenu__row[href='#/shelf']")).toHaveAttribute(
    "aria-label",
    "Your shelf, one post saved"
  );
  await page.keyboard.press("Escape");

  await control(page, "shelf").click();
  await expect(row(page, "shelf")).toContainText("Empty");

  // Same page, no navigation: the menu is fed by the same commons:shelf event
  // the panel is, so the two cannot disagree.
  await openAccountMenu(page);
  await expect(page.locator(".accmenu__row[href='#/shelf']")).toHaveAttribute(
    "aria-label",
    "Your shelf, empty"
  );
});

test("discarding the draft takes it out of the composer too", async ({ page, api }) => {
  await onSettings(page, api);

  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill("A half-written thought");
  await expect
    .poll(() => stored(page, "commons.draft"))
    .toContain("A half-written thought");

  await page.goto("/#/settings");
  await expect(row(page, "draft")).toContainText("A half-written thought");
  await control(page, "draft").click();
  await expect(row(page, "draft")).toContainText("Nothing saved");
  expect(await stored(page, "commons.draft")).toBeNull();

  // And the composer agrees — no offer to pick up where you left off.
  await page.goto("/#/compose");
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("");
});

test("resetting how you read puts the page back, live", async ({ page, api }) => {
  await onSettings(page, api);

  await page.evaluate(async () => {
    const reading = await import("/js/reading.js");
    reading.setTextSize("l");
    reading.setMeasure("narrow");
    localStorage.setItem("commons.theme", "light");
    document.documentElement.dataset.theme = "light";
  });
  await expect(row(page, "appearance")).toContainText(
    "Theme, text size and line width"
  );

  await control(page, "appearance").click();

  await expect(row(page, "appearance")).toContainText("Nothing set");
  expect(await stored(page, "commons.theme")).toBeNull();
  expect(await stored(page, "commons.textsize")).toBeNull();
  expect(await stored(page, "commons.measure")).toBeNull();

  // Applied to the document there and then. A "reset" that needed a reload to
  // be visible would be a reset nobody believed.
  const html = await page.evaluate(() => ({
    size: document.documentElement.dataset.textSize,
    measure: document.documentElement.dataset.measure,
  }));
  expect(html).toEqual({ size: "m", measure: "normal" });
});

test("the theme goes back to following the system, not to a pinned default", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  // Through the app's own action rather than by writing the key. Setting
  // storage directly announces nothing, so the panel never repaints and the
  // control never appears — a fact about this test rather than about the app,
  // and the first version of it spent thirty seconds waiting for a button
  // that had no reason to exist.
  await page.evaluate(async () => {
    // Unconditionally, and *not* "toggle to light if it isn't". Playwright's
    // Desktop Chrome emulates prefers-color-scheme: light and the bootstrap
    // in index.html follows it, so the page is already light and a
    // conditional toggle is a toggle that never happens — leaving nothing
    // pinned and no control to press. Which way it goes does not matter here;
    // that a value is now stored does.
    const { toggleTheme } = await import("/js/actions.js");
    toggleTheme();
  });
  await expect(control(page, "appearance")).toBeVisible();
  await control(page, "appearance").click();

  // The distinction the whole function exists for. Writing the system's
  // current answer into the key would look identical on screen and pin the
  // reader to it for ever — the bootstrap in index.html only consults
  // prefers-color-scheme when the key is absent.
  expect(await stored(page, "commons.theme")).toBeNull();

  const follows = await page.evaluate(() => {
    const system = matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
    return document.documentElement.dataset.theme === system;
  });
  expect(follows).toBe(true);
});

// ── the panel stays true while it is open ─────────────────────────────────

test("a change made somewhere else repaints the panel", async ({ page, api }) => {
  await onSettings(page, api);
  // A fresh browser has nothing pinned, so this row starts with no control at
  // all — which is the state the test wants, and which it used to try to
  // reach by pressing a button that did not exist.
  await expect(row(page, "appearance")).toContainText("Nothing set");
  await expect(control(page, "appearance")).toHaveCount(0);

  // The theme toggle in the header, with this screen still on the page. The
  // panel's claim is "this is what is stored", so it cannot be the last thing
  // on the page to find out that something now is.
  await page.getByRole("button", { name: /switch to (light|dark) theme/i }).click();

  await expect(row(page, "appearance")).toContainText(
    "Theme, text size and line width"
  );
  await expect(control(page, "appearance")).toBeVisible();
});

// ── forget everything ──────────────────────────────────────────────────────

test("forgetting everything clears the lot and leaves you signed in", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  await saveFirstPost(page);
  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill("Something unfinished");
  await expect.poll(() => stored(page, "commons.draft")).not.toBeNull();
  await page.goto("/#/settings");
  await expect(panel(page)).toBeVisible();

  await sweep(page)
    .getByRole("button", { name: "Forget everything on this browser" })
    .click();
  // It says what it will and will not do before it does it.
  await expect(page.locator(".data__ask")).toContainText("leaves you signed in");
  await page.getByRole("button", { name: "Yes, forget it all" }).click();

  await expect(row(page, "read")).toContainText("Nothing yet");
  await expect(row(page, "shelf")).toContainText("Empty");
  await expect(row(page, "draft")).toContainText("Nothing saved");
  await expect(row(page, "appearance")).toContainText("Nothing set");

  // The exception, and it is on the button's own confirmation.
  await expect(accountButton(page)).toBeVisible();
  await expect(row(page, "signin")).toContainText("Signed in as ada");
  expect(await stored(page, "commons.identity")).not.toBeNull();
});

test("with nothing to forget there is no button to press", async ({ page, api }) => {
  await onSettings(page, api);

  await sweep(page)
    .getByRole("button", { name: "Forget everything on this browser" })
    .click();
  await page.getByRole("button", { name: "Yes, forget it all" }).click();
  await expect(row(page, "read")).toContainText("Nothing yet");

  // An emptied shelf leaves `[]` behind — real bytes no control can remove —
  // so a byte count kept the button alive after a sweep had finished. It is
  // offered on whether any row still has something to clear.
  await expect(sweep(page)).toContainText("holding nothing of yours");
  await expect(
    sweep(page).getByRole("button", { name: "Forget everything on this browser" })
  ).toHaveCount(0);
});

test("it does not take the demo's own database with it", async ({
  page,
  api,
}, info) => {
  test.skip(info.project.name !== "demo", "there is no demo database to protect");
  await onSettings(page, api);

  const before = await stored(page, "commons.demo.v1");
  expect(before).not.toBeNull();

  await sweep(page)
    .getByRole("button", { name: "Forget everything on this browser" })
    .click();
  await page.getByRole("button", { name: "Yes, forget it all" }).click();
  await expect(row(page, "read")).toContainText("Nothing yet");

  // localStorage.clear() would have emptied the published site and left the
  // reader looking at an app with no posts and no way to refill it.
  expect(await stored(page, "commons.demo.v1")).not.toBeNull();
  await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
});

// ── the list cannot quietly fall behind the app ───────────────────────────

test("every key the app stores is on the panel, or exempt by name", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  // What the panel accounts for, asked of the running app rather than parsed
  // out of it — these are the strings it will actually clear.
  const { listed, exempt } = await page.evaluate(async () => {
    const m = await import("/js/browserdata.js");
    return {
      // LEGACY_KEYS separately: its row exists only when those keys do, and a
      // fresh test browser has never run a version that wrote them.
      listed: [...m.inventory().flatMap((r) => r.keys), ...m.LEGACY_KEYS],
      exempt: Object.keys(m.EXEMPT),
    };
  });
  const accountedFor = new Set([...listed, ...exempt]);

  // And what the source actually keeps. The same shape as the shell-list check
  // in offline.spec.js: the code is the source of truth and the list has to
  // keep up with it, not the other way round.
  const jsDir = path.join(__dirname, "..", "js");
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : full.endsWith(".js") ? [full] : [];
    });

  const found = new Set();
  for (const file of walk(jsDir)) {
    const src = fs.readFileSync(file, "utf8");
    for (const [, key] of src.matchAll(/"(commons\.[A-Za-z0-9._-]+)"/g)) {
      // The demo's fixtures use @commons.test email addresses, which are not
      // storage keys and never reach localStorage.
      if (key.endsWith(".test")) continue;
      found.add(key);
    }
  }

  const missing = [...found].filter((k) => !accountedFor.has(k));
  expect(
    missing,
    `these keys are stored but neither listed on the panel nor in EXEMPT:\n${missing.join("\n")}`
  ).toEqual([]);

  // And the other way: an exemption for something nobody stores any more is a
  // note about a problem that has gone.
  const stale = [...accountedFor].filter((k) => !found.has(k));
  expect(stale, `accounted for but not stored anywhere:\n${stale.join("\n")}`).toEqual(
    []
  );
});

// ── the quality floor ──────────────────────────────────────────────────────

test("axe is clean on the whole screen, both themes", async ({ page, api }) => {
  await onSettings(page, api);
  await saveFirstPost(page);
  await page.goto("/#/settings");
  await expect(panel(page)).toBeVisible();

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

test("the keyboard can work the panel, and keeps its place", async ({ page, api }) => {
  await onSettings(page, api);

  await control(page, "read").focus();
  await page.keyboard.press("Enter");

  // The control is gone once it has been used, so focus goes to the row it
  // belonged to. Letting it fall to the body would put a keyboard reader back
  // at the top of a long page for every control they pressed.
  await expect(row(page, "read")).toBeFocused();
  await expect(row(page, "read")).toContainText("Nothing yet");
});

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });

  test("the rows stack and nothing spills sideways", async ({ page, api }) => {
    await onSettings(page, api);

    await expect(row(page, "read")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // The control is a real tap target, not a link squeezed into a corner.
    const box = await control(page, "read").boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(36);
  });
});
