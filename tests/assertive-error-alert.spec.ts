import { test, expect } from "@playwright/test";
import { runAxe, diffViolations } from "./helpers/axe";
import { watchDom } from "./helpers/watch-dom";

const alertUrl = (variant: "accessible" | "broken") =>
  `#/live/alert?variant=${variant}&delay=1000`;

const expectedError =
  "Error: Could not save changes. Check your connection and try again.";

test("assertive error alert page loads", async ({ page }) => {
  await page.goto(alertUrl("accessible"));

  // Verify the correct scenario is displayed.
  await expect(page.getByTestId("scenario-root"))
    .toHaveAttribute("data-scenario", "live-alert");

  // Verify the save button is available.
  await expect(page.getByTestId("trigger"))
    .toBeVisible();

  await expect(page.getByTestId("trigger"))
    .toHaveText("Save changes");

  // No error message should be displayed initially.
  await expect(page.getByTestId("error-text"))
    .toBeHidden();
});
