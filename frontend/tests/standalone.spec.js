// What changes when Commons is an app rather than a tab.
//
// Four separate things, and only one of them is visible on this page: the
// unread count on the app's icon, the title bar taking the reader's theme
// rather than the operating system's, the share sheet standing in for the
// clipboard where there is one, and Back still working in a window with no
// address bar to escape to.
//
// ── what cannot be driven from here ────────────────────────────────────────
// A real standalone window. `display-mode` is not emulable: Playwright's
// emulateMedia has no such feature and CDP's Emulation.setEmulatedMedia
// ignores it — both checked, the same way tests/install.spec.js reports the
// same about `beforeinstallprompt`. So the one *CSS* change is checked through
// the CSSOM instead: that the browser parsed the media query and that the rule
// inside it is the rule intended. That is weaker than seeing it applied, and
// it is the part that would actually rot — a typo in a media feature is
// dropped silently by the parser and by every other test in this suite.
//
// Everything else here is exercised for real.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("@playwright/test");
const { test, expect, CARD } = require("./support/fixtures");

// Chrome's --app= opens a genuine frameless window: no address bar, no tab
// strip, and `display-mode: standalone` really matches inside it. It is the one
// way to see the stylesheet below actually applied rather than merely parsed.
//
// It needs a display. On this project's CI — ubuntu-latest, headless, no X —
// there isn't one, which is the same situation tests/visual.spec.js is in and
// gets the same answer: the weaker check runs everywhere, the real one runs
// where somebody could look at the window it opens.
const HAS_DISPLAY =
  process.platform === "darwin" ||
  process.platform === "win32" ||
  !!process.env.DISPLAY;

const ADA = "ada@commons.test";
const BEA = "bea@commons.test";

/** Record every badge call the app makes, before any app code has run. */
const watchBadge = (page) =>
  page.addInitScript(() => {
    window.__badge = [];
    Object.defineProperty(navigator, "setAppBadge", {
      configurable: true,
      value: (n) => {
        window.__badge.push(n);
        return Promise.resolve();
      },
    });
    Object.defineProperty(navigator, "clearAppBadge", {
      configurable: true,
      value: () => {
        window.__badge.push(0);
        return Promise.resolve();
      },
    });
  });

/**
 * Give the browser a share sheet.
 * @param {import("@playwright/test").Page} page
 * @param {{ reject?: string }} [how] the `name` of the error it should reject
 *   with instead of resolving
 */
const giveShareSheet = (page, how = {}) =>
  page.addInitScript((reject) => {
    window.__shared = [];
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: (data) => {
        window.__shared.push(data);
        if (!reject) return Promise.resolve();
        const err = new Error("no");
        err.name = reject;
        return Promise.reject(err);
      },
    });
  }, how.reject || "");

/**
 * Two people and a post by Ada — the same room tests/notifications.spec.js
 * uses, and then actually opened.
 *
 * api.signIn installs a session without navigating anywhere, so the page is
 * still blank when it returns. Everything below reaches for the header, so the
 * goto is part of the setup rather than something each test remembers.
 */
async function room(page, api, as = ADA) {
  await api.seed(1, ADA);
  await api.register(BEA, "seedpassword", "bea");
  await api.signIn(page, as, "seedpassword");
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);
}

/** Sign in as somebody else through the form, so the adapter keeps what happened. */
async function switchTo(page, email) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator(".account")).toContainText("Sign in");
  await page.getByRole("link", { name: "Sign in" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("seedpassword");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);
}

/** Say something on the first post, as whoever is signed in. */
async function comment(page, words) {
  if (!/#\/$/.test(page.url())) await page.goto("/#/");
  await expect(page.locator(CARD).first()).toBeVisible();
  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.getByLabel("Add a comment").fill(words);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".comment").last()).toContainText(words);
}

