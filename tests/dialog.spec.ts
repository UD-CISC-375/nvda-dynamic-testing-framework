import { test, expect, Page, TestInfo } from "@playwright/test";
import { runAxe } from "./helpers/axe";
import { watchDom, DomChange } from "./helpers/watch-dom";

const dialogUrl = (variant: "accessible" | "broken") =>
  `#/disclosure/dialog?variant=${variant}&delay=0`;

const dialogInserted = (changes: DomChange[]) =>
  changes.some((change) => change.type === "childList" && change.added.length > 0);

const dialogAxeTags = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
];

async function openDialog(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === "manual") {
    console.log(">>> Click the Open profile settings button in the browser window <<<");
    await expect(page.getByTestId("dialog")).toBeVisible({
      timeout: testInfo.timeout,
    });
  } else {
    await page.getByTestId("trigger").focus();
    await page.keyboard.press("Enter");
  }
}

test("dialog page loads closed", async ({ page }) => {
  await page.goto(dialogUrl("accessible"));

  await expect(page.getByTestId("variant")).toHaveText("accessible");
  await expect(page.getByTestId("trigger")).toBeVisible();
  await expect(page.getByTestId("dialog")).toBeHidden();
});

test("accessible: opening the dialog is detected, keyboard managed, and axe clean", async (
  { page },
  testInfo,
) => {
  await page.goto(dialogUrl("accessible"));

  const before = await runAxe(page, testInfo, "before", dialogAxeTags);
  expect(before.map((violation) => violation.id)).toEqual([]);

  const watcher = await watchDom(page, ".scenario");
  await openDialog(page, testInfo);

  const changes = await watcher.waitFor(dialogInserted);
  console.log("[dom] detected dialog insertion:", changes);

  const dialog = page.getByRole("dialog", { name: "Profile settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.getByTestId("display-name")).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("cancel")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("display-name")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("trigger")).toBeFocused();

  const after = await runAxe(page, testInfo, "after", dialogAxeTags);
  expect(after.map((violation) => violation.id)).toEqual([]);
});

test("broken: dialog insertion is detected but name and keyboard management are missing", async (
  { page },
  testInfo,
) => {
  await page.goto(dialogUrl("broken"));

  const before = await runAxe(page, testInfo, "before", dialogAxeTags);
  expect(before.map((violation) => violation.id)).toEqual([]);

  const watcher = await watchDom(page, ".scenario");
  await openDialog(page, testInfo);

  const changes = await watcher.waitFor(dialogInserted);
  console.log("[dom] detected dialog insertion:", changes);

  const dialog = page.getByTestId("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveAttribute("aria-modal", "true");
  await expect(page.getByTestId("trigger")).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("display-name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  const after = await runAxe(page, testInfo, "after", dialogAxeTags);
  expect(after.map((violation) => violation.id)).toContain("aria-dialog-name");
});