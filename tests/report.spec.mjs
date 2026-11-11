import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/generate-report.mjs");
const input = join(root, "examples/results.json");

test("generated report works offline and is keyboard accessible", async ({
  page,
}) => {
  const outputDir = mkdtempSync(join(tmpdir(), "nvda-report-"));
  const output = join(outputDir, "report.html");
  const externalRequests = [];
  // A file:// load should not fetch scripts, stylesheets, fonts, or other remote resources.
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) externalRequests.push(request.url());
  });

  try {
    execFileSync(process.execPath, [script, input, output], { cwd: root });
    await page.goto(pathToFileURL(output).href);

    await expect(
      page.getByText(
        "No new axe violations after this action: Clicked button 'Actions'; No axe violations remain at the end.",
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "No new axe violations after this action: Clicked button with no accessible name; 1 axe violation remains at the end.",
      ),
    ).toBeVisible();
    await expect(page.locator(".verdict")).toHaveCount(2);
    await expect(page.locator(".trigger").nth(1)).toContainText(
      "Clicked button 'Actions'",
    );
    await expect(
      page.locator(".timeline").getByText("Added: menu 'Actions' with 4 items"),
    ).toHaveCount(1);
    await expect(page.locator(".timeline").getByText("Added: list with 4 items")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Read the axe rule documentation" }),
    ).toHaveAttribute(
      "href",
      "https://dequeuniversity.com/rules/axe/4.13/button-name",
    );
    await expect(
      page.locator(".finding").getByText("Buttons must have discernible text"),
    ).toBeVisible();
    await expect(
      page
        .locator(".finding")
        .getByText("Element does not have an accessible name"),
    ).toBeVisible();
    await expect(
      page.locator(".finding").getByText(
        '<button data-testid="trigger" class="menu-button"><svg aria-hidden="true"><!-- icon --></svg></button>',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByText("Axe cannot detect this flaw")).toHaveCount(2);

    const rawJson = page.locator("details");
    await expect(rawJson).not.toHaveAttribute("open", "");
    // Reach both the documentation link and the disclosure using only Tab.
    let foundLink = false;
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      if (await page.getByRole("link", { name: "Read the axe rule documentation" }).evaluate((element) => element === document.activeElement)) {
        foundLink = true;
      }
      if (await rawJson.locator("summary").evaluate((element) => element === document.activeElement)) break;
    }
    expect(foundLink).toBe(true);
    await expect(rawJson.locator("summary")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(rawJson).toHaveAttribute("open", "");
    await expect(
      page.getByText('"schemaVersion": 0', { exact: false }),
    ).toBeVisible();

    // Scan the report itself, not just the accessibility findings embedded in it.
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("reports new and resolved findings and unrecorded scenarios", async ({ page }) => {
  const outputDir = mkdtempSync(join(tmpdir(), "nvda-report-findings-"));
  const source = join(outputDir, "results.json");
  const output = join(outputDir, "report.html");
  try {
    const data = JSON.parse(readFileSync(input, "utf8"));
    const broken = data.run.scenarios[1];
    const finding = broken.states[0].axe.new[0];
    broken.states[1].axe.new = [{ ...finding, rule: "new-rule", help: "New finding" }];
    broken.states[1].axe.resolved = [finding];
    data.run.scenarios.push({
      scenario: "unrecorded",
      variant: "broken",
      verdict: "skipped",
      skippedReason: "The test did not record its states.",
      states: [],
    });

    writeFileSync(source, JSON.stringify(data));
    execFileSync(process.execPath, [script, source, output], { cwd: root });
    await page.goto(pathToFileURL(output).href);

    const state = page.locator(".scenario").nth(1).locator(".state").nth(1);
    const groups = state.locator(".finding-group");
    await expect(groups.nth(0).getByText("New finding")).toBeVisible();
    await expect(groups.nth(1).getByText("Buttons must have discernible text")).toBeVisible();
    for (const group of [groups.nth(0), groups.nth(1)]) {
      await expect(group.getByRole("link", { name: "Read the axe rule documentation" })).toHaveAttribute("href", finding.helpUrl);
      await expect(group.getByText(finding.failureSummary, { exact: true })).toBeVisible();
      await expect(group.getByText(finding.html, { exact: true })).toBeVisible();
    }
    await expect(page.getByText("Skipped: The test did not record its states.")).toBeVisible();
    await expect(page.getByText("No states were recorded for this scenario.")).toBeVisible();
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("rejects findings without the required details", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "nvda-report-invalid-"));
  const source = join(outputDir, "results.json");
  try {
    const data = JSON.parse(readFileSync(input, "utf8"));
    data.run.scenarios[1].states[0].axe.new[0].html = " ";
    writeFileSync(source, JSON.stringify(data));
    const result = spawnSync(process.execPath, [script, source, join(outputDir, "report.html")], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("axe finding missing");
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
