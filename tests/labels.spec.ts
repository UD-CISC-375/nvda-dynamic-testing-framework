import { test, expect } from "@playwright/test";
import { runAxe } from "./helpers/axe";

const labelsUrl = (variant: "accessible" | "broken") =>
  `#/forms/labels?variant=${variant}`;

// Single-state check; doesn't trigger interaction/compare DOM changes
test("accessible: labels expose names, required state, and description", async ({
  page,
}, testInfo) => {
  await page.goto(labelsUrl("accessible"));

  // Confirm visible label targets full-name field; accessibility
  // name omits visual required marker, while required/description convey
  // corresponding information to assistive technology
  const fullName = page.getByTestId("full-name");
  const labeledFullName = page.getByLabel("Full name");
  await expect(labeledFullName).toHaveCount(1);
  await expect(labeledFullName).toHaveAttribute("data-testid", "full-name");
  await expect(fullName).toHaveAccessibleName("Full name");
  await expect(fullName).toHaveJSProperty("required", true);
  await expect(fullName).toHaveAccessibleDescription("As shown on your ID");

  // Optional wording part of phone field's accessible name, and
  // the field itself not programmatically required
  const phone = page.getByTestId("phone");
  await expect(phone).toHaveAccessibleName("Phone (optional)");
  await expect(phone).toHaveJSProperty("required", false);

  // Clean axe result confirms there aren't detected accessibility violations
  const violations = await runAxe(page, testInfo, "accessible");
  expect(violations.map((violation) => violation.id)).toEqual([]);
});

test("broken: visible labels do not provide accessible names", async ({
  page,
}, testInfo) => {
  await page.goto(labelsUrl("broken"));

  // Text looks like label visually, but neither field gets accessible
  // name from it, and full-name field lacks required/description semantics
  const fullName = page.getByTestId("full-name");
  const phone = page.getByTestId("phone");
  await expect(fullName).toHaveAccessibleName("");
  await expect(phone).toHaveAccessibleName("");
  await expect(page.getByLabel("Full name")).toHaveCount(0);
  await expect(fullName).toHaveJSProperty("required", false);
  await expect(fullName).toHaveAccessibleDescription("");
  await expect(page.getByText("Full name *", { exact: true })).toBeVisible();

  // Axe detects missing programmatic labels
  const violations = await runAxe(page, testInfo, "broken");
  expect(violations.map((violation) => violation.id)).toContain("label");
});