// Import Playwright's test runner, assertion library, and the Locator type (for the fake scope).
import { test, expect, Locator } from "@playwright/test";
// Import the helpers that snapshot a tree and wait for it to change.
import { snapshotTree, waitForTreeChange } from "./helpers/aria-tree";
// Parse and diff real snapshots, for the iframe guard below.
import { parseSnapshot } from "./helpers/parse-snapshot";
import { diffTrees } from "./helpers/diff-trees";

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

// A page with a paragraph outside an iframe and a button inside it.
const iframePage = `
  <main>
    <p id="outside">Before</p>
    <iframe srcdoc="<button>Inside</button>"></iframe>
  </main>
`;

// #129 ignores iframe contents by never seeing them: default-mode snapshots stop at the
// iframe line, so no change inside one reaches diffTrees. If Playwright or the merge ever
// lets iframe content through, this fails, and the diff needs a real iframe flag.
test("changes inside an iframe produce no TreeChange", async ({ page }) => {
  // Load the page and wait for the iframe's button, so the frame is filled before snapshotting.
  await page.setContent(iframePage);
  const frameButton = page.frameLocator("iframe").getByRole("button");
  await frameButton.waitFor();
  const scope = page.locator("body");
  const first = parseSnapshot(await snapshotTree(scope)).tree;

  // Rename the button inside the iframe: nothing should be reported.
  await frameButton.evaluate((b) => (b.textContent = "Renamed"));
  const snap = await snapshotTree(scope);
  // AI mode does go into iframes, so this proves the rename happened.
  expect(snap.refs).toContain('button "Renamed"');
  const second = parseSnapshot(snap).tree;
  expect(diffTrees(first, second)).toEqual([]);

  // Control: a change outside the iframe is still reported, so the empty diff above
  // isn't just a broken snapshot.
  await page.locator("#outside").evaluate((p) => (p.textContent = "After"));
  const third = parseSnapshot(await snapshotTree(scope)).tree;
  expect(diffTrees(second, third)).toEqual([
    { kind: "textChanged", path: "main > paragraph", ref: expect.any(String), before: "Before", after: "After" },
  ]);
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
