
import { test, expect, Page, TestInfo } from "@playwright/test";
import { runAxe, diffViolations } from "./helpers/axe";
import { watchDom, DomChange } from "./helpers/watch-dom";

// WCAG 2.2 SC 4.1.3: Status Messages
// Test both the accessible and broken polite status variants.
const politeUrl = (variant: "accessible" | "broken") =>
  `#/live/polite?variant=${variant}&delay=1000`;

const expectedMessage = "Item added to cart. 1 item in cart.";

// Checks whether a message was updated inside a live region.
const announced = (text: string) => (changes: DomChange[]) =>
  changes.some(
    (change) =>
      change.inLiveRegion && change.text?.includes(text),
  );

async function clickTrigger(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "manual") {
    console.log(">>> Click 'Add to cart' in the browser <<<");

    await expect(page.getByTestId("status")).toHaveText(
      expectedMessage,
      { timeout: testInfo.timeout },
    );
  } else {
    await page.getByTestId("trigger").click();
  }
}

test("polite status page loads", async ({ page }) => {
  await page.goto(politeUrl("accessible"));

  await expect(page.getByTestId("variant")).toHaveText("accessible");
  await expect(page.getByTestId("trigger")).toBeVisible();
  await expect(page.getByTestId("status")).toBeEmpty();
});

test("accessible: polite status message uses a live region", async ({
  page,
}, testInfo) => {
  await page.goto(politeUrl("accessible"));

  // 1. Scan the page before interaction
  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toEqual([]);

  // 2. Start observing DOM changes before clicking
  const watcher = await watchDom(
    page,
    '[data-testid="scenario-root"]',
  );

  // 3. Trigger the status message
  await clickTrigger(page, testInfo);

  // 4. Verify the message is updated in a live region
  const changes = await watcher.waitFor(
    announced(expectedMessage),
  );

  console.log("[dom] accessible changes:", changes);

  await expect(page.getByTestId("status")).toHaveText(
    expectedMessage,
  );
  await expect(page.getByTestId("status")).toHaveAttribute(
    "role",
    "status",
  );

  // 5. Scan the page after the message appears
  const after = await runAxe(page, testInfo, "after");
  expect(after.map((v) => v.id)).toEqual([]);
  expect(diffViolations(before, after)).toEqual([]);
});

test("broken: status message is not exposed in a live region", async ({
  page,
}, testInfo) => {
  await page.goto(politeUrl("broken"));

  // 1. Baseline accessibility scan
  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toEqual([]);

  // 2. Observe DOM changes
  const watcher = await watchDom(
    page,
    '[data-testid="scenario-root"]',
  );

  // 3. Trigger the message
  await clickTrigger(page, testInfo);

  // 4. Message appears visually
  await expect(page.getByTestId("status")).toHaveText(
    expectedMessage,
  );

  // 5. But it has no status role or polite live region
  await expect(page.getByTestId("status")).not.toHaveAttribute(
    "role",
    "status",
  );

  await expect(
    page.getByTestId("status"),
  ).not.toHaveAttribute("aria-live", "polite");

  // 6. No announcement should be detected
  await expect(
    watcher.waitFor(announced(expectedMessage), 1000),
  ).rejects.toThrow("expected change not seen");

  expect(
    watcher.changes.filter((change) => change.inLiveRegion),
  ).toEqual([]);

  console.log("[dom] broken changes:", watcher.changes);

  // 7. axe-core may still report zero violations
  const after = await runAxe(page, testInfo, "after");
  expect(after.map((v) => v.id)).toEqual([]);
  expect(diffViolations(before, after)).toEqual([]);
});