// ── the badge ──────────────────────────────────────────────────────────────
test("a fresh boot says zero, so yesterday's badge doesn't survive the night", async ({
  page,
  api,
}) => {
  // A badge is on the icon, and the icon is still there tomorrow. Nothing in
  // the app would otherwise clear one left by a previous session until the
  // first notification of the day arrived.
  await watchBadge(page);
  await api.seed(1);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);

  await expect.poll(() => page.evaluate(() => window.__badge)).toContain(0);
});

test("the count on the lamp is the count on the icon", async ({ page, api }) => {
  await watchBadge(page);
  await room(page, api, ADA);

  // Bea says something on Ada's post, then Ada comes back to find it. This is
  // the long way round on purpose: the badge has to follow a number the app
  // worked out for itself, not one a test handed it.
  await switchTo(page, BEA);
  await comment(page, "I walked past it too");
  await switchTo(page, ADA);

  await expect(page.locator(".lamp__count")).toHaveText("1");
  await expect.poll(() => page.evaluate(() => window.__badge.at(-1))).toBe(1);

  // And it goes out when they have been looked at, in the same movement as the
  // lamp — markAllSeen announces zero, and the badge is downstream of that.
  await page.goto("/#/notifications");
  await expect(page.locator(".notice").first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__badge.at(-1))).toBe(0);
});

test("signing out takes the badge with it", async ({ page, api }) => {
  await watchBadge(page);
  await room(page, api, ADA);
  await switchTo(page, BEA);
  await comment(page, "Something to answer");
  await switchTo(page, ADA);
  await expect.poll(() => page.evaluate(() => window.__badge.at(-1))).toBe(1);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator(".account")).toContainText("Sign in");

  // Nobody's number should be left sitting on the dock of a machine somebody
  // else is about to use.
  await expect.poll(() => page.evaluate(() => window.__badge.at(-1))).toBe(0);
});

test("a browser with no badge API is not a broken app", async ({ page, api }) => {
  // The guard is the whole feature on Firefox and on desktop Safari. Nothing
  // should throw, and the lamp should carry on as it always did.
  await page.addInitScript(() => {
    delete Navigator.prototype.setAppBadge;
    delete Navigator.prototype.clearAppBadge;
    window.__errors = [];
    addEventListener("error", (e) => window.__errors.push(String(e.message)));
    addEventListener("unhandledrejection", (e) =>
      window.__errors.push(String(e.reason))
    );
  });
  await room(page, api, ADA);
  await switchTo(page, BEA);
  await comment(page, "Still fine");
  await switchTo(page, ADA);

  await expect(page.locator(".lamp__count")).toHaveText("1");
  expect(await page.evaluate(() => window.__errors)).toEqual([]);
});

// ── the title bar ──────────────────────────────────────────────────────────
const themeColors = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('meta[name="theme-color"]')].map((m) =>
      m.getAttribute("content")
    )
  );

const pageBg = (page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()
  );

test("the title bar follows the theme, and keeps following it", async ({
  page,
  api,
}) => {
  await api.seed(1);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);

  const before = await pageBg(page);
  expect(await themeColors(page)).not.toHaveLength(0);
  for (const value of await themeColors(page)) expect(value).toBe(before);

  await page.keyboard.press("t");
  await expect.poll(async () => (await themeColors(page))[0]).not.toBe(before);

  // Read back off the page rather than compared to a colour typed in here: the
  // point is that the title bar cannot drift from --bg, not that --bg is any
  // particular string.
  const after = await pageBg(page);
  for (const value of await themeColors(page)) expect(value).toBe(after);
});

test.describe("a light reader on a dark desktop", () => {
  test.use({ colorScheme: "dark" });

  test("gets a light title bar, not the operating system's dark one", async ({
    page,
    api,
  }) => {
    // The exact case the two media-keyed metas in index.html get wrong: they
    // answer the operating system, and the theme here is the reader's own
    // choice out of localStorage.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("commons.theme", "light");
      } catch (e) {}
    });
    await api.seed(1);
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(1);

    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(
      "light"
    );
    const bg = await pageBg(page);
    for (const value of await themeColors(page)) expect(value).toBe(bg);
  });
});

