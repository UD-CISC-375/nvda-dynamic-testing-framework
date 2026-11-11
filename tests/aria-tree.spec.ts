// Import Playwright's test runner, assertion library, and the Locator type (for the fake scope).
import { test, expect, Locator } from "@playwright/test";
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

// A stand-in for a Locator: only ariaSnapshot exists, and it returns whatever we script.
// A real page can't be timed to change exactly between two calls; this can.
function fakeScope(nextContent: () => string) {
  // Total ariaSnapshot calls, and how many were AI-mode (to number the refs strings).
  let calls = 0;
  let refsCalls = 0;
  const scope = {
    async ariaSnapshot(options?: { mode?: string }) {
      calls++;
      // AI mode returns "refs 1", "refs 2", ...; default mode returns the scripted content.
      return options?.mode === "ai" ? `refs ${++refsCalls}` : nextContent();
    },
  };
  // snapshotTree only calls ariaSnapshot, so the cast is safe here.
  return { scope: scope as unknown as Locator, calls: () => calls };
}

// The content changes once, between the first two reads: the retry gets a matching pair.
test("snapshotTree retries when content changes around the refs snapshot", async () => {
  // First content read is "A", every read after that is "B".
  let reads = 0;
  const { scope } = fakeScope(() => (reads++ === 0 ? "A" : "B"));
  // Attempt 1: A, refs 1, B (changed). Attempt 2: refs 2, B (same): consistent.
  expect(await snapshotTree(scope)).toEqual({ content: "B", refs: "refs 2", consistent: true });
});

// The content changes on every read: snapshotTree gives up after 3 tries and says so.
test("snapshotTree reports consistent: false when the page never stops changing", async () => {
  // Every content read returns a new value.
  let reads = 0;
  const { scope, calls } = fakeScope(() => `content ${reads++}`);
  const snap = await snapshotTree(scope);
  expect(snap.consistent).toBe(false);
  // 1 first content read + 3 tries x (refs + content) = 7 calls, so it stopped at the cap.
  expect(calls()).toBe(7);
});
