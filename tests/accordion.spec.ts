import { test, expect, Page, TestInfo } from "@playwright/test";
import { runAxe, diffViolations } from "./helpers/axe";
import { watchDom, DomChange } from "./helpers/watch-dom";

// The accordion scenario on Team Y's site. The site uses hash routing, so the
// "page" lives after the # and the server always serves the same index.html.
// accessible should pass on our tests
// broken will still pass axe (a <div> with text is valid markup), but we are
// asserting what the failure is: the header is not a button, has no
// aria-expanded / aria-controls, and the panel opens via an inline style.
const accordionUrl = (variant: "accessible" | "broken") =>
  `#/disclosure/accordion?variant=${variant}`;

// The DOM change we're waiting for: the change a screen reader relies on to
// announce "expanded" and find the panel.
const accordionOpened = (changes: DomChange[]) =>
  changes.some(
    (c) => c.attributeName === "aria-expanded" && c.newValue === "true",
  ) &&
  changes.some(
    (c) =>
      c.target === "div#acc-panel-1" &&
      c.attributeName === "hidden" &&
      c.newValue === null,
  );

// Opens the first accordion item. In the "chromium" project Playwright clicks
// for us; in the "manual" project we wait for a person to click in the
// visible browser. Either way the watcher started earlier sees the same DOM
// change.
async function clickTrigger(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "manual") {
    console.log(">>> Click the first accordion header in the browser window <<<");
    // This only waits for the human. The watcher still does the detecting.
    await expect(page.getByTestId("accordion-panel-1")).toBeVisible({
      timeout: testInfo.timeout,
    });
  } else {
    await page.getByTestId("trigger").click();
  }
}

test("accordion page loads", async ({ page }) => {
  await page.goto(accordionUrl("accessible"));

  // The site is a React app: the HTML arrives nearly empty and React builds
  // the page afterwards. expect(...) retries until the element shows up
  // (5s by default), so we don't need any manual waiting.
  await expect(page.getByTestId("variant")).toHaveText("accessible");

  const trigger = page.getByTestId("trigger");
  await expect(trigger).toBeVisible();
  // Starting state, before anyone clicks: panel closed.
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("accordion-panel-1")).toBeHidden();
});

test("accessible: opening the accordion is detected and stays clean", async ({
  page,
}, testInfo) => {
  await page.goto(accordionUrl("accessible"));
  const trigger = page.getByTestId("trigger");
  await expect(trigger).toBeVisible();

  // The header is a real button wired to its panel.
  await expect(
    page.getByRole("button", { name: "What is NVDA?" }),
  ).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-controls", "acc-panel-1");

  // 1. Baseline scan of the page as it loaded.
  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toEqual([]);

  // 2. Start watching BEFORE the click so the change can't slip past us.
  const watcher = await watchDom(page, ".accordion");

  // 3. Cause the change (automatically, or by a person in manual mode).
  await clickTrigger(page, testInfo);

  // 4. Wait until the observer has reported the change we care about.
  const changes = await watcher.waitFor(accordionOpened);
  console.log("[dom] detected:", changes);

  // The panel is exposed as a region named by its header.
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("region", { name: "What is NVDA?" }),
  ).toBeVisible();

  // 5. Same scan again, against the new state of the page.
  const after = await runAxe(page, testInfo, "after");
  expect(after.map((v) => v.id)).toEqual([]);
  expect(diffViolations(before, after)).toEqual([]);
});

test("broken: opening the accordion is NOT announced as a state change", async ({
  page,
}, testInfo) => {
  await page.goto(accordionUrl("broken"));
  const trigger = page.getByTestId("trigger");
  await expect(trigger).toBeVisible();

  // The broken header is a plain <div>: no button role, no expanded state,
  // no link to its panel. A screen reader would just read the text.
  await expect(
    page.getByRole("button", { name: "What is NVDA?" }),
  ).toHaveCount(0);
  await expect(trigger).not.toHaveAttribute("aria-expanded", /.*/);
  await expect(trigger).not.toHaveAttribute("aria-controls", /.*/);

  // Baseline scan. Not asserted: we record what axe sees (likely nothing).
  const before = await runAxe(page, testInfo, "before");

  const watcher = await watchDom(page, ".accordion");
  await clickTrigger(page, testInfo);

  // The click DOES change the DOM (the panel's inline style flips)...
  await expect(page.getByTestId("accordion-panel-1")).toBeVisible();
  // ...but never via aria-expanded / hidden, so our watcher must time out.
  await expect(watcher.waitFor(accordionOpened, 2000)).rejects.toThrow(
    "expected change not seen",
  );
  console.log("[dom] expected 'expanded' signal NOT seen. Only these changes happened:", watcher.changes);

  const after = await runAxe(page, testInfo, "after");
  console.log("[axe] new since baseline:", diffViolations(before, after));
});