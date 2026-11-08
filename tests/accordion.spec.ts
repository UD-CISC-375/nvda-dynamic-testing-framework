import { test, expect, Page, TestInfo } from "@playwright/test";
import { runAxe, diffViolations } from "./helpers/axe";
import { watchDom, DomChange } from "./helpers/watch-dom";
import { attachAnnotationEvaluation } from "./helpers/annotations";

/**
 * Component Name: Accordion Section
 * Selector: button#acc-header-1
 * Trigger Event: Click on button#acc-header-1
 * Intended State: aria-expanded="true", aria-controls
 * Expected Speech: "Expanded" or "Collapsed"
 */

const accordionUrl = (variant: "accessible" | "broken") =>
  `#/disclosure/accordion?variant=${variant}`;

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

async function clickTrigger(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "manual") {
    console.log(">>> Click the first accordion header in the browser window <<<");
    await expect(page.getByTestId("accordion-panel-1")).toBeVisible({
      timeout: testInfo.timeout,
    });
  } else {
    const annotated = page.locator("button#acc-header-1");
    if ((await annotated.count()) > 0) {
      await annotated.click();
    } else {
      await page.getByTestId("trigger").click();
    }
  }
}

test("accordion page loads", async ({ page }, testInfo) => {
  await page.goto(accordionUrl("accessible"));

  // Wait for React hydration and verify variant
  await expect(page.getByTestId("variant")).toHaveText("accessible");

  const trigger = page.locator("button#acc-header-1");
  await expect(trigger).toBeVisible();
  // Starting state before click: closed
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAttribute("aria-controls", "acc-panel-1");
  await expect(page.getByTestId("accordion-panel-1")).toBeHidden();
  await attachAnnotationEvaluation(page, testInfo, { phase: "load" });
});

test("accessible: opening the accordion is detected and stays clean", async ({
  page,
}, testInfo) => {
  await page.goto(accordionUrl("accessible"));
  await expect(page.getByTestId("variant")).toHaveText("accessible");

  const trigger = page.locator("button#acc-header-1");
  await expect(trigger).toBeVisible();

  // Verify button role and controls attribute before action
  await expect(
    page.getByRole("button", { name: "What is NVDA?" }),
  ).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-controls", "acc-panel-1");

  // 1. Baseline scan
  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toEqual([]);

  // 2. Start DOM watcher
  const watcher = await watchDom(page, ".accordion");

  // 3. Trigger action
  await clickTrigger(page, testInfo);

  // 4. Wait for expected DOM mutation
  const changes = await watcher.waitFor(accordionOpened);
  console.log("[dom] detected:", changes);

  // Assert final accessible state
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("region", { name: "What is NVDA?" }),
  ).toBeVisible();
  await attachAnnotationEvaluation(page, testInfo, { phase: "after-trigger" });

  // 5. Post-action scan
  const after = await runAxe(page, testInfo, "after");
  expect(after.map((v) => v.id)).toEqual([]);
  expect(diffViolations(before, after)).toEqual([]);
});

test("broken: opening the accordion sets aria-expanded and aria-controls", async ({
  page,
}, testInfo) => {
  await page.goto(accordionUrl("broken"));
  await expect(page.getByTestId("variant")).toHaveText("broken");

  const trigger = page.getByTestId("trigger");
  await expect(trigger).toBeVisible();

  await clickTrigger(page, testInfo);
  await expect(page.getByTestId("accordion-panel-1")).toBeVisible();
  // Capture the live DOM before compliance asserts fail so the report still
  // shows the intended-vs-actual table and automated remediation.
  await attachAnnotationEvaluation(page, testInfo, { phase: "after-trigger" });

  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(trigger).toHaveAttribute("aria-controls", "acc-panel-1");
});