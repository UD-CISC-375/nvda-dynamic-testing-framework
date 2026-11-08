/**
 * Component Name: Accordion Section
 * Selector: #accordion-panel
 * Trigger Event: Click on button#accordion-header-btn
 * Intended State: aria-expanded="true", aria-controls
 * Expected Speech: "Expanded" or "Collapsed"
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, Page, TestInfo } from "@playwright/test";
import { attachAnnotationEvaluation } from "./helpers/annotations";
import { isolatedAccordionUrl } from "./helpers/isolated-pages";

const accordionPage = isolatedAccordionUrl();

async function clickHeader(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "manual") {
    console.log(">>> Click the accordion header button in the browser <<<");
    await expect(page.locator("#accordion-panel")).toBeVisible({
      timeout: testInfo.timeout,
    });
  } else {
    await page.locator("button#accordion-header-btn").click();
  }
}

test.describe("isolated accordion URL", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name === "manual",
      "URL resolution checks run in the automated chromium project.",
    );
  });

  test("uses a local accordion.html when GitHub Pages does not host it", () => {
    expect(accordionPage.startsWith("file:")).toBe(true);
    expect(accordionPage).toMatch(/accordion\.html$/i);
    expect(
      existsSync(resolve(process.cwd(), "tests/fixtures/accordion.html")),
    ).toBe(true);
  });

  test("falls back to the deployed URL when no local file exists", () => {
    expect(isolatedAccordionUrl(resolve(process.cwd(), "missing-workspace"))).toBe(
      "https://UD-CISC-375.github.io/nvda-dynamic-testing-webpage/accordion.html",
    );
  });
});

test("isolated broken accordion page loads", async ({ page }, testInfo) => {
  await page.goto(accordionPage);

  const header = page.locator("button#accordion-header-btn");
  await expect(header).toBeVisible();
  await expect(page.locator("#accordion-panel")).toBeHidden();
  await attachAnnotationEvaluation(page, testInfo, { phase: "load" });
});

test("broken: header click sets aria-expanded and aria-controls", async ({
  page,
}, testInfo) => {
  await page.goto(accordionPage);

  const header = page.locator("button#accordion-header-btn");
  const panel = page.locator("#accordion-panel");

  await clickHeader(page, testInfo);
  await expect(panel).toBeVisible();
  // Capture the live DOM before compliance asserts fail so the report still
  // shows the intended-vs-actual table and automated remediation.
  await attachAnnotationEvaluation(page, testInfo, { phase: "after-trigger" });

  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(header).toHaveAttribute("aria-controls", "accordion-panel");
});
