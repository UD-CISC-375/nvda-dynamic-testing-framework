import { test, expect } from "@playwright/test";
import { runAxe } from "./helpers/axe";

// The submission confirmation scenario on Team Y's site: sending feedback
// shows "Sending..." on the button for `delay` ms, then a confirmation.
// delay=3000 holds the "Sending..." state long enough to check it reliably
// (the default is 1000 ms).
// axe can't detect the broken variant's flaw (manifest: nvdaOnly: true), so
// these tests check the live region and focus directly.
const submissionConfirmationUrl = (variant: "accessible" | "broken") =>
  `#/forms/success?variant=${variant}&delay=3000`;

test("accessible: confirmation is announced and focus stays on the button", async ({
  page,
}, testInfo) => {
  await page.goto(submissionConfirmationUrl("accessible"));

  const status = page.getByRole("status");
  const feedback = page.getByTestId("feedback");
  const trigger = page.getByTestId("trigger");

  // 1. The live region exists from page load and is empty. (An empty region
  // has no size, so check it's in the DOM rather than visible.)
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText("");

  // 2. Fill in feedback and send it with the keyboard. Focusing the button
  // first is what makes the focus checks below meaningful, so no .click().
  await feedback.fill("Great page");
  await trigger.focus();
  await page.keyboard.press("Enter");

  // 3. While sending, the button says so. (The site uses the single "…"
  // character, not three dots.)
  await expect(trigger).toHaveText("Sending…");

  // 4. The confirmation is written into the role="status" region, so NVDA
  // announces it without moving focus.
  await expect(page.getByTestId("success")).toBeVisible();
  await expect(status).toContainText("Thanks! Your feedback was submitted.");

  // 5. The form is reset but still on the page, and focus never left the button.
  await expect(feedback).toHaveValue("");
  await expect(trigger).toHaveText("Send feedback");
  await expect(trigger).toBeFocused();

  const violations = await runAxe(page, testInfo, "after");
  expect(violations.map((v) => v.id)).toEqual([]);
});

test("broken: form is replaced, nothing is announced and focus is lost", async ({
  page,
}, testInfo) => {
  await page.goto(submissionConfirmationUrl("broken"));

  // 1. Fill in feedback and send it with the keyboard.
  await page.getByTestId("feedback").fill("Great page");
  await page.getByTestId("trigger").focus();
  await page.keyboard.press("Enter");

  // 2. The confirmation appears on screen...
  await expect(page.getByTestId("success")).toBeVisible();

  // ...but there's no live region, so NVDA says nothing.
  await expect(page.getByRole("status")).toHaveCount(0);

  // The whole form, including the focused button, was replaced by the message.
  await expect(page.getByTestId("trigger")).toHaveCount(0);
  await expect(page.getByTestId("feedback")).toHaveCount(0);

  // With the focused button gone, focus falls back to <body>: a keyboard
  // user loses their place.
  await expect
    .poll(() => page.evaluate(() => document.activeElement === document.body))
    .toBe(true);

  // axe passes anyway: this is the flaw only a screen reader test catches.
  const violations = await runAxe(page, testInfo, "after");
  expect(violations.map((v) => v.id)).toEqual([]);
});
