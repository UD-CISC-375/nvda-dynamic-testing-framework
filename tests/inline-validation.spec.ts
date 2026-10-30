import { test, expect, Page } from "@playwright/test";
import { runAxe } from "./helpers/axe";
import { watchDom, DomChange } from "./helpers/watch-dom";

const inlineValidationUrl = (variant: "accessible" | "broken") =>
  `#/forms/inline-validation?variant=${variant}`;

const validationReported = (changes: DomChange[]) =>
  changes.some(
    (change) =>
      change.target === "input#email" &&
      change.attributeName === "aria-invalid" &&
      change.newValue === "true",
  ) &&
  changes.some(
    (change) =>
      change.target === "input#email" &&
      change.attributeName === "aria-describedby" &&
      change.newValue?.includes("email-error"),
  ) &&
  changes.some(
    (change) =>
      change.type === "childList" &&
      change.added.some((added) => added === "p" || added.startsWith("p#")),
  );

const errorDisplayed = (changes: DomChange[]) =>
  changes.some(
    (change) =>
      change.type === "childList" &&
      change.added.some((added) => added === "p" || added.startsWith("p#")),
  );

const inlineValidationAxeTags = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

async function triggerBlurValidation(page: Page) {
  await page.getByTestId("email").fill("not-an-email");
  await page.getByTestId("check").click();
}

test("inline validation page loads with a labeled email field", async ({
  page,
}) => {
  await page.goto(inlineValidationUrl("accessible"));

  await expect(page.getByTestId("variant")).toHaveText("accessible");
  await expect(page.getByTestId("email")).toHaveAccessibleName(
    "Email address",
  );
  await expect(page.getByTestId("error")).toHaveCount(0);
  await expect(page.getByTestId("wcag-criteria")).toContainText("3.3.1");
  await expect(page.getByTestId("wcag-criteria")).toContainText("1.4.1");
  await expect(page.getByTestId("wcag-criteria")).toContainText("3.3.3");
  await expect(page.getByTestId("wcag-criteria")).toContainText("1.3.1");
});

test("accessible: blur validation exposes the error and stays axe-clean", async (
  { page },
  testInfo,
) => {
  await page.goto(inlineValidationUrl("accessible"));
  await expect(page.getByTestId("email")).toBeVisible();

  const before = await runAxe(
    page,
    testInfo,
    "before",
    inlineValidationAxeTags,
  );
  expect(before.map((violation) => violation.id)).toEqual([]);

  const watcher = await watchDom(page, ".scenario");
  await triggerBlurValidation(page);

  const changes = await watcher.waitFor(validationReported);
  console.log("[dom] detected inline validation feedback:", changes);

  const email = page.getByTestId("email");
  const error = page.getByTestId("error");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAttribute(
    "aria-describedby",
    "email-hint email-error",
  );
  await expect(error).toBeVisible();
  await expect(error).toContainText(
    "Enter a valid email address, like name@example.com",
  );
  // The visible message identifies the error without relying on the red border alone.
  await expect(email).toHaveClass("input-error");

  const after = await runAxe(
    page,
    testInfo,
    "after",
    inlineValidationAxeTags,
  );
  expect(after.map((violation) => violation.id)).toEqual([]);
});

test("broken: blur validation shows an error without programmatic error semantics", async (
  { page },
  testInfo,
) => {
  await page.goto(inlineValidationUrl("broken"));
  await expect(page.getByTestId("email")).toBeVisible();

  const before = await runAxe(
    page,
    testInfo,
    "before",
    inlineValidationAxeTags,
  );
  expect(before.map((violation) => violation.id)).toEqual([]);

  const watcher = await watchDom(page, ".scenario");
  await triggerBlurValidation(page);

  const changes = await watcher.waitFor(errorDisplayed);
  console.log("[dom] visible error inserted without semantic signals:", changes);

  const email = page.getByTestId("email");
  const error = page.getByTestId("error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("Enter a valid email address");
  await expect(email).not.toHaveAttribute("aria-invalid");
  await expect(email).not.toHaveAttribute("aria-describedby");

  const after = await runAxe(
    page,
    testInfo,
    "after",
    inlineValidationAxeTags,
  );
  // axe does not infer that the unassociated message is an error for this field.
  expect(after.map((violation) => violation.id)).toEqual([]);
});
