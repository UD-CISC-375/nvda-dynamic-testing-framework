import { test, expect, Page, TestInfo } from "@playwright/test";
import { runAxe, diffViolations } from "./helpers/axe";

// The tab scenario on Team Y's site (WCAG (4.1.2, 2.1.1, 1.3.1, 2.4.7).
// accessibile should pass all checks
// broken will pass but outline the failure:
// tabs are not keyboard operable, aria-selected is unavailable, and tablist is missing
const tabsUrl = (variant: "accessible" | "broken") =>
  `#/disclosure/tabs?variant=${variant}`;

async function openTabs(page: Page, variant: "accessible" | "broken") {
  await page.goto(tabsUrl(variant));
  await expect(page.getByTestId("variant")).toHaveText(variant);
  await expect(page.getByTestId("scenario-root")).toBeVisible();
}

test(c, async ({ page }) => {
  await openTabs(page, "accessible");
  const tabs = page.getByRole("tablist").getByRole("tab");
  expect(await tabs.count()).toBeGreaterThan(1);
  await expect(page.getByRole("tab", { selected: true })).toHaveCount(1);
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("accessible: switching tabs updates the selected state and panel", async ({ page }, testInfo) => {
  await openTabs(page, "accessible");

  // Run axe-core check on web page before any interactions.***
  const before = await runAxe(page, testInfo, "before");
  expect(before.map((v) => v.id)).toEqual([]);

  const tabs = page.getByRole("tablist").getByRole("tab");
  const first = tabs.first();
  const second = tabs.nth(1);
  // If the site starts with a different selection, click the first tab first.
  await first.click();
  // Verifies that the active tab is the first one.***
  await expect(first).toHaveAttribute("aria-selected", "true");
  await second.click();
  // Verifies that the active tab is the second one.***
  await expect(second).toHaveAttribute("aria-selected", "true");
  // Verifies that the first tab is not active.***
  await expect(first).toHaveAttribute("aria-selected", "false");

  // Verifies that the panel corresponding to the selected tab is the correct panel.***
  const panelId = await second.getAttribute("aria-controls");
  expect(panelId, "selected tab should point to its panel").toBeTruthy();
  await expect(page.locator(`[id=${JSON.stringify(panelId)}]`)).toBeVisible();
  await expect(page.locator(`[id=${JSON.stringify(panelId)}]`)).toHaveAttribute("role", "tabpanel");

  // Run axe-core check on web page after interactions.***
  const after = await runAxe(page, testInfo, "after");
  expect(after.map((v) => v.id)).toEqual([]);
  expect(diffViolations(before, after)).toEqual([]);
});

test("broken: tabs lack tab semantics and arrow-key navigation", async ({ page }, testInfo) => {
  await openTabs(page, "broken");
  const root = page.getByTestId("scenario-root");

  // This variant shows Profile / Security / Billing visually, but does not
  // expose them as an accessible tablist with a selected tab.
  const before = await runAxe(page, testInfo, "before");
  // Verify that the tabs are not accessible.***
  await expect(root.getByRole("tablist")).toHaveCount(0);
  await expect(root.locator('[aria-selected="true"]')).toHaveCount(0);

  // Clicking Security still changes the displayed content: the problem is
  // missing accessible semantics, not necessarily mouse interaction.
  const security = root.getByText("Security", { exact: true });
  await security.click();
  // todo: Check that Security panel is showing after clicking the Security tab.
  // await expect(root.getByText("Your password and security settings.")).toBeVisible();
  await expect(security).toBeVisible();

  // Clicking Profile sets a point to start at. Pressing right arrow should
  // move keyboard focus for a correctly implemented horizontal tablist.
  // Absent in broken version.
  const profile = root.getByText("Profile", { exact: true });
  await profile.click();

  // The broken tab cannot receive keyboard focus
  await page.keyboard.press("Tab");

  await expect(profile).not.toBeFocused();

  // The broken tab should not respond to arrow-key navigation
  await page.keyboard.press("ArrowRight");

  await expect(profile).toHaveAttribute("data-active", "true");

  const after = await runAxe(page, testInfo, "after");
  console.log("[tabs broken] No tablist, tab role, selected state, or arrow-key focus movement");
  console.log("[axe] violations:", after.map((v) => v.id));
  console.log("[axe] new since baseline:", diffViolations(before, after));
});