// ── the share sheet ────────────────────────────────────────────────────────
async function aPost(page, api) {
  const { created } = await (await api.seed(1, ADA)).json();
  await page.goto(`/#/posts/${created[0]}`);
  await expect(page.locator(".detail__title")).toBeVisible();
  return created[0];
}

test("where there is no share sheet the row is still the clipboard", async ({
  page,
  api,
}) => {
  // Which is this browser: Playwright's Chromium has no navigator.share at
  // all. The row must not promise one.
  await aPost(page, api);
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("option", { name: "Copy a link to this post" })
  ).toHaveCount(1);
  await expect(page.getByRole("option", { name: "Share this post" })).toHaveCount(0);
});

test("where there is one, the row says so and opens it", async ({ page, api }) => {
  await giveShareSheet(page);
  const id = await aPost(page, api);

  await page.keyboard.press("Control+k");
  const row = page.getByRole("option", { name: "Share this post" });
  await expect(row).toHaveCount(1);
  await row.click();

  const shared = await page.evaluate(() => window.__shared);
  expect(shared).toHaveLength(1);
  expect(shared[0].url).toContain(`#/posts/${id}`);
  // The post's own title, so the sheet offers something worth reading rather
  // than a bare URL.
  expect(shared[0].title).toBeTruthy();
  expect(shared[0].title).not.toBe("Commons");
});

test("closing the sheet without picking anything says nothing at all", async ({
  page,
  api,
}) => {
  // AbortError is the reader changing their mind. An app that answered that
  // with "couldn't share" — or that quietly copied instead — would be arguing
  // with them.
  await giveShareSheet(page, { reject: "AbortError" });
  // Stubbed so the fallback, if it were wrongly taken, would land *fast*. The
  // first version of this test asserted the absence of a toast before the real
  // clipboard had finished failing, and passed against code with the
  // AbortError branch deleted.
  await page.addInitScript(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (text) => {
      window.__copied = text;
    };
  });
  await aPost(page, api);

  await page.keyboard.press("Control+k");
  await page.getByRole("option", { name: "Share this post" }).click();

  await expect.poll(() => page.evaluate(() => window.__shared.length)).toBe(1);
  // Asserting that nothing happened needs a window for it to have happened in.
  // The fallback is two microtasks behind the rejection once the clipboard is
  // a stub, so this is generous by three orders of magnitude.
  await page.waitForTimeout(400);

  expect(await page.evaluate(() => window.__copied)).toBeNull();
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("a sheet that fails for any other reason falls back to the clipboard", async ({
  page,
  api,
}) => {
  await giveShareSheet(page, { reject: "NotAllowedError" });
  await page.addInitScript(() => {
    window.__copied = null;
    navigator.clipboard.writeText = async (text) => {
      window.__copied = text;
    };
  });
  const id = await aPost(page, api);

  await page.keyboard.press("Control+k");
  await page.getByRole("option", { name: "Share this post" }).click();

  await expect
    .poll(() => page.evaluate(() => window.__copied))
    .toContain(`#/posts/${id}`);
  await expect(page.getByText("Link copied.")).toBeVisible();
});

test("the C key does whichever of the two the row promised", async ({ page, api }) => {
  // The palette's rule is that the keys it advertises work outside it. The row
  // is relabelled by capability, so the key has to move with it.
  await giveShareSheet(page);
  await aPost(page, api);
  await page.keyboard.press("c");
  await expect.poll(() => page.evaluate(() => window.__shared.length)).toBe(1);
});

// ── the standalone branch ──────────────────────────────────────────────────
test("the standalone rule is one the browser understood", async ({ page, api }) => {
  await api.seed(1);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(1);

  // A media feature the browser does not know is not an error — the query
  // evaluates to "not all" and the whole block is skipped in silence, which is
  // exactly how a typo in one survives every other test in this suite.
  expect(
    await page.evaluate(() => matchMedia("(display-mode: standalone)").media)
  ).not.toBe("not all");

  const found = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        continue; // a cross-origin sheet, which none of ours are
      }
      for (const rule of rules) {
        if (!(rule instanceof CSSMediaRule)) continue;
        if (!rule.conditionText.includes("display-mode")) continue;
        return {
          condition: rule.conditionText,
          declarations: [...rule.cssRules].map((r) => r.cssText),
        };
      }
    }
    return null;
  });

  expect(found, "no @media (display-mode: …) block reached the browser").not.toBeNull();
  // Both, because display_override asks for standalone and falls back to
  // minimal-ui, and a window with no tab strip is a window with no tab strip.
  expect(found.condition).toContain("standalone");
  expect(found.condition).toContain("minimal-ui");
  expect(found.declarations.join(" ")).toContain(".site-header");
  expect(found.declarations.join(" ")).toContain("border-bottom-color");
});

