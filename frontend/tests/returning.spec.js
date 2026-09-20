// Coming back to a list you had already scrolled.
//
// The feed has done this for a while: leaving it holds a snapshot, and arriving
// back restores the posts *and* the scroll position, so tapping a card and
// pressing Back doesn't cost you the ten posts you had walked past. The profile
// did not, and the gap was the sort that only shows up on a real phone with a
// real backlog.
//
// Making the profile do it meant the store had to hold more than one list, and
// that is the part with a trap in it: with one slot, visiting a profile on the
// way back to the feed would have evicted the feed. Half of what is below is
// about the lists not standing on each other.

const { test, expect, CARD, signOutViaMenu } = require("./support/fixtures");

const EMAIL = "ada@commons.test";
const scrollY = (page) => page.evaluate(() => window.scrollY);

// Watch for the press the same way the app does.
//
// The contract is "back to where you were when you pressed", and that is not
// the same as "back to where the test scrolled to": Playwright scrolls an
// element into view before clicking it, which on a tall list moves the page
// after the test set it and before the app sees the press. Asserting against
// the test's own number made this fail against the mock and pass against the
// demo purely because the seeded posts are different heights — which is a test
// measuring the wrong thing, not an app that is wrong on one backend.
const watchPress = (page) =>
  page.addInitScript(() => {
    addEventListener("pointerdown", () => (window.__pressedAt = window.scrollY), true);
  });
const pressedAt = (page) => page.evaluate(() => window.__pressedAt);

async function scrollDown(page) {
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => scrollY(page)).toBeGreaterThan(400);
}

// The scroll is restored inside mountView, which may be running in a view
// transition — so it lands a frame or two after the screen does.
const restoredTo = async (page, y) => {
  // Not vacuous: a restore to the top would satisfy "close to y" if y were 0.
  expect(y).toBeGreaterThan(300);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(y - 60);
};

test("the feed comes back where you left it", async ({ page, api }) => {
  await watchPress(page);
  await api.seed(14, EMAIL);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(10);

  // Scrolling this far crosses the prefetch margin, so the second page lands
  // before we leave — which makes the assertion afterwards the stronger one:
  // what comes back is the whole list as it stood, not the first page again.
  await scrollDown(page);
  await expect(page.locator(CARD)).toHaveCount(14);

  await page.locator(`${CARD} .card__link`).nth(5).click();
  await expect(page.locator(".detail__title")).toBeVisible();
  const y = await pressedAt(page);

  await page.locator(".back").click();
  await expect(page.locator(CARD)).toHaveCount(14);
  await restoredTo(page, y);
});

// ── the way out of the cache ───────────────────────────────────────────────
//
// Everything above is the snapshot doing its job. The brand is how a reader
// says they would rather have the feed than the snapshot of it, and it has to
// work from the feed itself — which is where somebody standing on a stale list
// actually is. It used to be the one place it didn't: an `<a href="#/">`
// pressed while the hash is already `#/` fires no hashchange, so the router
// never heard, and the cache was emptied for *next* time instead of this one.

/**
 * Put a post into the backend while a screen is already up.
 *
 * seedLive, not seed. Against the mock the two are the same request, but in
 * demo mode api.seed writes to the Node-side snapshot and re-registers the init
 * script that carries it — so nothing reaches the page until the next document
 * load, which is exactly wrong for a test about something arriving while the
 * reader is looking at a list. seedLive goes to the adapter the page is
 * actually running. live.spec.js and anchor.spec.js do the same.
 */
async function postArrivesUnseen(page, api) {
  await api.seedLive(page, 1, "zoe@commons.test");
}

test("the brand fetches the feed again, from the feed", async ({ page, api }) => {
  await api.seed(3, EMAIL);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);

  // Something the feed on screen cannot know about. If pressing the brand only
  // emptied the cache, the count would stay at three.
  await postArrivesUnseen(page, api);
  await page.locator(".brand").click();
  await expect(page.locator(CARD)).toHaveCount(4);
});

test("pressing it from the feed is one render, not a journey", async ({
  page,
  api,
}) => {
  await api.seed(3, EMAIL);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);

  await page.evaluate(() => {
    window.__seen = { renders: 0, transitions: 0, skeletons: 0 };
    const view = document.getElementById("view");
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target === view && record.addedNodes.length) window.__seen.renders++;
      }
    }).observe(view, { childList: true });
    new MutationObserver(() => {
      window.__seen.skeletons = Math.max(
        window.__seen.skeletons,
        document.querySelectorAll(".card--skeleton").length
      );
    }).observe(view, { childList: true, subtree: true });
    const original = document.startViewTransition?.bind(document);
    if (original) {
      document.startViewTransition = (callback) => {
        window.__seen.transitions++;
        return original(callback);
      };
    }
  });

  await postArrivesUnseen(page, api);
  await page.locator(".brand").click();
  await expect(page.locator(CARD)).toHaveCount(4);

  const seen = await page.evaluate(() => window.__seen);
  // Once. preventDefault stops the browser following the href as well, so
  // navigate() is the only thing that moves.
  expect(seen.renders).toBe(1);
  // Nobody went anywhere, so nothing travels, and the list already on screen
  // holds the same posts — so it is held rather than replaced by grey bars.
  // See the `reordering` note in js/views/feed.js.
  expect(seen.transitions).toBe(0);
  expect(seen.skeletons).toBe(0);
});

