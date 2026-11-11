
import { test, expect } from "@playwright/test";
import { loadScenarios } from "./helpers/scenarios";

test("loads all scenarios from the manifest", async ({ request }) => {
  const scenarios = await loadScenarios(request);

  // Team Y currently has 16 scenarios.
  expect(scenarios).toHaveLength(16);

  // Check that every scenario has a unique ID.
  const ids = scenarios.map(s => s.id);
  expect(new Set(ids).size).toBe(scenarios.length);

  // Find the menu scenario.
  const menu = scenarios.find(
    s => s.id === "disclosure-menu"
  );

  expect(menu).toBeDefined();

  // Compare against the URL menu.spec.ts currently uses.
  expect(menu?.urls.broken).toBe(
    "#/disclosure/menu?variant=broken"
  );
});