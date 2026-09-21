// Where focus is after you press something on #/settings.
//
// Every button on this screen that says "Saving…" or "Deleting…" while it
// works disables itself to do it, and **disabling a focused control hands
// focus to the body**. So a reader working by keyboard pressed Enter and was
// returned to the top of the tab order by their own press — then had to Tab
// back down a long screen to find out whether it had worked.
//
// It is the kind of bug that is invisible to anybody using a mouse and
// constant for anybody who is not, which is exactly the kind worth a file.
//
// The two guards are as much the subject as the fix. Putting focus back
// unconditionally would yank it to a button somebody clicked with a mouse,
// and putting it back after a slow request would drag a reader away from
// wherever they had tabbed to in the meantime. Both are tested below.

const { test, expect, CARD, accountButton } = require("./support/fixtures");

const ADA = "ada@commons.test";
const PW = "seedpassword";

async function onSettings(page, api, { posts = 1 } = {}) {
  await api.seed(posts, ADA);
  await api.signIn(page, ADA, PW);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();
}

/** Where focus is, as something a failure message can be read from. */
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "(nowhere — focus was lost)";
    return `${el.tagName.toLowerCase()}:${(el.textContent || el.id || "").trim().slice(0, 30)}`;
  });

// ── the buttons that stay on the page ─────────────────────────────────────

test("Save name keeps the focus it was pressed with", async ({ page, api }) => {
  await onSettings(page, api);

  const save = page.getByRole("button", { name: "Save name" });
  await page.locator("#settings-username").fill("adalovelace");
  await save.focus();
  await page.keyboard.press("Enter");

  await expect(page.locator(".toast")).toContainText("adalovelace");
  await expect(save, `focus went to ${await focused(page)}`).toBeFocused();
});

test("a failed rename puts focus in the field, not on the button", async ({
  page,
  api,
}) => {
  await api.register("bea@commons.test", PW, "bea");
  await onSettings(page, api);

  // A name somebody else has: the request comes back 409 and the button is
  // re-enabled in place, which is the path most likely to be forgotten.
  const save = page.getByRole("button", { name: "Save name" });
  await page.locator("#settings-username").fill("bea");
  await save.focus();
  await page.keyboard.press("Enter");

  await expect(page.locator("#settings-username-err")).toHaveText(
    "That username is taken."
  );

  // **Not the button.** The rename handler deliberately puts focus in the
  // field on a rejection, because the next thing to do is fix the name —
  // and the restore declines to fight it, because focus is somewhere rather
  // than nowhere. That guard is the whole reason the sweep could be applied
  // to six controls without reading each one's error path first.
  await expect(
    page.locator("#settings-username"),
    `focus went to ${await focused(page)}`
  ).toBeFocused();
});

test("Check for a new version keeps it", async ({ page, api }) => {
  await onSettings(page, api);

  const check = page.getByRole("button", { name: "Check for a new version" });
  // The worker claims the page on the load *after* it installs, so a first
  // visit legitimately has none and the button is not offered.
  test.skip(!(await check.isVisible().catch(() => false)), "no worker on this visit");

  await check.focus();
  await page.keyboard.press("Enter");
  await expect(check).toBeEnabled();
  await expect(check, `focus went to ${await focused(page)}`).toBeFocused();
});

test("a data panel control hands focus to its row, not to nothing", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  const control = page.locator('[data-row="read"] .data__do');
  await control.focus();
  await page.keyboard.press("Enter");

  // This one cannot keep focus on the control, because a cleared row has
  // nothing left to clear and the button is gone. The row takes it instead —
  // so the reader hears the new state rather than silence.
  await expect(control).toHaveCount(0);
  await expect(
    page.locator('[data-row="read"]'),
    `focus went to ${await focused(page)}`
  ).toBeFocused();
});

// ── the two guards ────────────────────────────────────────────────────────

test("a mouse press does not leave focus on the button", async ({ page, api }) => {
  await onSettings(page, api);

  await page.locator("#settings-username").fill("adalovelace");
  // Clicking a <button> focuses it in Chromium, so reach for one the pointer
  // can press without focusing: the label of a switch, which moves focus to
  // its own input. The point is that the restore is conditional on having
  // had focus rather than unconditional.
  const save = page.getByRole("button", { name: "Save name" });
  await page.getByRole("checkbox", { name: "Reduce motion in Commons" }).focus();
  await save.dispatchEvent("click");

  await expect(page.locator(".toast")).toContainText("adalovelace");
  // Focus never belonged to the button, so it must not have been taken.
  await expect(
    page.getByRole("checkbox", { name: "Reduce motion in Commons" })
  ).toBeFocused();
});

