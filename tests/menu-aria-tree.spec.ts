import { test, expect, Page } from "@playwright/test";
// Import the helpers that snapshot, diff, wait on, and attach accessibility trees.
import { snapshotTree, diffTree, waitForTreeChange, attachTreeDiff } from "./helpers/aria-tree";

// Duplicated from menu.spec.ts on purpose; importing from a spec file would register its tests.
// Build the hash route for the menu demo page, selecting the accessible or broken variant.
const menuUrl = (variant: "accessible" | "broken") => `#/disclosure/menu?variant=${variant}`;

async function clickTrigger(page: Page) {
  await page.getByTestId("trigger").click();
}

// Generate one test per variant so both the accessible and broken menus are checked.
for (const variant of ["accessible", "broken"] as const) {
  // Define a test whose name includes the variant; receives the page fixture and test metadata.
  test(`${variant}: accessibility-tree diff detects the menu opening`, async ({ page }, testInfo) => {
    // Navigate to the menu demo page for this variant.
    await page.goto(menuUrl(variant));
    // Make sure the trigger button has rendered before taking any snapshot.
    await expect(page.getByTestId("trigger")).toBeVisible();

    // Snapshot the whole page rather than just the menu.
    const scope = page.locator("body"); // whole page: the diff should still contain only menu lines

    // Capture the accessibility tree before the menu is opened.
    const before = await snapshotTree(scope);
    await clickTrigger(page);
    // Poll until the accessibility tree changes and settles, then capture it.
    const after = await waitForTreeChange(scope, before);
    // Compute which tree lines were added and removed by opening the menu.
    const diff = diffTree(before, after);

    // Log the full before and after trees for debugging.
    console.log(`[tree ${variant}] BEFORE\n${before}\n[tree ${variant}] AFTER\n${after}`);
    // Log the computed added/removed lines.
    console.log(`[tree ${variant}] DIFF`, diff);
    // Attach the before/after trees and the diff to the Playwright test report.
    await attachTreeDiff(testInfo, variant, before, after, diff);

    // Both variants must add something to the tree when the menu opens.
    expect(diff.added.length).toBeGreaterThan(0);

    // Assertions for the correctly implemented menu.
    if (variant === "accessible") {
      // A node with role "menu" named "Actions" should appear.
      expect(diff.added).toContainEqual(expect.stringMatching(/^- menu "Actions"/));
      // Exactly four "menuitem" nodes should appear.
      expect(diff.added.filter((l) => /^- menuitem /.test(l))).toHaveLength(4);
      // The old collapsed "Actions" button line should be gone.
      expect(diff.removed).toContainEqual(expect.stringMatching(/^- button "Actions"/));
      // It should be replaced by an "Actions" button line that reports expanded state.
      expect(diff.added).toContainEqual(expect.stringMatching(/^- button "Actions".*expanded/));
    // Assertions for the broken menu, which documents what a screen reader would miss.
    } else {
      // The broken menu exposes a plain list instead of a menu.
      expect(diff.added).toContainEqual(expect.stringMatching(/^- list/));
      // Its four options show up as generic list items.
      expect(diff.added.filter((l) => /^- listitem/.test(l))).toHaveLength(4);
      // No "menu" role should appear at all.
      expect(diff.added).not.toContainEqual(expect.stringMatching(/^- menu/));
      // Collect any button lines that were added or removed.
      const buttonLines = [...diff.added, ...diff.removed].filter((l) => /^- button/.test(l));
      // The button never changes (no aria-expanded), so there should be none.
      expect(buttonLines).toEqual([]);
    // End of variant-specific assertions.
    }
  // End of the test body.
  });
// End of the per-variant loop.
}
