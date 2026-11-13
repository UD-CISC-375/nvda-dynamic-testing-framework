import { test, expect, request, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import type { SetupStep, Variant } from "./helpers/scenarios";

// Allows ES module to use CommonJS helpers
const require = createRequire(import.meta.url);

const { loadScenarios } = require("./helpers/scenarios") as
  typeof import("./helpers/scenarios");

const { runAxe } = require("./helpers/axe") as
  typeof import("./helpers/axe");

// Load scenarios from manifest
const baseURL =
  process.env.BASE_URL ??
  "https://UD-CISC-375.github.io/nvda-dynamic-testing-webpage/";

const context = await request.newContext({ baseURL });
let scenarios;
try {
  scenarios = await loadScenarios(context);
} finally {
  await context.dispose();
}

const variants: Variant[] = ["accessible", "broken"];

const AXE_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
  "best-practice",
];

// Runs action listed in manifest via test ID
async function runSetupStep(page: Page, step: SetupStep) {
  const element = page.getByTestId(step.testid);

  switch (step.action) {
    case "click":
      await element.click();
      break;
    case "fill":
      if (step.value === undefined) {
        throw new Error(`Missing value for fill step: ${step.testid}`);
      }
      await element.fill(step.value);
      break;
    case "press":
      if (step.value === undefined) {
        throw new Error(`Missing value for press step: ${step.testid}`);
      }
      await element.press(step.value);
      break;
    case "waitFor":
      await element.waitFor({ state: "visible" });
      break;
    default:
      throw new Error(`Unknown setup action: ${String(step.action)}`);
  }
}

// Helps with test running speed, shortens delay if possible
function getUrlWithDelay(url: string, defaultDelay: number): string {
  if (defaultDelay <= 0) return url;

  const [route, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  params.set("delay", String(Math.min(defaultDelay, 500)));
  return `${route}?${params}`;
}

// Generates test for each scenario and variant
for (const scenario of scenarios) {
  for (const variant of variants) {
    test.describe(() => {
      test.skip(scenario.axe.nvdaOnly, "needs a screen reader check");

      test(`${scenario.id} - ${variant}`, async ({ page }, testInfo) => {
        await page.goto(
          getUrlWithDelay(scenario.urls[variant], scenario.defaultDelay)
        );
        await expect(page.getByTestId("scenario-root")).toBeVisible();

        // Waits to scan page until setup steps are completed
        for (const step of scenario.setup) {
          await runSetupStep(page, step);
        }

        const violations = await runAxe(page, testInfo, "generated", AXE_TAGS);
        const actualRules = violations.map((violation) => violation.id);

        if (variant === "accessible") {
          expect(actualRules).toEqual([]);
        } else {
          for (const rule of scenario.axe.brokenRules) {
            expect(
              actualRules,
              `${scenario.id} should violate ${rule}`
            ).toContain(rule);
          }
        }
      });
    });
  }
}