test("focus moved during the request is left where the reader put it", async ({
  page,
  api,
}, info) => {
  // Chromium only, and not because the behaviour differs. This one needs a
  // request held open long enough to move focus while it is in flight, and
  // the only tool for that is page.route — which intercepts HTTP, of which
  // demo mode has none: js/demo/backend.js answers in the page, at latency 0.
  // The test would still pass there and would be asserting nothing.
  test.skip(info.project.name === "demo", "no HTTP to delay in demo mode");

  await api.seed(1, ADA);
  await api.signIn(page, ADA, PW);
  await page.goto("/#/settings");
  await expect(page.locator(".data")).toBeVisible();

  // Hold the rename open long enough to move focus while it is in flight.
  await page.route("**/users/me", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await new Promise((r) => setTimeout(r, 600));
    await route.fallback();
  });

  const save = page.getByRole("button", { name: "Save name" });
  await page.locator("#settings-username").fill("adalovelace");
  await save.focus();
  await page.keyboard.press("Enter");

  // The reader goes somewhere else while it works.
  const elsewhere = page.getByRole("checkbox", { name: "Reduce motion in Commons" });
  await elsewhere.focus();
  await expect(page.locator(".toast")).toContainText("adalovelace");

  // Dragging them back to a button they have finished with would be worse
  // than the bug this all fixes.
  await expect(elsewhere, `focus went to ${await focused(page)}`).toBeFocused();
});

// ── the two that navigate away ────────────────────────────────────────────

test("a failed sign-out-everywhere keeps focus on the button", async ({
  page,
  api,
}) => {
  await onSettings(page, api);

  // On success this navigates home and there is nothing to focus. The
  // failure path is the one that stays, and the one worth pinning.
  //
  // `api.failNext`, not `page.route`. In demo mode there is no HTTP to
  // intercept — js/demo/backend.js answers in the page — so a route handler
  // matches nothing, the request succeeds and the test is silently asserting
  // the wrong thing. The fixture queues the failure inside whichever adapter
  // the page is actually running.
  await api.failNext({ method: "POST", path: "/auth/logout-all", status: 500 });

  const button = page.getByRole("button", { name: "Sign out everywhere" });
  await button.focus();
  await page.keyboard.press("Enter");

  await expect(page.locator(".toast")).toContainText("didn't go through");
  await expect(button, `focus went to ${await focused(page)}`).toBeFocused();
});

test("a failed delete keeps focus on the confirm", async ({ page, api }) => {
  await onSettings(page, api);

  // See the note above: the same reason this is not page.route.
  await api.failNext({ method: "DELETE", path: "/users/me", status: 500 });

  await page.getByRole("button", { name: "Delete your account" }).click();
  await page.locator("#settings-confirm").fill("ada");
  const go = page.getByRole("button", { name: "Delete my account" });
  await go.focus();
  await page.keyboard.press("Enter");

  await expect(page.locator(".toast")).toContainText("didn't go through");
  await expect(go, `focus went to ${await focused(page)}`).toBeFocused();
});

// ── and the one that was fixed first ──────────────────────────────────────

test("Download your data keeps it", async ({ page, api }) => {
  await onSettings(page, api);
  await page.evaluate(() => {
    // So the runner does not collect a file per run.
    HTMLAnchorElement.prototype.click = function () {};
  });

  const button = page.getByRole("button", { name: "Download your data" });
  await button.focus();
  await page.keyboard.press("Enter");

  await expect(page.locator(".settings__section p[role='status']")).toContainText(
    "Downloaded"
  );
  await expect(button, `focus went to ${await focused(page)}`).toBeFocused();
});

// ── the whole screen, walked ──────────────────────────────────────────────

test("nothing on the screen loses focus to the body when pressed", async ({
  page,
  api,
}) => {
  await onSettings(page, api);
  await page.evaluate(() => {
    HTMLAnchorElement.prototype.click = function () {};
  });

  // A sweep rather than a list, so a control added later is covered without
  // anybody remembering to come back here. Only the ones that disable
  // themselves are interesting; the rest cannot lose focus this way.
  const lost = await page.evaluate(async () => {
    const out = [];
    const buttons = [...document.querySelectorAll(".settings button")].filter(
      (b) =>
        !/Delete your account|Sign out everywhere|Delete my account/.test(b.textContent)
    );
    for (const b of buttons) {
      if (!b.isConnected || b.disabled) continue;
      const label = b.textContent.trim();
      b.focus();
      b.click();
      await new Promise((r) => setTimeout(r, 500));
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        out.push(label);
      }
    }
    return out;
  });

  expect(lost, `these lost focus to the body: ${lost.join(", ")}`).toEqual([]);
});
