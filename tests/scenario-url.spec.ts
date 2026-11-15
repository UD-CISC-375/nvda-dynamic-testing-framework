// Import Playwright's test runner and assertion library.
import { test, expect } from "@playwright/test";
// Import the helpers under test.
import { gotoScenario, withDelay } from "./helpers/scenarios";

// The manifest's URLs have no delay, so withDelay appends one after variant.
test("withDelay adds a delay after the existing params", () => {
  expect(withDelay("#/live/polite?variant=broken", 1000)).toBe(
    "#/live/polite?variant=broken&delay=1000"
  );
});

// A second call must replace the delay, not add a duplicate param.
test("withDelay replaces an existing delay", () => {
  expect(withDelay("#/live/polite?variant=broken&delay=1000", 3000)).toBe(
    "#/live/polite?variant=broken&delay=3000"
  );
});

// delay=0 means "update immediately" on the site, so it must be written out.
test("withDelay keeps a zero delay", () => {
  expect(withDelay("#/disclosure/dialog?variant=accessible", 0)).toBe(
    "#/disclosure/dialog?variant=accessible&delay=0"
  );
});

// A route with no query still gets a well-formed one.
test("withDelay works on a route with no query", () => {
  expect(withDelay("#/live/polite", 500)).toBe("#/live/polite?delay=500");
});

// A known id opens the right route and the scenario renders.
test("gotoScenario opens the manifest URL with the given delay", async ({ page }) => {
  await gotoScenario(page, "live-polite", "broken", { delay: 1000 });
  // The hash is what the manifest gave, plus the pinned delay.
  expect(new URL(page.url()).hash).toBe("#/live/polite?variant=broken&delay=1000");
  await expect(page.getByTestId("scenario-root")).toBeVisible();
});

// A typo should fail fast with the list of valid ids.
test("gotoScenario throws for an unknown id", async ({ page }) => {
  await expect(gotoScenario(page, "no-such-scenario", "accessible")).rejects.toThrow(
    /Unknown scenario id "no-such-scenario".*disclosure-menu/
  );
});
