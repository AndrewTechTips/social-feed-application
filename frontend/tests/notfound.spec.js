// The address Commons doesn't have.
//
// One screen, and the tests fall into three groups: that the app *says* so
// rather than redirecting, that everything on it leads somewhere real, and
// that it doesn't quietly cost the reader something else — the feed left on
// screen under the wrong address, a title that lies in the history, a list the
// screen shouldn't be claiming to know about.

const { test, expect, CARD, settled } = require("./support/fixtures");

const BAD = "/#/not-a-place-in-this-app";

test.describe("an address that isn't here", () => {
  test("says so instead of redirecting, and keeps the address", async ({
    page,
    api,
  }) => {
    await api.seed(2, "ada@commons.test");
    await page.goto(BAD);

    await expect(page.locator(".notfound")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "There's nothing down this path." })
    ).toBeVisible();

    // The whole point of the change: the hash is left alone. A screen that
    // rewrites the address can't be bookmarked, reported or backed out of.
    await expect(page).toHaveURL(/#\/not-a-place-in-this-app$/);
  });

  test("quotes back the address that was asked for", async ({ page }) => {
    await page.goto("/#/posts/12/comments/4/edit");
    await expect(page.locator(".notfound__asked code")).toHaveText(
      "#/posts/12/comments/4/edit"
    );
  });

  test("a very long address is cut on the page but kept in full", async ({ page }) => {
    const long = "x".repeat(300);
    await page.goto(`/#/${long}`);

    const chip = page.locator(".notfound__asked code");
    const shown = await chip.textContent();
    // Cut, and visibly so. The original is still there for anyone who wants to
    // compare it against wherever they copied it from.
    expect(shown.length).toBeLessThan(80);
    expect(shown.endsWith("…")).toBe(true);
    expect(await chip.getAttribute("title")).toContain(long);
  });

  test("the reader is told in the tab, not only on the page", async ({ page }) => {
    await page.goto(BAD);
    await expect(page.locator(".notfound")).toBeVisible();
    await expect(page).toHaveTitle("Nothing here · Commons");

    // And the title comes back when they leave, which is the half that breaks
    // silently: syncChrome returns early for a missing route.
    await page.goto("/#/settings");
    await expect(page).toHaveTitle("Settings · Commons");
  });

  test("the feed is not left on screen under the wrong address", async ({
    page,
    api,
  }) => {
    await api.seed(3, "ada@commons.test");
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(3);

    await page.evaluate(() => (location.hash = "#/nowhere"));
    await expect(page.locator(".notfound")).toBeVisible();
    await expect(page.locator(CARD)).toHaveCount(0);
  });

  test("the way back works", async ({ page, api }) => {
    await api.seed(2, "ada@commons.test");
    await page.goto(BAD);

    await page.getByRole("link", { name: "Take me to the feed" }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.locator(CARD)).toHaveCount(2);
  });

  test("every place it offers is a place that exists", async ({ page }) => {
    await page.goto(BAD);

    // Signed out, so notifications is not offered — see the note in
    // views/notfound.js. Each of the rest is opened for real rather than being
    // checked for an href, because an href is a claim and arriving is a fact.
    const expected = ["The feed", "Your shelf", "Settings", "Colophon"];
    await expect(page.locator(".notfound__places a")).toHaveText(expected);

    for (const name of expected) {
      await page.goto(BAD);
      await page.locator(".notfound__places").getByRole("link", { name }).click();
      await expect(page.locator(".notfound")).toHaveCount(0);
    }
  });

  test("notifications is offered only once there's an account behind it", async ({
    page,
    api,
  }) => {
    // Signed out it would turn straight around into the sign-in form, which is
    // a link that lies about where it goes.
    await page.goto(BAD);
    await expect(
      page.locator(".notfound__places").getByRole("link", { name: "Notifications" })
    ).toHaveCount(0);

    await api.seed(1, "ada@commons.test");
    await api.signIn(page, "ada@commons.test", "seedpassword");
    await page.goto(BAD);
    await expect(
      page.locator(".notfound__places").getByRole("link", { name: "Notifications" })
    ).toBeVisible();
  });

  test("the search button opens the palette", async ({ page }) => {
    await page.goto(BAD);
    await page.getByRole("button", { name: "Search Commons" }).click();
    await expect(page.locator(".palette__panel")).toBeVisible();
  });

  test("it offers the list you were on, and only when there is one", async ({
    page,
    api,
  }) => {
    // Arriving cold from a pasted link, the app has never drawn a list, so
    // there is nothing honest to offer and the line is absent rather than
    // empty. Nothing is fetched to fill it — a screen that catches failures
    // must not have a failure mode of its own.
    await page.goto(BAD);
    await expect(page.locator(".notfound__resume")).toHaveCount(0);

    // Having read the feed first, there is.
    await api.seed(2, "ada@commons.test");
    await page.goto("/");
    await expect(page.locator(CARD)).toHaveCount(2);
    await page.evaluate(() => (location.hash = "#/nowhere"));

    const resume = page.locator(".notfound__resume");
    await expect(resume).toBeVisible();
    await expect(resume).toContainText("the feed");

    // And it goes to a real post.
    await resume.getByRole("link").click();
    await expect(page).toHaveURL(/#\/posts\/\d+$/);
  });

  test("a view that throws still gets the boundary, not the 404", async ({
    page,
    api,
  }) => {
    // The catch-all is held outside the route table precisely so that a route
    // registered later still wins. If it were an entry in the list it would
    // shadow this one and the error boundary would become unreachable.
    await api.seed(1, "ada@commons.test");
    await page.goto("/");
    await page.evaluate(async () => {
      const { route } = await import("/js/router.js");
      route("/__boom", () => {
        throw new Error("a view that could not build itself");
      });
    });
    await page.evaluate(() => (location.hash = "#/__boom"));

    await expect(page.locator(".screen-error")).toBeVisible();
    await expect(page.locator(".notfound")).toHaveCount(0);
  });

  test("the numerals are decoration and stay out of the way", async ({ page }) => {
    await page.goto(BAD);
    await settled(page);

    // The <h1> carries the message; the mark is hidden from the tree. A screen
    // reader that announced "404" twice — once as art, once as a heading —
    // would be reading the wallpaper out loud.
    await expect(page.locator(".notfound__mark")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    const headings = await page.locator(".notfound h1").allTextContents();
    expect(headings).toEqual(["There's nothing down this path."]);
  });

  test("it fits a phone without scrolling sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(BAD);
    await expect(page.locator(".notfound")).toBeVisible();
    await settled(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // And the way off the screen is reachable without hunting for it.
    //
    // Measured from the top of the screen's own box rather than from the top
    // of the window, deliberately. "Above the fold" is what actually matters
    // to a reader, but on a 740px phone most of the fold is spent on chrome
    // this screen doesn't control — in demo mode the band alone is a third of
    // it — and a test anchored to the window would fail the day somebody adds
    // a line to the demo notice, naming this file as the culprit. What is
    // this screen's to answer for is its own height, and 560px of it leaves
    // room for the tallest chrome the app puts up.
    //
    // 560 was 520 when the glow was in the flow and this failed by ninety.
    const top = (await page.locator(".notfound").boundingBox()).y;
    const cta = await page
      .getByRole("link", { name: "Take me to the feed" })
      .boundingBox();
    expect(cta.y + cta.height - top).toBeLessThanOrEqual(560);
  });
});
