import { test, expect, Page, TestInfo } from "@playwright/test";
import { runAxe, diffViolations } from "./helpers/axe";
import { watchDom, DomChange } from "./helpers/watch-dom";

// The toast scenario on Team Y's site (WCAG 4.1.3 Status Messages).
// accessible should pass all of our checks.
// broken will still pass axe, but we assert what the failure is: the toast
// region has no role="status", so a screen reader has no live region to watch.
const toastUrl = (variant: "accessible" | "broken") =>
  `#/live/toast?variant=${variant}`;

// Watch the whole scenario, not just the region: if the app replaces the
// region element, that shows up as a childList change on its parent.
const SCENARIO = '[data-testid="scenario-root"]';

// The form resets its textarea on submit; that's not the toast.
const isToastChange = (c: DomChange) => c.target !== "textarea#message";

const toastInserted = (changes: DomChange[]) =>
  changes.some(
    (c) => isToastChange(c) && c.type === "childList" && c.added.length > 0,
  );

const toastRemoved = (changes: DomChange[]) =>
  changes.some(
    (c) => isToastChange(c) && c.type === "childList" && c.removed.length > 0,
  );

// Sends the message. In the "chromium" project Playwright clicks for us; in
// the "manual" project we wait for a person to click in the visible browser.
// Either way the watcher started earlier sees the same DOM change.
async function clickTrigger(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "manual") {
    console.log(">>> Click 'Send message' in the browser window <<<");
    // This only waits for the human. The watcher still does the detecting.
    await expect(page.getByTestId("toast-region")).toContainText(/.+/, {
      timeout: testInfo.timeout,
    });
  } else {
    await page.getByTestId("trigger").click();
  }
}

test("toast page loads", async ({ page }) => {
  await page.goto(toastUrl("accessible"));

  await expect(page.getByTestId("variant")).toHaveText("accessible");
  await expect(page.getByTestId("trigger")).toBeVisible();
  // Starting state, before anyone clicks: no toast yet.
  await expect(page.getByTestId("toast-region")).toBeEmpty();
});

test("accessible: toast is injected into an existing live region and stays clean", async ({
  page,
}, testInfo) => {
  await page.goto(toastUrl("accessible"));
  const toastRegion = page.getByTestId("toast-region");
  await expect(page.getByTestId("trigger")).toBeVisible();

  // 1. The live region must exist, empty, BEFORE the message appears.
  //    Screen readers only announce changes to regions they already watch.
  await expect(toastRegion).toHaveAttribute("role", "status");
  await expect(toastRegion).toBeEmpty();

  // Tag the element so we can prove it isn't replaced when the toast shows.
  await toastRegion.evaluate((el) => {
    (window as unknown as { __toastRegion: Element }).__toastRegion = el;
  });

  // 2. Baseline scan of the page as it loaded.
  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toEqual([]);

  // 3. Start watching BEFORE the click so the change can't slip past us.
  const watcher = await watchDom(page, SCENARIO);

  // 4. Cause the change (automatically, or by a person in manual mode).
  await clickTrigger(page, testInfo);

  // 5. Wait until the observer has reported the toast being inserted.
  const changes = await watcher.waitFor(toastInserted);
  console.log("[dom] detected:", changes);
  await expect(toastRegion).toContainText(/.+/);

  // The message went into the SAME element that was already in the DOM.
  const samePersisted = await page.evaluate(() => {
    const original = (window as unknown as { __toastRegion: Element })
      .__toastRegion;
    return (
      original.isConnected &&
      original === document.querySelector('[data-testid="toast-region"]')
    );
  });
  expect(samePersisted).toBe(true);
  await expect(toastRegion).toHaveAttribute("role", "status");

  // 6. Same scan again, against the new state of the page.
  const after = await runAxe(page, testInfo, "after");
  expect(after.map((v) => v.id)).toEqual([]);
  expect(diffViolations(before, after)).toEqual([]);

  // 7. The toast auto-dismisses; the live region itself stays in the DOM.
  await watcher.waitFor(toastRemoved, 15_000);
  await expect(toastRegion).toBeEmpty({ timeout: 15_000 });
  await expect(toastRegion).toHaveAttribute("role", "status");
});

test("broken: toast region is NOT a live region", async ({
  page,
}, testInfo) => {
  await page.goto(toastUrl("broken"));
  const toastRegion = page.getByTestId("toast-region");
  await expect(page.getByTestId("trigger")).toBeVisible();

  // axe has nothing to flag here: an empty <div> is valid markup.
  const before = await runAxe(page, testInfo, "before");
  console.log("[axe] baseline violations:", before.map((v) => v.id));

  // The bug: no role="status" (or aria-live) exists before the click, so
  // there is no live region for a screen reader to be watching.
  await expect(toastRegion).not.toHaveAttribute("role", "status");
  await expect(toastRegion).not.toHaveAttribute("aria-live", /.+/);

  const watcher = await watchDom(page, SCENARIO);
  await clickTrigger(page, testInfo);

  // The click DOES change the DOM (the toast is inserted)...
  await watcher.waitFor(toastInserted);
  await expect(toastRegion).toContainText(/.+/);

  // ...but no existing element ever becomes a live region: nothing has its
  // role / aria-live attribute set after the fact.
  const liveRegionAttrChanges = watcher.changes.filter(
    (c) => c.attributeName === "role" || c.attributeName === "aria-live",
  );
  expect(liveRegionAttrChanges).toEqual([]);
  await expect(toastRegion).not.toHaveAttribute("role", "status");
  console.log(
    "[dom] changes:",
    watcher.changes,
    "\n[dom] region after click:",
    await toastRegion.evaluate((el) => el.outerHTML),
  );

  const after = await runAxe(page, testInfo, "after");
  console.log("[axe] new since baseline:", diffViolations(before, after));
});