test("and in a real frameless window, the edge is actually drawn", async ({
  baseURL,
}, testInfo) => {
  test.skip(
    !HAS_DISPLAY,
    "no display to open a window on — the CSSOM check above is the floor here"
  );
  test.skip(
    testInfo.project.name !== "chromium",
    "this launches its own browser and never touches the API, so once is enough"
  );

  // Its own browser, because --app is a launch argument and the page fixture's
  // was started without it.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "commons-standalone-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--app=${baseURL}/?demo=1#/`],
    // An explicit size rather than the window's own: the runner folds the
    // project's `use` options into every context it makes, and a null viewport
    // collides with the deviceScaleFactor that comes with Desktop Chrome. The
    // page size is not what is being tested — display-mode is, and it is a
    // property of the window, not of the viewport.
    viewport: { width: 900, height: 700 },
  });
  try {
    let page = ctx.pages()[0];
    await expect
      .poll(
        () => {
          page = ctx.pages().find((p) => p.url().startsWith("http")) || page;
          return page?.url() || "";
        },
        { timeout: 20_000 }
      )
      .toContain("demo=1");
    await page.waitForSelector(CARD, { timeout: 20_000 });

    const seen = await page.evaluate(() => {
      const header = document.querySelector(".site-header");
      const root = getComputedStyle(document.documentElement);
      const norm = (v) => v.trim().replace(/\s+/g, " ");
      return {
        standalone: matchMedia("(display-mode: standalone)").matches,
        browser: matchMedia("(display-mode: browser)").matches,
        edge: norm(getComputedStyle(header).borderBottomColor),
        border: norm(root.getPropertyValue("--border")),
        strong: norm(root.getPropertyValue("--border-strong")),
      };
    });

    // Really a frameless window, not a tab that happens to be maximised.
    expect(seen.standalone).toBe(true);
    expect(seen.browser).toBe(false);

    // And the rule applied: one step more definite than the hairline a tab
    // gets, because in here there is no browser chrome above it doing the job.
    expect(seen.edge).toBe(seen.strong);
    expect(seen.edge).not.toBe(seen.border);
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

// ── back, with nowhere else to go ──────────────────────────────────────────
test("Back still works where there is no address bar to escape to", async ({
  page,
  api,
}) => {
  // In a tab a dead Back is an annoyance, because the address bar is right
  // there. In a frameless window it is a trap: the gesture is the only way out
  // of a screen. The app is hash-routed, so this is really a check that
  // nothing on the way in replaced a history entry instead of pushing one.
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();

  await page.goBack();
  await expect(page.locator(CARD)).toHaveCount(2);
  await expect(page).toHaveURL(/#\/$/);
});

test("and works back out of a screen reached from a screen", async ({ page, api }) => {
  await api.seed(2);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(2);

  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.locator(".detail__byline a.name").click();
  await expect(page).toHaveURL(/#\/u\//);

  await page.goBack();
  await expect(page.locator(".detail__title")).toBeVisible();
  await page.goBack();
  await expect(page.locator(CARD)).toHaveCount(2);
});
