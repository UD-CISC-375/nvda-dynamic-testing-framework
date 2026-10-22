import { test, expect, Page, TestInfo } from "@playwright/test";
import { runAxe, diffViolations } from "./helpers/axe";
import { watchDom, attachDomChanges, DomChange } from "./helpers/watch-dom";

// The menu scenario on Team Y's site. The site uses hash routing, so the
// "page" lives after the # and the server always serves the same index.html.
// accessible should pass on our tests
// broken will still pass but we are asserting what the failure is and checking
const menuUrl = (variant: "accessible" | "broken") =>
  `#/disclosure/menu?variant=${variant}`;

// The DOM change we're waiting for: the change a screen reader relies on to
// announce "expanded" and find the menu.
const menuOpened = (changes: DomChange[]) =>
  changes.some(
    (c) => c.attributeName === "aria-expanded" && c.newValue === "true",
  ) &&
  changes.some(
    (c) =>
      c.target === "ul#actions-menu" &&
      c.attributeName === "hidden" &&
      c.newValue === null,
  );

// Opens the menu. In the "chromium" project Playwright clicks for us; in the
// "manual" project we wait for a person to click in the visible browser.
// Either way the watcher started earlier sees the same DOM change.
async function clickTrigger(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "manual") {
    console.log(">>> Click the menu button in the browser window <<<");
    // This only waits for the human. The watcher still does the detecting.
    await expect(page.getByTestId("menu")).toBeVisible({
      timeout: testInfo.timeout,
    });
  } else {
    await page.getByTestId("trigger").click();
  }
}

test("menu page loads", async ({ page }) => {
  await page.goto(menuUrl("accessible"));

  // The site is a React app: the HTML arrives nearly empty and React builds
  // the page afterwards. expect(...) retries until the element shows up
  // (5s by default), so we don't need any manual waiting.
  await expect(page.getByTestId("variant")).toHaveText("accessible");

  const trigger = page.getByTestId("trigger");
  await expect(trigger).toBeVisible();
  // Starting state, before anyone clicks: menu closed.
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("menu")).toBeHidden();
});

test("accessible: opening the menu is detected and stays clean", async ({
  page,
}, testInfo) => {
  await page.goto(menuUrl("accessible"));
  await expect(page.getByTestId("trigger")).toBeVisible();

  // 1. Baseline scan of the page as it loaded.
  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toEqual([]);

  // 2. Start watching BEFORE the click so the change can't slip past us.
  const watcher = await watchDom(page, ".menu-wrapper");

  // 3. Cause the change (automatically, or by a person in manual mode).
  await clickTrigger(page, testInfo);

  // 4. Wait until the observer has reported the change we care about.
  const changes = await watcher.waitFor(menuOpened);
  console.log("[dom] detected:", changes);
  await attachDomChanges(testInfo, changes);

  // 5. Same scan again, against the new state of the page.
  const after = await runAxe(page, testInfo, "after");
  expect(after.map((v) => v.id)).toEqual([]);
  expect(diffViolations(before, after)).toEqual([]);
});

test("broken: opening the menu is NOT announced as a state change", async ({
  page,
}, testInfo) => {
  await page.goto(menuUrl("broken"));
  await expect(page.getByTestId("trigger")).toBeVisible();

  // The broken trigger is an icon-only <button> with no accessible name,
  // so a screen reader would just say "button". axe reports that as button-name.
  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toContain("button-name");

  const watcher = await watchDom(page, ".menu-wrapper");
  await clickTrigger(page, testInfo);

  // The click DOES change the DOM (the menu is inserted)...
  await expect(page.getByTestId("menu")).toBeVisible();
  // ...but never via aria-expanded / hidden, so our watcher must time out.
  await expect(watcher.waitFor(menuOpened, 2000)).rejects.toThrow(
    "expected change not seen",
  );
  console.log("[dom] expected 'expanded' signal NOT seen. Only these changes happened:", watcher.changes);
  await attachDomChanges(testInfo, watcher.changes);

  const after = await runAxe(page, testInfo, "after");
  expect(after.map((v) => v.id)).toContain("button-name");
  console.log("[axe] new since baseline:", diffViolations(before, after));
});
