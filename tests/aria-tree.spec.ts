// Import Playwright's test runner and assertion library.
import { test, expect } from "@playwright/test";
// Import the helpers that snapshot a tree and wait for it to change.
import { snapshotTree, waitForTreeChange } from "./helpers/aria-tree";

// A page where clicking moves focus right away but the real content arrives 600 ms later.
const delayedContentPage = `
  <button id="load">Load</button>
  <h2 id="results" tabindex="-1">Results</h2>
  <div id="out"></div>
  <script>
    // On click: move focus now, add the content after 600 ms.
    document.getElementById("load").onclick = () => {
      // Focus moves immediately, which changes [active] in the AI-mode snapshot.
      document.getElementById("results").focus();
      // The content we actually care about shows up later.
      setTimeout(() => {
        // Insert the delayed content.
        document.getElementById("out").innerHTML = "<p>Loaded 3 items</p>";
      }, 600);
    };
  </script>
`;

// Settling must not stop at the focus move; it has to wait for the delayed content.
test("content that appears 600 ms after a click is in the settled result", async ({ page }) => {
  // Load the inline test page (no network needed).
  await page.setContent(delayedContentPage);
  // Snapshot the whole page.
  const scope = page.locator("body");

  // Capture the tree before clicking.
  const before = await snapshotTree(scope);
  // Click the button: focus moves now, content comes 600 ms later.
  await page.getByRole("button", { name: "Load" }).click();
  // Wait for the tree to change and settle.
  const after = await waitForTreeChange(scope, before);

  // The delayed content must be in the settled result.
  expect(after.content).toContain("Loaded 3 items");
  // Focus is still reported, through refs, on the heading.
  expect(after.refs).toMatch(/heading "Results".*\[active\]/);
});
