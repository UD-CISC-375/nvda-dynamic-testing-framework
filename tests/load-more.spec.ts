
import { test, expect } from "@playwright/test";
import { runAxe } from "./helpers/axe";

// Team Y's Load More scenario.
// The longer delay makes the loading message easier to check.
const loadMoreUrl = (variant: "accessible" | "broken") =>
  `#/dynamic/load-more?variant=${variant}&delay=3000`;

test("accessible: loading articles announces updates and moves focus", async ({
  page,
}, testInfo) => {
  await page.goto(loadMoreUrl("accessible"));
  await expect(page.getByTestId("variant")).toHaveText("accessible");

  const button = page.getByTestId("trigger");
  const status = page.getByRole("status");

  // The page starts with five articles.
  await expect(page.getByTestId("item-1")).toBeVisible();
  await expect(page.getByTestId("item-5")).toBeVisible();
  await expect(page.getByTestId("item-6")).toHaveCount(0);
  await expect(status).toHaveText("Showing 5 of 15 articles");

  // Load five more articles using the keyboard.
  await button.focus();
  await button.press("Enter");

  await expect(status).toHaveText("Loading more articles…");
  await expect(page.getByTestId("item-6")).toBeVisible();

  await expect(status).toHaveText("Showing 10 of 15 articles");
  await expect(page.getByTestId("item-6")).toBeFocused();

  // Load the last five articles.
  await button.focus();
  await button.press("Enter");

  await expect(page.getByTestId("item-11")).toBeVisible();
  await expect(status).toHaveText("Showing 15 of 15 articles");
  await expect(page.getByTestId("item-11")).toBeFocused();

  // The button disappears after all articles are loaded.
  await expect(button).toHaveCount(0);

  const violations = await runAxe(page, testInfo, "after");
  expect(violations.map((v) => v.id)).toEqual([]);
});

test("broken: loading articles does not announce updates or manage focus", async ({
  page,
}, testInfo) => {
  await page.goto(loadMoreUrl("broken"));
  await expect(page.getByTestId("variant")).toHaveText("broken");

  const button = page.getByTestId("trigger");

  // The broken version still loads articles with the keyboard.
  await button.focus();
  await button.press("Enter");

  await expect(page.getByTestId("item-6")).toBeVisible();

  // No status message is available to screen readers.
  await expect(page.getByRole("status")).toHaveCount(0);

  // Focus incorrectly stays on the button.
  await expect(button).toBeFocused();

  // Load the remaining articles.
  await button.press("Enter");
  await expect(page.getByTestId("item-11")).toBeVisible();

  // The focused button disappears, so focus is lost.
  await expect(button).toHaveCount(0);

  const focusIsOnBody = await page.evaluate(
    () => document.activeElement === document.body,
  );
  expect(focusIsOnBody).toBe(true);

  const violations = await runAxe(page, testInfo, "after");
  expect(violations.map((v) => v.id)).toEqual([]);
});