test("pressing it from a post is a journey, and still only one render", async ({
  page,
  api,
}) => {
  await api.seed(3, EMAIL);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);

  await page.locator(`${CARD} .card__link`).first().click();
  await expect(page.locator(".detail__title")).toBeVisible();

  await page.evaluate(() => {
    window.__renders = 0;
    const view = document.getElementById("view");
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target === view && record.addedNodes.length) window.__renders++;
      }
    }).observe(view, { childList: true });
  });

  await postArrivesUnseen(page, api);
  await page.locator(".brand").click();
  await expect(page.locator(CARD)).toHaveCount(4);

  // The href would have fired a hashchange here all by itself. navigate() must
  // not add a second one on top of it.
  expect(await page.evaluate(() => window.__renders)).toBe(1);
});

test("a fresh feed is the newest feed, not the one you had sorted", async ({
  page,
  api,
}) => {
  await api.seed(3, EMAIL);
  await page.goto("/#/?sort=warm");
  await expect(page.locator(CARD)).toHaveCount(3);

  await page.locator(".brand").click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(".sortbar__option[aria-current]")).toHaveText("Newest");
});

test("it takes you back to the top", async ({ page, api }) => {
  await api.seed(14, EMAIL);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(10);
  await scrollDown(page);

  await page.locator(".brand").click();
  await expect.poll(() => scrollY(page)).toBe(0);
});

test("and so does a profile", async ({ page, api }) => {
  await watchPress(page);
  await api.seed(14, EMAIL);
  await page.goto("/#/u/ada");
  await expect(page.locator(CARD)).toHaveCount(10);

  await scrollDown(page);
  await expect(page.locator(CARD)).toHaveCount(14);

  await page.locator(`${CARD} .card__link`).nth(5).click();
  await expect(page.locator(".detail__title")).toBeVisible();
  const y = await pressedAt(page);

  await page.locator(".back").click();
  await expect(page).toHaveURL(/#\/u\/ada$/);
  await expect(page.locator(CARD)).toHaveCount(14);
  await restoredTo(page, y);
});

test("a profile does not evict the feed on the way past", async ({ page, api }) => {
  // The reason the store holds four lists rather than one. With a single slot
  // this passes every assertion except the last, and does it silently.
  await api.seed(14, EMAIL);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(10);
  await scrollDown(page);
  await expect(page.locator(CARD)).toHaveCount(14);
  // No press here — this navigates by address — so the position the feed keeps
  // is the one the window reports, which is the fallback the stamp is allowed.
  const y = await scrollY(page);

  await page.goto("/#/u/ada");
  await expect(page.locator(CARD)).toHaveCount(10);

  await page.goto("/#/");
  await expect(page.locator(CARD)).toHaveCount(14);
  await restoredTo(page, y);
});

test("two profiles are two lists", async ({ page, api }) => {
  await api.seed(14, EMAIL);
  await api.seed(3, "bea@commons.test");

  await page.goto("/#/u/ada");
  await expect(page.locator(CARD)).toHaveCount(10);
  await page.goto("/#/u/bea");
  await expect(page.locator(CARD)).toHaveCount(3);

  // Bea's three did not come back under Ada's name, and the count line is
  // hers rather than a number carried over from the other list.
  await page.goto("/#/u/ada");
  await expect(page.locator(CARD)).toHaveCount(10);
  await expect(page.locator(".profile__count")).toHaveText("14 posts");
});

test("what a signed-in reader saw is not replayed to a signed-out one", async ({
  page,
  api,
}) => {
  // A profile can carry its owner's unpublished posts. The cache is stamped
  // with who it was fetched as for exactly this reason, and signing out clears
  // it outright — but the stamp is the belt to that pair of braces.
  await api.seed(2, EMAIL);
  await api.signIn(page, EMAIL, "seedpassword");
  await page.goto("/#/compose");
  await page.getByLabel("Title", { exact: true }).fill("Not ready yet");
  await page.getByLabel("Body").fill("Still thinking about this one.");
  await page.getByText("Publish now").click(); // toggle off -> "Save as a draft"
  await expect(page.getByText("Save as a draft")).toBeVisible();
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.locator(".detail__title")).toHaveText("Not ready yet");

  await page.goto("/#/u/ada");
  await expect(page.locator(CARD)).toHaveCount(3);

  await signOutViaMenu(page);
  await expect(page.locator(".account")).toContainText("Sign in");
  await page.goto("/#/u/ada");

  await expect(page.locator(CARD)).toHaveCount(2);
  await expect(page.locator(".feed__list")).not.toContainText("Not ready yet");
});

