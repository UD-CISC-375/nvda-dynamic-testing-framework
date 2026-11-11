/**
 * Component Name: Accordion Section
 * Selector: #accordion-panel
 * Trigger Event: Click on button#accordion-header-btn
 * Intended State: aria-expanded="true", aria-controls
 * Expected Speech: "Expanded" or "Collapsed"
 */

import { test, expect, Page } from "@playwright/test";
import { attachAnnotationEvaluation } from "./helpers/annotations";
import { isolatedAccordionUrl } from "./helpers/isolated-pages";

const accordionPage = isolatedAccordionUrl();

async function clickHeader(page: Page) {
  await page.locator("button#accordion-header-btn").click();
}

test("isolated accordion page loads", async ({ page }, testInfo) => {
  await page.goto(accordionPage);

  const header = page.locator("button#accordion-header-btn");
  await expect(header).toBeVisible();
  await expect(page.locator("#accordion-panel")).toBeHidden();
  await attachAnnotationEvaluation(page, testInfo, { phase: "load" });
});

test("header click sets aria-expanded and aria-controls", async ({
  page,
}, testInfo) => {
  await page.goto(accordionPage);

  const header = page.locator("button#accordion-header-btn");
  const panel = page.locator("#accordion-panel");

  await clickHeader(page);
  await expect(panel).toBeVisible();
  // Capture the live DOM before compliance asserts fail so the report still
  // shows the intended-vs-actual table and automated remediation.
  await attachAnnotationEvaluation(page, testInfo, { phase: "after-trigger" });

  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(header).toHaveAttribute("aria-controls", "accordion-panel");
});
