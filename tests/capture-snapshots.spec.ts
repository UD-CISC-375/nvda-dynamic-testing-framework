// Import Playwright's test runner, assertion library, and the Locator type.
import { test, expect, Locator } from "@playwright/test";
// writeFileSync and join save the captured snapshots next to the other fixtures.
import { writeFileSync } from "fs";
import { join } from "path";
// snapshotTree takes the default + AI-mode pair that parseSnapshot reads back.
import { snapshotTree } from "./helpers/aria-tree";

// Records the before/after snapshot pairs that diff-trees.spec.ts reads, so they can be
// re-recorded when Playwright or Team Y's site changes. It doesn't test anything, so it only
// runs when asked: CAPTURE=1 (PowerShell: $env:CAPTURE = "1") and run this file alone.
// Site scenarios use BASE_URL like every other spec; the rest use page.setContent.
test.skip(!process.env.CAPTURE, "set CAPTURE=1 to re-record tests/fixtures/snapshots");

// Where parse-snapshot.spec.ts and diff-trees.spec.ts read fixtures from.
const dir = join(__dirname, "fixtures", "snapshots");

// Snapshot `scope` and save it as <name>.default.yaml + <name>.ai.yaml.
async function save(name: string, scope: Locator) {
  const snap = await snapshotTree(scope);
  // A pair taken while the page was still changing would make a misleading fixture.
  expect(snap.consistent, `${name}: page changed while snapshotting`).toBe(true);
  writeFileSync(join(dir, `${name}.default.yaml`), snap.content + "\n");
  writeFileSync(join(dir, `${name}.ai.yaml`), snap.refs + "\n");
}

// Menu opens: the button expands and a menu with items appears.
test("menu", async ({ page }) => {
  await page.goto("#/disclosure/menu?variant=accessible");
  const scope = page.getByTestId("scenario-root");
  await expect(page.getByTestId("trigger")).toBeVisible();
  await save("menu-closed", scope);
  await page.getByTestId("trigger").click();
  // Wait for the menu itself, so the snapshot isn't taken halfway through opening.
  await expect(page.getByRole("menu")).toBeVisible();
  await save("menu-open", scope);
});

// Sorting by name: rows change order and the status announces the sort.
test("sortable table", async ({ page }) => {
  await page.goto("#/dynamic/sortable-table?variant=accessible");
  const scope = page.getByTestId("scenario-root");
  await expect(page.getByRole("button", { name: "Name" })).toBeVisible();
  await save("sortable-unsorted", scope);
  await page.getByRole("button", { name: "Name" }).click();
  // The status text is set last, once the rows are sorted.
  await expect(page.getByRole("status")).toHaveText("Sorted by Name, ascending");
  await save("sortable-sorted", scope);
});

// Polite status, both variants: the message arrives after a 1 s delay.
for (const variant of ["accessible", "broken"] as const) {
  test(`polite status ${variant}`, async ({ page }) => {
    await page.goto(`#/live/polite?variant=${variant}&delay=1000`);
    const scope = page.getByTestId("scenario-root");
    await expect(page.getByTestId("trigger")).toBeVisible();
    await save(`polite-${variant}-before`, scope);
    await page.getByTestId("trigger").click();
    // Wait out the delay: the fixture must hold the final message, not an in-between state.
    await expect(page.getByTestId("status")).toHaveText("Item added to cart. 1 item in cart.");
    await save(`polite-${variant}-after`, scope);
  });
}

// Two unnamed lists each gain an item with the same text; only the path tells them apart.
test("two lists", async ({ page }) => {
  await page.setContent(`
    <main>
      <ul><li>Bread</li></ul>
      <ul><li>Eggs</li></ul>
      <button onclick="document.querySelectorAll('ul').forEach((ul) => {
        const li = document.createElement('li');
        li.textContent = 'Milk';
        ul.append(li);
      })">Add milk</button>
    </main>`);
  const scope = page.locator("body");
  await save("lists-before", scope);
  await page.getByRole("button", { name: "Add milk" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Milk" })).toHaveCount(2);
  await save("lists-after", scope);
});

// A checkbox gets checked: a state change only.
test("checkbox", async ({ page }) => {
  await page.setContent(`<main><label><input type="checkbox"> Agree</label></main>`);
  const scope = page.locator("body");
  await save("checkbox-before", scope);
  await page.getByRole("checkbox", { name: "Agree" }).check();
  await save("checkbox-after", scope);
});

// A paragraph is swapped for an identical clone: same content, new element, so a new ref (#128).
test("clone", async ({ page }) => {
  await page.setContent(`
    <main>
      <p>Saved</p>
      <button onclick="const p = document.querySelector('p'); p.replaceWith(p.cloneNode(true))">
        Re-render
      </button>
    </main>`);
  const scope = page.locator("body");
  // Hold on to the original element, to check below that it really was swapped out.
  const original = await page.locator("p").elementHandle();
  await save("clone-before", scope);
  await page.getByRole("button", { name: "Re-render" }).click();
  // The old <p> is detached and a new one stands in its place with the same text.
  expect(await original!.evaluate((el) => el.isConnected)).toBe(false);
  await expect(page.locator("p")).toHaveText("Saved");
  await save("clone-after", scope);
});

// Focus moves from the page to one button, then to the other; nothing else changes.
test("focus", async ({ page }) => {
  await page.setContent(`<main><button>One</button><button>Two</button></main>`);
  const scope = page.locator("body");
  // Nothing focused yet: <body> has focus, and it's the scope itself, so no line is [active].
  await save("focus-body", scope);
  await page.getByRole("button", { name: "One" }).focus();
  await expect(page.getByRole("button", { name: "One" })).toBeFocused();
  await save("focus-one", scope);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Two" })).toBeFocused();
  await save("focus-two", scope);
});