// ── a list is not torn down by an event that changed nothing ───────────────
// The rule, stated directly rather than raced for.
//
// hashchange fires once per *event*, not once per screen. Two navigations in
// quick succession queue two events that both read the same final hash: the
// router dedupes the second one and builds no new screen, but a listener
// registered by the screen the first one built still runs. Every list hung its
// teardown — observer, poll, in-flight fetch — on exactly that listener.
//
// The symptom was silent and permanent: sign out, which navigates home, then
// open a profile before the queue drains, and the profile's own fetch is
// aborted by a teardown belonging to the profile that fetch was for. Heading
// drawn, skeletons drawn, nothing ever replaces them, nothing logged.
//
// Reproducing that by timing is a coin toss, so these dispatch the second
// event by hand. A hashchange at the address already on screen is exactly what
// the router decided not to act on, and the screen must not act on it either.
const nudge = (page) =>
  page.evaluate(() => dispatchEvent(new HashChangeEvent("hashchange")));

for (const [what, where] of [
  ["the feed", "/#/"],
  ["a profile", "/#/u/ada"],
]) {
  test(`${what} is still live after a hashchange that goes nowhere`, async ({
    page,
    api,
  }) => {
    // A loaded list looks identical whether or not it has been torn down, so
    // looking is not the test. What a torn-down list cannot do is fetch its
    // next page: the observer is disconnected. So this asks it to.
    await api.seed(14, EMAIL);
    await page.goto(where);
    await expect(page.locator(CARD)).toHaveCount(10);

    await nudge(page);
    await nudge(page);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(page.locator(CARD)).toHaveCount(14);
    // The feed says "for now" and a profile doesn't — it is the same end of
    // the same list either way.
    await expect(page.locator(".feed__status")).toHaveText(/That's everything/);
  });
}

test("a list that is mid-fetch is not aborted by one either", async ({ page, api }) => {
  // The half that actually broke. The teardown aborts the in-flight request,
  // so the damage is done before there is anything on screen to look at.
  await api.seed(14, EMAIL);
  await page.route(/\/posts(\?|$)|\/users\/.*\/posts/, async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    return route.continue();
  });

  await page.goto("/#/u/ada");
  await expect(page.locator(".card--skeleton").first()).toBeVisible();
  await nudge(page);

  await expect(page.locator(CARD)).toHaveCount(10);
  await expect(page.locator(".card--skeleton")).toHaveCount(0);
});

// ── the empty states ───────────────────────────────────────────────────────
// Four screens that can have nothing on them. Each one is a sentence somebody
// reads at the moment they were expecting something, so each one says what to
// do next rather than only reporting the absence.

test("an empty room invites whoever can accept the invitation", async ({
  page,
  api,
}) => {
  // `api` is asked for even though nothing is seeded. Taking the fixture is
  // what resets the backend before a test — a spec that only asks for `page`
  // never runs it, and reads whatever the test before it left behind.
  await page.goto("/");
  // Signed out: offering "be the first to say something" would point at a door
  // that is locked until you have an account.
  await expect(page.locator(".feed__status")).toHaveText(
    "Nothing here yet. Sign in and you could be the first to say something."
  );
});

test("signed in, the same room asks for the first post", async ({ page, api }) => {
  await api.register(EMAIL, "seedpassword", "ada");
  await api.signIn(page, EMAIL, "seedpassword");
  await page.goto("/");

  await expect(page.locator(".feed__status")).toHaveText(
    "Nothing here yet. Be the first to say something."
  );
});

test("a search that found nothing says how to search better", async ({ page, api }) => {
  await api.seed(3, EMAIL);
  await page.goto("/");
  await expect(page.locator(CARD)).toHaveCount(3);

  await page.locator("#search-input").fill("qwertyuiop asdfgh");
  await expect(page.locator(".feed__status")).toContainText("Nothing matches");
  // The useful half: a query that found nothing is usually too narrow, not
  // hopeless.
  await expect(page.locator(".feed__status")).toContainText(
    "try one word rather than several"
  );
});

test("somebody else's empty profile says whose it is", async ({ page, api }) => {
  await api.seed(1, EMAIL);
  await api.register("bea@commons.test", "seedpassword", "bea");
  await page.goto("/#/u/bea");

  // "Nothing here yet" on a stranger's profile reads like a page that failed
  // to load — which, for the second before the text arrives, is what it is.
  await expect(page.locator(".feed__status")).toHaveText(
    "bea hasn't posted anything yet."
  );
});

test("your own empty profile tells you what the space is for", async ({
  page,
  api,
}) => {
  await api.register(EMAIL, "seedpassword", "ada");
  await api.signIn(page, EMAIL, "seedpassword");
  await page.goto("/#/u/ada");

  await expect(page.locator(".feed__status")).toHaveText(
    "You haven't written anything yet. Whatever you post will collect here."
  );
});
