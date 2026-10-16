import { test, expect, Page, TestInfo } from "@playwright/test";
import { runAxe, diffViolations } from "./helpers/axe";
import { watchDom, DomChange } from "./helpers/watch-dom";

const alertUrl = (variant: "accessible" | "broken") =>
  `#/live/alert?variant=${variant}&delay=1000`;

const expectedError =
  "Error: Could not save changes. Check your connection and try again.";


const announced = (text: string) => (changes: DomChange[]) =>
  changes.some(
    (change) =>
      change.inLiveRegion &&
      change.text?.includes(text)
  );

async function clickTrigger(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "manual") {
    console.log(">>> Click 'Save changes' in the browser <<<");

    await expect(page.getByTestId("error-text")).toHaveText(
      expectedError,
      { timeout: testInfo.timeout }
    );
  } else {
    await page.getByTestId("trigger").click();
  }
}


test("assertive error alert page loads", async ({ page }) => {
  await page.goto(alertUrl("accessible"));

  // verify the correct scenario is displayed
  await expect(page.getByTestId("scenario-root"))
    .toHaveAttribute("data-scenario", "live-alert");

  // verify the save button is available
  await expect(page.getByTestId("trigger"))
    .toBeVisible();

  await expect(page.getByTestId("trigger"))
    .toHaveText("Save changes");

  // no error message should be displayed initially
  await expect(page.getByTestId("error-text"))
    .toBeHidden();
});


test("accessible: error is announced through an assertive alert", async ({
  page,
}, testInfo) => {
  await page.goto(alertUrl("accessible"));

  // check accessibility before triggering the error
  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toEqual([]);

  // watch for meaningful DOM changes
  const watcher = await watchDom(
    page,
    '[data-testid="scenario-root"]'
  );

  // trigger the simulated save failure
  await clickTrigger(page, testInfo);

  // verify the error was added inside a live region
  const changes = await watcher.waitFor(announced(expectedError));

  console.log("[dom] accessible alert changes:", changes);

  // verify the complete error message is displayed
  await expect(page.getByTestId("error-text"))
    .toHaveText(expectedError);

  // role="alert" provides assertive live-region semantics
  await expect(page.getByTestId("alert"))
    .toHaveAttribute("role", "alert");

  // verify the error identifies the problem
  await expect(page.getByTestId("error-text"))
    .toContainText("Could not save changes");

  // verify the error suggests a corrective action
  await expect(page.getByTestId("error-text"))
    .toContainText("Check your connection and try again");

  // check accessibility after the error appears
  const after = await runAxe(page, testInfo, "after");

  expect(after.map((v) => v.id)).toEqual([]);
  expect(diffViolations(before, after)).toEqual([]);
});
