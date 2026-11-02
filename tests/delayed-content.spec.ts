
import { test, expect } from "@playwright/test";
import { runAxe } from "./helpers/axe";

// Team Y's delayed content scenario.
const delayedContentUrl = (variant: "accessible" | "broken") =>
  `#/dynamic/delayed-content?variant=${variant}&delay=3000`;

test("accessible: delayed content is announced correctly", async ({
  page,
}, testInfo) => {
  await page.goto(delayedContentUrl("accessible"));
  await expect(page.getByTestId("variant")).toHaveText("accessible");

  const region = page.getByRole("region", {
    name: "Recommended for you",
  });
  const status = page.getByTestId("scenario-root").getByRole("status");
  const injected = page.getByTestId("injected");

  // Check the loading state before the recommendations appear.
  await expect(region).toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Recommended for you",
    }),
  ).toBeVisible();
  await expect(status).toHaveText("Loading recommendations…");
  await expect(injected).toHaveCount(0);

  // Save the original status element before running axe.
  const statusHandle = await status.elementHandle();
  expect(statusHandle).not.toBeNull();

  const beforeViolations = await runAxe(page, testInfo, "before");
  expect(beforeViolations.map((v) => v.id)).toEqual([]);

  // The recommendations appear automatically after the delay.
  await expect(injected).toBeVisible({ timeout: 10_000 });

  await expect(status).toHaveText("3 recommendations loaded");
  await expect(region).toHaveAttribute("aria-busy", "false");
  await expect(injected.getByRole("listitem")).toHaveCount(3);

  // Check that the original status element is still on the page.
  const stillConnected = await statusHandle!.evaluate(
    (element) => element.isConnected,
  );
  expect(stillConnected).toBe(true);

  const afterViolations = await runAxe(page, testInfo, "after");
  expect(afterViolations.map((v) => v.id)).toEqual([]);
});

test("broken: delayed content has no accessibility announcements", async ({
  page,
}, testInfo) => {
  await page.goto(delayedContentUrl("broken"));
  await expect(page.getByTestId("variant")).toHaveText("broken");

  const root = page.getByTestId("scenario-root");
  const injected = page.getByTestId("injected");

  // The broken version has no content or status while loading.
  await expect(injected).toHaveCount(0);
  await expect(root.getByRole("status")).toHaveCount(0);

  // The content appears automatically without clicking anything.
  await expect(injected).toBeVisible({ timeout: 10_000 });

  await expect(
    injected.getByText("Recommended for you"),
  ).toBeVisible();

  // The broken version has no real heading, region, status, or list.
  await expect(
    root.getByRole("heading", { name: "Recommended for you" }),
  ).toHaveCount(0);
  await expect(
    root.getByRole("region", { name: "Recommended for you" }),
  ).toHaveCount(0);
  await expect(root.getByRole("status")).toHaveCount(0);
  await expect(injected.getByRole("listitem")).toHaveCount(0);

  const violations = await runAxe(page, testInfo, "after");
  expect(violations.map((v) => v.id)).toEqual([]);
});
