import { test, expect, Page, TestInfo } from "@playwright/test";
import { runAxe, diffViolations } from "./helpers/axe";
import { watchDom, DomChange } from "./helpers/watch-dom";

// The loading indicator scenario on Team Y's site: clicking "Load results"
// shows a spinner for `delay` ms, then a list of 5 results.
// WCAG 2.2 4.1.3 Status Messages: "Loading" and "Loaded" must reach a screen
// reader without moving focus, i.e. through a live region.
// delay=3000 holds the loading state long enough to run axe against it.
const loadingUrl = (variant: "accessible" | "broken") =>
  `#/live/loading?variant=${variant}&delay=3000`;

// A live-region change whose text contains `text`: what a screen reader
// announces. axe-core has no rule for 4.1.3, so this is how we check it.
const announced = (text: string) => (changes: DomChange[]) =>
  changes.some((c) => c.inLiveRegion && c.text?.includes(text));

const loadingAnnounced = announced("Loading results");
const loadedAnnounced = announced("Loaded 5 results");

// The section tells assistive tech it's busy while loading, then not busy.
const busyCleared = (changes: DomChange[]) =>
  changes.some(
    (c) =>
      c.attributeName === "aria-busy" &&
      c.oldValue === "true" &&
      c.newValue === "false",
  );

// Starts loading. In the "chromium" project Playwright clicks for us; in the
// "manual" project we wait for a person to click in the visible browser.
async function clickTrigger(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "manual") {
    console.log(">>> Click the 'Load results' button in the browser window <<<");
    // This only waits for the human. The watcher still does the detecting.
    await expect(page.getByTestId("spinner")).toBeVisible({
      timeout: testInfo.timeout,
    });
  } else {
    await page.getByTestId("trigger").click();
  }
}

test("loading page loads", async ({ page }) => {
  await page.goto(loadingUrl("accessible"));
  await expect(page.getByTestId("variant")).toHaveText("accessible");

  // Starting state, before anyone clicks: nothing loading, no results.
  await expect(page.getByTestId("trigger")).toBeVisible();
  await expect(page.getByTestId("spinner")).toBeHidden();
  await expect(page.getByTestId("results")).toBeHidden();
  await expect(page.getByTestId("status")).toHaveText("");
});

test("accessible: loading and completion are announced via a live region", async ({
  page,
}, testInfo) => {
  await page.goto(loadingUrl("accessible"));
  await expect(page.getByTestId("trigger")).toBeVisible();

  // 1. Baseline scan of the page as it loaded.
  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toEqual([]);

  // 2. Start watching BEFORE the click so the change can't slip past us.
  const watcher = await watchDom(page, '[data-testid="scenario-root"]');

  // 3. Start loading (automatically, or by a person in manual mode).
  await clickTrigger(page, testInfo);

  // 4. "Loading results…" is written into the role="status" region.
  await watcher.waitFor(loadingAnnounced);

  // 5. Scan while the spinner is up. It's decorative (aria-hidden), so clean.
  await expect(page.getByTestId("spinner")).toHaveAttribute("aria-hidden", "true");
  const during = await runAxe(page, testInfo, "during");
  expect(during.map((v) => v.id)).toEqual([]);

  // 6. "Loaded 5 results" is announced and the section is no longer busy.
  const changes = await watcher.waitFor(
    (c) => loadedAnnounced(c) && busyCleared(c),
  );
  console.log("[dom] detected:", changes);
  await expect(page.getByTestId("results").getByRole("listitem")).toHaveCount(5);

  // 7. Same scan again, against the final state of the page.
  const after = await runAxe(page, testInfo, "after");
  expect(after.map((v) => v.id)).toEqual([]);
  expect(diffViolations(before, after)).toEqual([]);
});

test("broken: loading and completion are NOT announced", async ({
  page,
}, testInfo) => {
  await page.goto(loadingUrl("broken"));
  await expect(page.getByTestId("trigger")).toBeVisible();

  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toEqual([]);

  const watcher = await watchDom(page, '[data-testid="scenario-root"]');
  await clickTrigger(page, testInfo);

  // The spinner is role="img" with no accessible name, so a screen reader
  // says "image" at best. axe reports that as svg-img-alt, but only while
  // the spinner is on screen.
  await expect(page.getByTestId("spinner")).toBeVisible();
  const during = await runAxe(page, testInfo, "during");
  expect(during.map((v) => v.id)).toContain("svg-img-alt");
  console.log("[axe] new since baseline:", diffViolations(before, during));

  // The DOM DOES change (spinner, then results)...
  await expect(page.getByTestId("results").getByRole("listitem")).toHaveCount(5);
  // ...but none of it happens in a live region, so nothing is announced.
  await expect(watcher.waitFor(loadedAnnounced, 1000)).rejects.toThrow(
    "expected change not seen",
  );
  expect(watcher.changes.filter((c) => c.inLiveRegion)).toEqual([]);
  console.log("[dom] no live-region change. Only these changes happened:", watcher.changes);

  // Once the spinner is gone, axe is clean again: a scan after loading
  // misses both the unlabeled spinner and the missing announcements.
  const after = await runAxe(page, testInfo, "after");
  expect(after.map((v) => v.id)).toEqual([]);
});
