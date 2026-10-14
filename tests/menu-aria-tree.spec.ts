import { test, expect, Page, TestInfo } from "@playwright/test";
import { snapshotTree, diffTree, waitForTreeChange, attachTreeDiff } from "./helpers/aria-tree";

// Duplicated from menu.spec.ts on purpose; importing from a spec file would register its tests.
const menuUrl = (variant: "accessible" | "broken") => `#/disclosure/menu?variant=${variant}`;

async function clickTrigger(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "manual") {
    console.log(">>> Click the menu button in the browser window <<<");
    await expect(page.getByTestId("menu")).toBeVisible({ timeout: 90_000 });
  } else {
    await page.getByTestId("trigger").click();
  }
}

for (const variant of ["accessible", "broken"] as const) {
  test(`${variant}: accessibility-tree diff detects the menu opening`, async ({ page }, testInfo) => {
    await page.goto(menuUrl(variant));
    await expect(page.getByTestId("trigger")).toBeVisible();

    const scope = page.locator("body"); // whole page: the diff should still contain only menu lines

    const before = await snapshotTree(scope);
    await clickTrigger(page, testInfo);
    const after = await waitForTreeChange(scope, before);
    const diff = diffTree(before, after);

    console.log(`[tree ${variant}] BEFORE\n${before}\n[tree ${variant}] AFTER\n${after}`);
    console.log(`[tree ${variant}] DIFF`, diff);
    await attachTreeDiff(testInfo, variant, before, after, diff);

    expect(diff.added.length).toBeGreaterThan(0);

    if (variant === "accessible") {
      expect(diff.added).toContainEqual(expect.stringMatching(/^- menu "Actions"/));
      expect(diff.added.filter((l) => /^- menuitem /.test(l))).toHaveLength(4);
      expect(diff.removed).toContainEqual(expect.stringMatching(/^- button "Actions"/));
      expect(diff.added).toContainEqual(expect.stringMatching(/^- button "Actions".*expanded/));
    } else {
      expect(diff.added).toContainEqual(expect.stringMatching(/^- list/));
      expect(diff.added.filter((l) => /^- listitem/.test(l))).toHaveLength(4);
      expect(diff.added).not.toContainEqual(expect.stringMatching(/^- menu/));
      const buttonLines = [...diff.added, ...diff.removed].filter((l) => /^- button/.test(l));
      expect(buttonLines).toEqual([]);
    }
  });
}
