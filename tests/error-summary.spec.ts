import { test, expect } from "@playwright/test";
import { runAxe } from "./helpers/axe";

// The error summary scenario on Team Y's site. Submitting the form with empty
// fields should report every error. axe can't see this flaw (nvdaOnly: true):
// the broken variant still renders the error text, it just never tells a
// screen reader about it. So these tests check focus and ARIA wiring directly.
// accessible should pass on our tests
// broken will still pass but we are asserting what the failure is and checking
const errorSummaryUrl = (variant: "accessible" | "broken") =>
  `#/forms/error-summary?variant=${variant}`;

test("accessible: submitting empty fields moves focus to an error summary", async ({
  page,
}, testInfo) => {
  await page.goto(errorSummaryUrl("accessible"));

  const name = page.getByTestId("name");
  const email = page.getByTestId("email");
  const summary = page.getByTestId("error-summary");

  // Submit with both fields empty, using the keyboard like an NVDA user would.
  await page.getByTestId("trigger").focus();
  await page.keyboard.press("Enter");

  // There's no live region, so moving focus to the summary is the only way
  // NVDA finds out the submit failed.
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(summary.getByRole("heading")).toHaveText(
    "There are 2 problems with your submission",
  );
  const nameLink = summary.getByRole("link", { name: "Enter your name" });
  await expect(nameLink).toBeVisible();
  await expect(
    summary.getByRole("link", { name: "Enter your email address" }),
  ).toBeVisible();

  // Each input is flagged invalid and has its error message as its
  // description, so NVDA reads "invalid entry, Enter your name" on focus.
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription("Enter your name");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAccessibleDescription("Enter your email address");

  // Each summary link takes you to the field it's about.
  await nameLink.click();
  await expect(name).toBeFocused();

  // Fix one field and submit again: the summary updates its count and takes
  // focus again, so the user hears about the remaining error.
  await name.fill("Ada Lovelace");
  await page.getByTestId("trigger").focus();
  await page.keyboard.press("Enter");
  await expect(summary.getByRole("heading")).toHaveText(
    "There is 1 problem with your submission",
  );
  await expect(summary).toBeFocused();

  const violations = await runAxe(page, testInfo, "after");
  expect(violations.map((v) => v.id)).toEqual([]);
});

test("broken: errors appear but NVDA is never told about them", async ({
  page,
}, testInfo) => {
  await page.goto(errorSummaryUrl("broken"));

  const trigger = page.getByTestId("trigger");
  const name = page.getByTestId("name");
  const email = page.getByTestId("email");

  await trigger.focus();
  await page.keyboard.press("Enter");

  // The errors DO exist on screen...
  await expect(page.getByTestId("name-error")).toBeVisible();
  await expect(page.getByTestId("email-error")).toBeVisible();

  // ...but there's no summary, focus never leaves Submit, and the inputs
  // aren't marked invalid or linked to their errors. NVDA says nothing.
  //
  // These checks pin down the flaw itself, so this test FAILS if Team Y ever
  // fixes the broken page (on purpose or by accident). That's how we know
  // the test really detects the problem instead of passing no matter what.
  // Each fix trips its own check:

  // Fail if Team Y adds an error summary.
  await expect(page.getByTestId("error-summary")).toHaveCount(0);
  // Fail if Team Y moves focus off Submit (e.g. to a summary or a field).
  await expect(trigger).toBeFocused();
  // Fail if Team Y sets aria-invalid or links the inputs to their errors.
  await expect(name).not.toHaveAttribute("aria-invalid");
  await expect(name).toHaveAccessibleDescription("");
  await expect(email).not.toHaveAttribute("aria-invalid");
  await expect(email).toHaveAccessibleDescription("");

  // axe passes anyway: this is the flaw only a screen reader test catches.
  const violations = await runAxe(page, testInfo, "after");
  expect(violations.map((v) => v.id)).toEqual([]);
});
